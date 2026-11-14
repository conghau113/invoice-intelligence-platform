"""RAG golden set v1 (T5.6) against the frozen dataset: every expected fact and number must
come from the ground truth, so a typo in the golden file cannot pass as a model error, and the
oracle that gives the right numbers is checked on small hand-made invoices."""

import json
from collections import Counter
from pathlib import Path

import pytest
from rag.golden import GoldenError, expected_invoice, invoice_text, load, money, oracle
from rag.text import contains

GOLDEN = load()
CORE = {f"invoice-{i:04d}": expected_invoice(f"invoice-{i:04d}") for i in range(100)}


def test_thirty_questions_in_both_languages_and_every_kind() -> None:
    qs = GOLDEN.questions
    assert len(qs) == 30
    assert Counter(q.lang for q in qs) == {"vi": 17, "en": 13}
    assert Counter(q.kind for q in qs) == {"lookup": 16, "aggregate": 10, "refusal": 4}
    assert GOLDEN.today == "2026-11-11"


@pytest.mark.parametrize(
    "q", [q for q in GOLDEN.questions if q.kind == "lookup"], ids=lambda q: q.id
)
def test_every_fact_group_is_written_in_the_expected_invoice(q) -> None:  # type: ignore[no-untyped-def]
    text = "\n".join(invoice_text(CORE[s]) for s in q.sources)
    for group in q.facts:
        assert any(contains(text, alt) for alt in group), f"{q.id}: none of {group} in {q.sources}"


@pytest.mark.parametrize(
    "q", [q for q in GOLDEN.questions if q.kind == "aggregate"], ids=lambda q: q.id
)
def test_every_aggregate_matches_invoices_of_the_dataset(q) -> None:  # type: ignore[no-untyped-def]
    got = oracle(q.expect, CORE)
    if q.needs == "groupBy":
        assert len(got["groups"]) >= 2
    else:
        assert got["invoiceCount"] >= 1


def test_the_other_tenant_supplier_is_not_in_the_dataset() -> None:
    assert not any("Zeta" in inv["seller"]["name"] for inv in CORE.values())


def _inv(seller: str, date: str, currency: str, total: int, lines: list[tuple[str, int]]) -> dict:
    return {
        "seller": {"name": seller},
        "issueDate": date,
        "currency": currency,
        "total": total,
        "subtotal": total - 10,
        "vatBreakdown": [{"amount": 4}, {"amount": 6}],
        "lines": [{"description": d, "amount": a} for d, a in lines],
    }


INVOICES = {
    "a": _inv("Trần và đối tác SAMPLE", "2026-09-01", "VND", 1000, [("Bút bi văn phòng X1", 300)]),
    "b": _inv(
        "Trần và đối tác SAMPLE", "2026-09-30", "USD", 250, [("Office ballpoint pens X2", 50)]
    ),
    "c": _inv("Garcia-Riley SAMPLE", "2026-10-01", "VND", 7000, [("Network switch", 700)]),
}


def test_the_oracle_sums_per_currency_within_inclusive_dates() -> None:
    expect = {
        "metric": "total",
        "sellers": ["trần và đối tác"],
        "from": "2026-09-01",
        "to": "2026-09-30",
    }
    assert oracle(expect, INVOICES) == {"invoiceCount": 2, "results": {"USD": 250, "VND": 1000}}


def test_the_oracle_keeps_diacritics_like_the_api() -> None:
    expect = {"metric": "invoiceCount", "sellers": ["Tran va doi tac"]}
    assert oracle(expect, INVOICES) == {"invoiceCount": 0, "results": {}}


def test_the_oracle_adds_vat_rows_and_matching_lines_in_both_languages() -> None:
    assert oracle({"metric": "vatAmount", "sellers": ["Garcia"]}, INVOICES)["results"] == {
        "VND": 10
    }
    items = {"metric": "lineAmount", "items": ["Bút bi văn phòng", "Office ballpoint pens"]}
    assert oracle(items, INVOICES) == {"invoiceCount": 2, "results": {"USD": 50, "VND": 300}}
    assert oracle({**items, "currency": "USD"}, INVOICES)["results"] == {"USD": 50}


def test_the_oracle_groups_by_seller_or_month() -> None:
    by_month = oracle({"metric": "total", "groupBy": "month"}, INVOICES)
    assert list(by_month["groups"]) == ["2026-09", "2026-10"]
    by_seller = oracle({"metric": "total", "groupBy": "seller"}, INVOICES)
    assert by_seller["groups"]["Garcia-Riley SAMPLE"] == {
        "invoiceCount": 1,
        "results": {"VND": 7000},
    }


def test_money_is_written_like_the_chunks() -> None:
    assert money(12275, "USD") == "122.75"
    assert money(5, "USD") == "0.05"
    assert money(61829213, "VND") == "61829213"


def test_a_golden_file_with_a_lookup_without_facts_is_refused(tmp_path: Path) -> None:
    bad = {
        "today": "2026-11-11",
        "questions": [
            {
                "id": "x",
                "lang": "vi",
                "kind": "lookup",
                "question": "?",
                "sources": ["invoice-0001"],
                "facts": [],
            }
        ],
    }
    path = tmp_path / "golden.json"
    path.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(GoldenError):
        load(path)
