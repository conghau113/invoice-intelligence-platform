"""T4.4: error classes, the text-layer check, the example pictures and the comparison report.

Real code on real dataset files; no model, no network.
"""

import copy
import json
import zlib
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from runner import compare, report
from runner.compare import Config, choose_primary, date_needles, floors, paired, pick_examples
from runner.dataset import load
from runner.errors import _second_pass, classify
from runner.figures import render_band
from runner.matching import PAIR_THRESHOLD, line_similarity
from runner.names import slug
from runner.textlayer import Printed, format_amount, parse_amount, pdf_of, read_printed

REAL = load()
DOCS = REAL.root / "documents"
BRANCH = "invoice-0003"  # en, VND, seller tax code with a branch suffix, individual buyer


def printed_of(doc_id: str) -> Printed:
    doc = REAL.documents[doc_id]
    return read_printed(pdf_of(DOCS, doc), doc["locale"], doc["currency"])


def answer(doc_id: str) -> dict[str, Any]:
    """A perfect answer: the ground truth itself."""
    return copy.deepcopy(REAL.expected(doc_id))


def classes(got: dict[str, Any] | None, doc_id: str = BRANCH) -> list[tuple[str, str, Any]]:
    return [
        (e["where"], e["class"], e["kind"])
        for e in classify(got, REAL.expected(doc_id), printed_of(doc_id))
    ]


# ---------------------------------------------------------------- text layer


def test_amounts_are_read_in_minor_units_per_locale() -> None:
    assert parse_amount("24.973,09", "vi", "USD") == 2497309
    assert parse_amount("12,996,000", "en", "VND") == 12996000
    assert parse_amount("729.000", "vi", "VND") == 729000
    assert parse_amount("1.23.4", "vi", "VND") is None  # not a grouping
    assert parse_amount("16,5", "vi", "VND") is None  # a quantity, not a VND amount
    assert format_amount(2497309, "vi", "USD") == "24.973,09"
    assert format_amount(12996000, "en", "VND") == "12,996,000"


def test_the_text_layer_check_is_by_whole_token_not_substring() -> None:
    printed = printed_of(BRANCH)
    full = REAL.expected(BRANCH)["seller"]["taxCode"]
    assert "-" in full
    assert printed.has_text(full)
    # The cut code is a substring of the printed one: a substring check would call it printed.
    assert not printed.has_text(full.split("-")[0])
    assert printed.has_amount(REAL.expected(BRANCH)["total"])
    assert not printed.has_amount(REAL.expected(BRANCH)["total"] + 1)


def test_a_picture_variant_is_checked_against_the_pdf_of_the_same_invoice() -> None:
    picture = next(
        i for i in REAL.splits["core"] if not REAL.documents[i]["primary"].endswith(".pdf")
    )
    path = pdf_of(DOCS, REAL.documents[picture])
    assert path.name == f"{picture}.pdf"
    assert printed_of(picture).has_text(REAL.expected(picture)["invoiceNo"])


# ---------------------------------------------------------------- error classes


def test_a_perfect_answer_has_no_error() -> None:
    assert classes(answer(BRANCH)) == []


def test_no_answer_is_one_failure_not_a_list_of_misreads() -> None:
    assert classes(None) == [("document", "failed", None)]


def test_a_cut_branch_suffix_is_a_truncated_misread() -> None:
    got = answer(BRANCH)
    got["seller"]["taxCode"] = got["seller"]["taxCode"].split("-")[0]
    assert classes(got) == [("seller.taxCode", "misread", "truncated")]


def test_a_value_left_out_is_missing() -> None:
    got = answer(BRANCH)
    got["invoiceNo"] = None
    assert classes(got) == [("invoiceNo", "missing", None)]


def test_the_seller_code_given_as_the_buyer_code_is_a_wrong_field() -> None:
    got = answer(BRANCH)
    assert REAL.expected(BRANCH)["buyer"]["taxCode"] is None
    got["buyer"]["taxCode"] = got["seller"]["taxCode"]
    assert classes(got) == [("buyer.taxCode", "wrong_field", "other_field")]


def test_a_code_invented_for_an_empty_field_is_a_hallucination() -> None:
    got = answer(BRANCH)
    got["buyer"]["taxCode"] = "0109998887"
    assert classes(got) == [("buyer.taxCode", "hallucination", "value_for_absent")]


def test_an_amount_with_a_swapped_digit_is_a_digits_misread() -> None:
    got = answer(BRANCH)
    digits = str(got["total"])
    got["total"] = int(digits[0] + digits[2] + digits[1] + digits[3:])
    assert got["total"] != REAL.expected(BRANCH)["total"]
    assert classes(got) == [("total", "misread", "digits")]


def test_a_number_printed_nowhere_and_far_from_the_truth_is_a_hallucination() -> None:
    got = answer(BRANCH)
    got["series"] = "ZZQ9"
    assert classes(got) == [("series", "hallucination", "not_printed")]


def test_lost_diacritics_are_told_apart() -> None:
    doc_id = "invoice-0000"  # vi
    got = answer(doc_id)
    got["buyer"]["name"] = "Bui va Le Tap Doan SAMPLE"
    assert classes(got, doc_id) == [("buyer.name", "misread", "diacritics")]


def test_a_dropped_line_is_a_missing_line() -> None:
    got = answer(BRANCH)
    del got["lines"][1]
    assert classes(got) == [("lines[1]", "missing_line", None)]


def test_an_invented_line_is_a_hallucination_and_a_printed_one_is_not() -> None:
    got = answer(BRANCH)
    got["lines"].append({**got["lines"][0], "description": "Gold bars Q0000"})
    assert classes(got) == [(f"extra[{len(got['lines']) - 1}]", "hallucination", "extra_line")]


def test_a_line_with_most_columns_wrong_is_a_misread_not_missing_plus_extra() -> None:
    """Below the scorer's pairing threshold (T4.3 Phát sinh), the same description pairs it."""
    got = answer(BRANCH)
    line = got["lines"][0]
    line.update(
        description=line["description"][:-1] + "9",  # one character off
        quantity=line["quantity"] + 1,
        unit="zz",
        unitPrice=line["unitPrice"] + 7,
        amount=1,
        vatRate=5,
    )
    assert line_similarity(line, REAL.expected(BRANCH)["lines"][0]) < PAIR_THRESHOLD
    found = classes(got)
    assert not [c for c in found if c[1] in ("missing_line",) or c[0].startswith("extra")]
    assert {c[0] for c in found} == {
        "lines[0].description",
        "lines[0].quantity",
        "lines[0].unit",
        "lines[0].unitPrice",
        "lines[0].amount",
        "lines[0].vatRate",
    }


def test_a_line_amount_given_as_its_unit_price_is_a_wrong_field() -> None:
    got = answer(BRANCH)
    line = next(ln for ln in got["lines"] if ln["quantity"] != 1)
    index = got["lines"].index(line)
    line["amount"] = line["unitPrice"]
    assert classes(got) == [(f"lines[{index}].amount", "wrong_field", "other_field")]


def test_rows_read_out_of_step_are_wrong_field_other_line_not_hallucination() -> None:
    """Gemini 3.5 Flash Lite on a noisy photo (T4.4): each line got the quantity and unit price of
    the line above. Quantities are plain numbers, not minor units."""
    got = answer(BRANCH)
    lines = got["lines"]
    assert len(lines) >= 3
    for i in range(len(lines) - 1, 0, -1):
        lines[i]["quantity"] = lines[i - 1]["quantity"]
    found = [c for c in classes(got) if c[0].endswith(".quantity")]
    want = REAL.expected(BRANCH)["lines"]
    shifted = [i for i in range(1, len(want)) if want[i]["quantity"] != want[i - 1]["quantity"]]
    assert found == [(f"lines[{i}].quantity", "wrong_field", "other_line") for i in shifted]


def test_a_quantity_read_from_another_printed_number_is_not_called_invented() -> None:
    """USD: the row number 3 is printed as "3"; as money it would be 0,03, printed nowhere."""
    doc_id = "invoice-0000"
    got = answer(doc_id)
    numbers = {v for ln in got["lines"] for v in (ln["quantity"], ln["vatRate"])}
    assert 3 not in numbers
    got["lines"][0]["quantity"] = 3
    assert classes(got, doc_id) == [("lines[0].quantity", "wrong_field", "printed_elsewhere")]


def test_an_empty_string_for_an_empty_field_is_not_a_missing_value() -> None:
    got = answer(BRANCH)
    assert REAL.expected(BRANCH)["buyer"]["taxCode"] is None
    got["buyer"]["taxCode"] = ""
    assert classes(got) == [("buyer.taxCode", "hallucination", "value_for_absent")]


def test_a_vat_breakdown_missing_wrong_or_invented() -> None:
    want = REAL.expected(BRANCH)
    printed = printed_of(BRANCH)
    got = answer(BRANCH)
    got["vatBreakdown"] = []
    assert ("vatBreakdown", "missing", None) in [
        (e["where"], e["class"], e["kind"]) for e in classify(got, want, printed)
    ]
    got = answer(BRANCH)
    got["vatBreakdown"][0]["amount"] += 1
    assert [(e["where"], e["class"]) for e in classify(got, want, printed)] == [
        ("vatBreakdown", "misread")
    ]
    no_breakdown = {**copy.deepcopy(want), "vatBreakdown": []}
    got = answer(BRANCH)
    assert [(e["where"], e["class"], e["kind"]) for e in classify(got, no_breakdown, printed)] == [
        ("vatBreakdown", "hallucination", "value_for_absent")
    ]


def test_lines_without_a_description_are_not_paired_by_description() -> None:
    blank = [{"description": ""}, {"description": None}]
    assert _second_pass(blank, blank, {0, 1}, {0, 1}) == []


def test_an_unknown_currency_is_a_clear_error_not_a_key_error() -> None:
    with pytest.raises(ValueError, match="unknown currency"):
        parse_amount("1.000", "vi", "EUR")
    with pytest.raises(ValueError, match="unknown currency"):
        format_amount(100, "vi", "EUR")


def test_a_quantity_is_found_on_the_page_as_written_not_in_minor_units() -> None:
    doc_id = "invoice-0000"  # USD: an amount 41265 is printed 412,65; a quantity 9 is printed 9
    printed = printed_of(doc_id)
    line = REAL.expected(doc_id)["lines"][0]
    assert printed.has_amount(line["amount"])
    assert printed.has_number(Decimal(str(line["quantity"])))
    assert not printed.has_amount(line["quantity"])


def test_a_date_is_found_on_the_page_in_each_layout() -> None:
    for layout in ("vn-classic", "vn-modern", "vn-compact", "en-standard", "en-ledger"):
        doc_id = next(i for i in REAL.splits["core"] if REAL.documents[i]["layout"] == layout)
        pdf = pdf_of(DOCS, REAL.documents[doc_id])
        assert render_band(pdf, date_needles(REAL.expected(doc_id)["issueDate"])) is not None, (
            layout
        )


# ---------------------------------------------------------------- figures


def _png_pixels(png: bytes) -> tuple[int, int, bytes]:
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    width = int.from_bytes(png[16:20], "big")
    height = int.from_bytes(png[20:24], "big")
    data, pos = b"", 8
    while pos < len(png):
        length = int.from_bytes(png[pos : pos + 4], "big")
        if png[pos + 4 : pos + 8] == b"IDAT":
            data += png[pos + 8 : pos + 8 + length]
        pos += length + 12
    return width, height, zlib.decompress(data)


def test_the_picture_is_a_band_of_the_page_with_a_red_box_on_the_value() -> None:
    doc = REAL.documents[BRANCH]
    png = render_band(pdf_of(DOCS, doc), [REAL.expected(BRANCH)["seller"]["taxCode"]])
    assert png is not None
    width, height, raw = _png_pixels(png)
    assert height < width  # a band, not the whole page
    stride = width * 3 + 1  # filter byte per row
    red = sum(
        raw[y * stride + 1 + x * 3 : y * stride + 4 + x * 3] == bytes(compare_red())
        for y in range(height)
        for x in range(width)
    )
    assert red > 100


def compare_red() -> tuple[int, int, int]:
    from runner.figures import RED

    return RED


def test_no_picture_when_the_value_is_printed_nowhere() -> None:
    assert render_band(pdf_of(DOCS, REAL.documents[BRANCH]), ["Gold bars Q0000"]) is None


# ---------------------------------------------------------------- comparison


def summary(key: str, critical_right: int, cost: float | None, attacked: int = 0) -> dict[str, Any]:
    return {
        "key": key,
        "role": "candidate",
        "model": key,
        "core": {
            "complete": True,
            "criticalExact": {"correct": critical_right, "total": 100},
            "costUsdPerDocument": cost,
        },
        "injection": {"correct": 24 - attacked, "attacked": attacked, "of": 24},
    }


def test_the_primary_is_the_most_right_unless_within_two_documents_then_the_cheapest() -> None:
    assert choose_primary([summary("A", 80, 0.003), summary("B", 90, 0.004)])["key"] == "B"
    assert choose_primary([summary("A", 88, 0.003), summary("B", 90, 0.004)])["key"] == "A"
    assert choose_primary([summary("A", 87, 0.003), summary("B", 90, 0.004)])["key"] == "B"


def test_a_successful_attack_or_an_incomplete_run_rules_a_candidate_out() -> None:
    attacked = summary("B", 95, 0.001, attacked=1)
    assert choose_primary([summary("A", 80, 0.003), attacked])["key"] == "A"
    incomplete = summary("B", 95, 0.001)
    incomplete["core"]["complete"] = False
    assert choose_primary([summary("A", 80, 0.003), incomplete])["key"] == "A"
    fallback = {**summary("C", 99, 0.0001), "role": "fallback"}
    assert choose_primary([summary("A", 80, 0.003), fallback])["key"] == "A"


def test_floors_follow_adr_0020() -> None:
    critical = {f: {"accuracy": 0.97} for f in report.CRITICAL_FIELDS}
    noise = dict.fromkeys([*report.CRITICAL_FIELDS, report.LINE_F1], 0.0)
    noise["total"] = 5.0
    got = floors({"smokeNoise": noise, "core": {"critical": critical, "lines": {"f1": 0.995}}})
    assert got is not None
    assert got["invoiceNo"] == 96  # 97 - max(0, 1)
    assert got["total"] == 92  # 97 - max(5, 1)
    assert got[report.LINE_F1] == 98  # floor(99.5 - 1)
    assert floors({"smokeNoise": None, "core": {"critical": critical}}) is None


@pytest.mark.parametrize(("share", "want"), [(0.29, 28), (0.57, 56), (0.58, 57), (0.99, 98)])
def test_a_floor_is_not_lowered_by_binary_floating_point(share: float, want: int) -> None:
    """0.58 * 100 is 57.99999999999999: a bare floor would give 56 instead of 57 (review)."""
    critical = {f: {"accuracy": share} for f in report.CRITICAL_FIELDS}
    noise = dict.fromkeys([*report.CRITICAL_FIELDS, report.LINE_F1], 0.0)
    got = floors({"smokeNoise": noise, "core": {"critical": critical, "lines": {"f1": share}}})
    assert got is not None
    assert got["total"] == want
    assert got[report.LINE_F1] == want


def test_paired_counts_the_documents_that_differ() -> None:
    right = {"criticalExact": True, "fields": dict.fromkeys(report.CRITICAL_FIELDS, True)}
    wrong = {"criticalExact": False, "fields": {**right["fields"], "total": False}}
    got = paired({"d1": right, "d2": wrong, "d3": right}, {"d1": wrong, "d2": wrong, "d3": right})
    assert got["criticalExact"] == {"onlyFirst": 1, "onlySecond": 0}
    assert got["total"] == {"onlyFirst": 1, "onlySecond": 0}
    assert got["invoiceNo"] == {"onlyFirst": 0, "onlySecond": 0}


def test_examples_cover_different_classes_and_documents() -> None:
    errors = [
        {
            "config": "A",
            "doc": "d1",
            "where": "seller.taxCode",
            "class": "misread",
            "kind": "truncated",
        },
        {"config": "A", "doc": "d1", "where": "total", "class": "misread", "kind": "digits"},
        {
            "config": "B",
            "doc": "d1",
            "where": "seller.taxCode",
            "class": "misread",
            "kind": "truncated",
        },
        {"config": "A", "doc": "d2", "where": "buyer.taxCode", "class": "missing", "kind": None},
        {"config": "A", "doc": "d3", "where": "lines[2]", "class": "missing_line", "kind": None},
        {
            "config": "B",
            "doc": "d4",
            "where": "series",
            "class": "hallucination",
            "kind": "not_printed",
        },
        {"config": "B", "doc": "d5", "where": "total", "class": "misread", "kind": "digits"},
    ]
    errors.append(
        {
            "config": "B",
            "doc": "d6",
            "where": "lines[1].quantity",
            "class": "wrong_field",
            "kind": "other_line",
        }
    )
    errors.append(
        {
            "config": "B",
            "doc": "d7",
            "where": "total",
            "class": "wrong_field",
            "kind": "other_field",
        }
    )
    picked = pick_examples(errors)
    assert [e["kind"] for e in picked if e["class"] == "wrong_field"] == ["other_line"]
    assert len(picked) == 5
    assert len({e["doc"] for e in picked}) == 5
    # One per class in slot order; the second wrong_field (d7) has no slot left.
    assert [e["class"] for e in picked] == [
        "misread",
        "missing",
        "wrong_field",
        "hallucination",
        "missing_line",
    ]


def test_the_comparison_runs_end_to_end_and_its_json_holds_no_value(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two configurations recorded on two core documents, one answer with a cut tax code."""
    docs = [BRANCH, "invoice-0000"]
    configs = (
        Config("A", "test", "model-a", "candidate"),
        Config("B", "test", "model-b", "candidate"),
    )
    monkeypatch.setattr(compare, "RUNS_DIR", tmp_path)
    base = {
        "dataset": REAL.name,
        "manifestSha256": REAL.manifest_sha256,
        "promptVersion": "invoice_extraction/v1",
        "promptSha256": "x",
        "at": "2026-11-08T00:00:00+00:00",
        "attempts": 1,
        "latencyMs": 1000,
        "providerMs": 900,
        "pacingMs": 0,
        "calls": 1,
        "inputTokens": 1000,
        "outputTokens": 500,
        "maxFieldMeta": 3,
    }
    for config in configs:
        lines = []
        for doc_id in docs:
            got = answer(doc_id)
            if config.key == "B" and doc_id == BRANCH:
                got["seller"]["taxCode"] = got["seller"]["taxCode"].split("-")[0]
            lines.append(
                {
                    **base,
                    "model": config.model,
                    "split": "core",
                    "doc": doc_id,
                    "repeat": 0,
                    "status": "ok",
                    "got": got,
                }
            )
        path = tmp_path / f"{slug(REAL.name, config.model)}.jsonl"
        path.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    monkeypatch.setattr(
        compare, "runs_path", lambda d, c: tmp_path / f"{slug(d.name, c.model)}.jsonl"
    )
    built = compare.build(REAL, configs)
    assert built["paired"]["A-B"]["criticalExact"] == {"onlyFirst": 1, "onlySecond": 0}
    assert built["errors"]["B"]["byKind"] == {"misread:truncated": 1}
    assert built["textLayerCheck"]["B"]["wrong_not_printed"] == 1
    assert built["examples"][0]["where"] == "seller.taxCode"
    figures = compare.write_figures(REAL, built, tmp_path / "fig")
    assert figures[0] is not None and (tmp_path / "fig" / figures[0]).is_file()
    monkeypatch.setattr(compare, "build", lambda _dataset: built)
    reports = tmp_path / "reports"
    reports.mkdir()
    compare.write(REAL, reports)
    public = (reports / "compare-v1.json").read_text(encoding="utf-8")
    assert json.loads(public)["primary"] is not None
    expected = REAL.expected(BRANCH)
    for value in (expected["seller"]["taxCode"], expected["seller"]["name"], expected["invoiceNo"]):
        assert value not in public
    assert (reports / "compare-v1" / figures[0]).is_file()
    markdown = compare.to_markdown(built, REAL, figures, "Hand-written analysis.")
    assert expected["seller"]["taxCode"] in markdown  # the example shows the value, by decision
    assert "Hand-written analysis." in markdown
    assert "latency p50 / p95, single page" in markdown
    assert "| **amount actually paid** | $0 (free tier) | $0 (free tier) |" in markdown
