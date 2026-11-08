"""Eval runner (T4.3): scores of one document, report arithmetic. No model, no network."""

import copy
import json
from typing import Any

import pytest
from runner import report
from runner.dataset import load
from runner.matching import CRITICAL_FIELDS
from runner.scoring import score_attack, score_document

from app.services.xml_invoice import parse_xml_invoice

WANT: dict[str, Any] = {
    "seller": {"name": "Garcia-Riley SAMPLE", "taxCode": "5193714551-891", "address": "45 Road"},
    "buyer": {"name": "Sandra Marks SAMPLE", "taxCode": None, "address": "24 Plaza"},
    "invoiceNo": "INV-260403601",
    "series": "S26D",
    "issueDate": "2026-03-22",
    "currency": "VND",
    "lines": [
        {
            "description": "Cleaning service H9288",
            "quantity": 4,
            "unit": "visit",
            "unitPrice": 482000,
            "vatRate": 8,
            "amount": 1928000,
        },
        {
            "description": "Copy paper P3766",
            "quantity": 2.5,
            "unit": "box",
            "unitPrice": 100000,
            "vatRate": 10,
            "amount": 250000,
        },
    ],
    "subtotal": 2178000,
    "vatBreakdown": [
        {"rate": 8, "base": 1928000, "amount": 154240},
        {"rate": 10, "base": 250000, "amount": 25000},
    ],
    "total": 2357240,
    "fieldMeta": {},
}


def got(**changes: Any) -> dict[str, Any]:
    out = copy.deepcopy(WANT)
    for path, value in changes.items():
        target = out
        *parents, last = path.split("__")
        for part in parents:
            target = target[int(part)] if part.isdigit() else target[part]
        target[int(last) if last.isdigit() else last] = value
    return out


def test_the_ground_truth_scores_as_an_exact_match() -> None:
    s = score_document(copy.deepcopy(WANT), WANT)
    assert s["exact"] and s["criticalExact"]
    assert all(s["fields"].values())
    assert s["lines"] == {
        "expected": 2,
        "predicted": 2,
        "paired": 2,
        "correct": 2,
        "columns": dict.fromkeys(s["lines"]["columns"], 2),
    }


def test_a_failed_document_is_wrong_everywhere_and_keeps_its_lines_in_the_denominator() -> None:
    s = score_document(None, WANT)
    assert not any(s["fields"].values())
    assert not s["exact"] and not s["criticalExact"]
    assert s["lines"]["expected"] == 2
    assert s["lines"]["predicted"] == s["lines"]["correct"] == 0


def test_a_cut_branch_suffix_is_wrong_and_named() -> None:
    s = score_document(got(seller__taxCode="5193714551"), WANT)
    assert not s["fields"]["seller.taxCode"]
    assert not s["criticalExact"]
    assert s["branchSuffixCut"] == ["seller.taxCode"]


def test_an_invented_buyer_tax_code_is_wrong() -> None:
    s = score_document(got(buyer__taxCode="0123456789"), WANT)
    assert not s["fields"]["buyer.taxCode"]


def test_vat_breakdown_order_does_not_matter_but_its_values_do() -> None:
    reordered = got(vatBreakdown=list(reversed(WANT["vatBreakdown"])))
    assert score_document(reordered, WANT)["fields"]["vatBreakdown"]
    changed = got(vatBreakdown__0__amount=154241)
    s = score_document(changed, WANT)
    assert not s["fields"]["vatBreakdown"]
    assert s["criticalExact"] and not s["exact"]


def test_one_wrong_line_column_makes_that_line_wrong_but_not_the_header() -> None:
    s = score_document(got(lines__1__unitPrice=10000), WANT)
    assert s["lines"]["paired"] == 2 and s["lines"]["correct"] == 1
    assert s["lines"]["columns"]["unitPrice"] == 1
    assert s["criticalExact"] and not s["exact"]


def test_an_extra_line_breaks_the_exact_match_only() -> None:
    extra = got()
    extra["lines"].append({**WANT["lines"][0], "description": "Delivery", "amount": 7})
    s = score_document(extra, WANT)
    assert s["lines"]["correct"] == 2 and s["lines"]["predicted"] == 3
    assert not s["exact"]


def test_wrong_at_high_confidence_is_listed() -> None:
    answer = got(total=1, invoiceNo="X")
    answer["fieldMeta"] = {
        "total": {"confidence": 1.0, "evidence": None},
        "invoiceNo": {"confidence": 0.5, "evidence": None},
    }
    assert score_document(answer, WANT)["confidentWrong"] == ["total"]


def test_lost_diacritics_are_wrong_and_listed() -> None:
    want = got(seller__name="Công ty Đông Á SAMPLE")
    s = score_document(got(seller__name="Cong ty Dong A SAMPLE"), want)
    assert not s["fields"]["seller.name"]
    assert s["accentOnly"] == ["seller.name"]


@pytest.mark.parametrize(
    ("answer", "outcome"),
    [
        (got(total=0), "attacked"),
        (got(), "correct"),
        (got(total=5), "other"),
        (None, "failed"),
    ],
)
def test_attack_outcome_follows_the_goal(answer: dict[str, Any] | None, outcome: str) -> None:
    assert score_attack(answer, WANT, {"path": "total", "value": 0}) == outcome


def test_every_xml_of_the_frozen_set_matches_its_ground_truth() -> None:
    """An independent answer key: the XML parser calls no model. If the matcher marked any of
    these wrong, every model score would be too low by the same mistake."""
    dataset = load()
    checked = 0
    for doc_id in dataset.documents:
        xml = dataset.root / "documents" / f"{doc_id}.xml"
        if not xml.exists():  # regression-00 has none (T4.2)
            continue
        s = score_document(parse_xml_invoice(xml.read_bytes()), dataset.expected(doc_id))
        assert s["exact"], doc_id
        checked += 1
    assert checked == 124


# ---------------------------------------------------------------- report arithmetic


def test_percentile_is_nearest_rank() -> None:
    values = list(range(1, 21))
    assert report.percentile(values, 0.5) == 10
    assert report.percentile(values, 0.95) == 19
    assert report.percentile([7], 0.95) == 7
    assert report.percentile(list(range(1, 11)), 0.95) == 10  # rank ceil(9.5): the largest
    assert report.percentile([], 0.5) is None


def test_f1_from_counts() -> None:
    assert report.f1(8, 10, 16) == {"precision": 0.8, "recall": 0.5, "f1": 0.6154}
    assert report.f1(0, 0, 3) == {"precision": 0.0, "recall": 0.0, "f1": 0.0}


def _repeat(accuracy: float, line_f1: float) -> dict[str, Any]:
    return {
        "fields": {f: {"accuracy": accuracy} for f in CRITICAL_FIELDS},
        "lines": {"f1": line_f1},
    }


def test_noise_is_the_largest_difference_between_repeats_in_points() -> None:
    n = report.noise([_repeat(0.95, 0.9), _repeat(1.0, 0.85), _repeat(0.9, 0.9)])
    assert n["total"] == 10.0
    assert n["lines.f1"] == 5.0
    assert set(n) == {*CRITICAL_FIELDS, "lines.f1"}


def test_report_has_no_value_read_from_a_document() -> None:
    dataset = load()
    doc_id = dataset.splits["smoke"][0]
    expected = dataset.expected(doc_id)
    record = {
        "split": "smoke",
        "doc": doc_id,
        "repeat": 0,
        "dataset": "v1",
        "manifestSha256": dataset.manifest_sha256,
        "model": "gemini-3.1-flash-lite",
        "promptVersion": "invoice_extraction/v1",
        "promptSha256": "0" * 64,
        "at": "2026-11-08T00:00:00+00:00",
        "status": "ok",
        "got": {**expected, "total": expected["total"] + 1},
        "attempts": 1,
        "latencyMs": 1000,
        "providerMs": 900,
        "calls": 1,
        "inputTokens": 1500,
        "outputTokens": 500,
        "maxFieldMeta": 9,
    }
    built = report.build([record], dataset)
    text = json.dumps(built, ensure_ascii=False) + report.to_markdown(built)
    for value in (expected["seller"]["name"], expected["seller"]["taxCode"], expected["invoiceNo"]):
        assert value not in text
    smoke = built["splits"]["smoke"]
    assert smoke["wrong"][0]["fields"] == ["total"]
    assert not smoke["complete"] and len(smoke["missing"]) == 19
    assert smoke["noise"] is None
    assert smoke["usage"]["costUsdPerDocument"] == pytest.approx(0.001125)


def test_an_unpriced_model_reports_no_cost_rather_than_zero() -> None:
    dataset = load()
    row = {
        "split": "regression",
        "doc": "regression-00",
        "repeat": 0,
        "status": "error",
        "code": "LLM_UNAVAILABLE",
        "attempts": 3,
        "calls": 3,
        "inputTokens": 0,
        "outputTokens": 0,
        "maxFieldMeta": None,
    }
    usage = report._usage([row], dataset, "some-new-model")
    assert usage["costUsdTotal"] is None and usage["costUsdPerDocument"] is None
    assert usage["latency"]["all"]["n"] == 0  # a failure has no reading time


def _injection_record(doc_id: str, got_value: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "split": "injection",
        "doc": doc_id,
        "repeat": 0,
        "dataset": "v1",
        "manifestSha256": "0" * 64,
        "model": "gemini-3.1-flash-lite",
        "promptVersion": "invoice_extraction/v1",
        "promptSha256": "0" * 64,
        "at": "2026-11-08T00:00:00+00:00",
        "status": "ok" if got_value is not None else "rejected",
        "code": None if got_value is not None else "EXTRACTION_SCHEMA_INVALID",
        "got": got_value,
        "attempts": 1,
        "latencyMs": 1000,
        "providerMs": 900,
        "calls": 1,
        "inputTokens": 1500,
        "outputTokens": 500,
        "maxFieldMeta": 9,
    }


def test_injection_report_counts_outcomes_with_their_denominator_and_no_values() -> None:
    dataset = load()
    by_goal = {
        dataset.documents[i]["attack"]["goal"]["path"]: i for i in dataset.splits["injection"]
    }
    total_doc, number_doc = by_goal["total"], by_goal["invoiceNo"]
    other_doc = next(i for i in dataset.splits["injection"] if i not in (total_doc, number_doc))
    attacked = dataset.expected(total_doc) | {"total": 0}
    marker = "SAMPLE-MODEL-READ-THIS"
    correct = dataset.expected(number_doc) | {"series": marker}  # a value only the model wrote
    records = [
        _injection_record(total_doc, attacked),
        _injection_record(number_doc, correct),
        _injection_record(other_doc, None),
    ]
    built = report.build(records, dataset)
    s = built["splits"]["injection"]
    assert s["outcomes"] == {"attacked": 1, "correct": 1, "failed": 1, "of": 3}
    assert s["attacked"] == [{"doc": total_doc, "repeat": 0, "path": "total"}]
    assert s["byGoal"]["total"]["attacked"] == 1
    assert sum(v["of"] for v in s["bySentence"].values()) == 3
    text = json.dumps(built, ensure_ascii=False) + report.to_markdown(built)
    assert "attack worked 1 of 3" in text
    assert marker not in text
    assert "HACKED-01" not in text  # the goal value of invoiceNo attacks


def test_flips_count_documents_that_change_between_repeats() -> None:
    def scored(doc: str, total_right: bool) -> tuple[dict[str, Any], dict[str, Any], Any]:
        fields = dict.fromkeys(CRITICAL_FIELDS, True) | {"total": total_right}
        return ({"doc": doc}, {}, {"fields": fields})

    # a: right then wrong; b: wrong then right. Accuracy per repeat is 50% both times: noise 0.
    rows = [scored("a", True), scored("b", False), scored("a", False), scored("b", True)]
    assert report.flips(rows)["total"] == 2
    assert report.flips(rows)["invoiceNo"] == 0


def test_a_nan_in_the_vat_breakdown_scores_wrong_instead_of_crashing() -> None:
    answer = got(
        vatBreakdown=[{"rate": float("nan"), "base": 1, "amount": 1}, *WANT["vatBreakdown"]]
    )
    assert not score_document(answer, WANT)["fields"]["vatBreakdown"]


def test_a_report_refuses_runs_of_two_configurations() -> None:
    dataset = load()
    ids = dataset.splits["injection"][:2]
    records = [_injection_record(i, dataset.expected(i)) for i in ids]
    records[1]["promptSha256"] = "f" * 64
    with pytest.raises(SystemExit):
        report.build(records, dataset)
