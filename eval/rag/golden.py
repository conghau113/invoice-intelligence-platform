"""The golden questions and the oracle that gives their right answers from the dataset.

The oracle reads `<id>.expected.json` (the dataset's ground truth) and computes in Python, without
the API's SQL: if both agree, the SQL is right; if they disagree, the report shows it. The oracle
applies what the question MEANS (the supplier spelled with diacritics, an item in both languages),
not what a model might write in a filter, so a filter that misses part of the answer is wrong.
"""

import json
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rag.names import DATASET_DIR, GOLDEN_FILE

KINDS = ("lookup", "aggregate", "refusal")
METRICS = ("total", "subtotal", "vatAmount", "lineAmount", "invoiceCount")
# Digits after the decimal point of each currency in the dataset (minor units, CLAUDE.md).
EXPONENT = {"VND": 0, "USD": 2}


class GoldenError(Exception):
    """The golden file is not what the scorer expects."""


@dataclass(frozen=True)
class Question:
    id: str
    lang: str
    kind: str
    question: str
    tags: tuple[str, ...]
    sources: tuple[str, ...] = ()
    facts: tuple[tuple[str, ...], ...] = ()
    expect: dict[str, Any] = field(default_factory=dict)
    needs: str | None = None
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class Golden:
    today: str
    questions: tuple[Question, ...]

    def by_id(self) -> dict[str, Question]:
        return {q.id: q for q in self.questions}


def _question(raw: dict[str, Any]) -> Question:
    kind = raw.get("kind")
    if kind not in KINDS or raw.get("lang") not in ("vi", "en"):
        raise GoldenError(f"{raw.get('id')}: bad kind or lang")
    q = Question(
        id=raw["id"],
        lang=raw["lang"],
        kind=kind,
        question=raw["question"],
        tags=tuple(raw.get("tags", [])),
        sources=tuple(raw.get("sources", [])),
        facts=tuple(tuple(g) for g in raw.get("facts", [])),
        expect=dict(raw.get("expect", {})),
        needs=raw.get("needs"),
        reasons=tuple(raw.get("reasons", [])),
    )
    if kind == "lookup" and (not q.sources or not q.facts or any(not g for g in q.facts)):
        raise GoldenError(f"{q.id}: a lookup needs sources and non-empty fact groups")
    if kind == "aggregate" and q.expect.get("metric") not in METRICS:
        raise GoldenError(f"{q.id}: unknown metric")
    if kind == "refusal" and not q.reasons:
        raise GoldenError(f"{q.id}: a refusal needs accepted reasons")
    return q


def load(path: Path = GOLDEN_FILE) -> Golden:
    raw = json.loads(path.read_text(encoding="utf-8"))
    questions = tuple(_question(q) for q in raw["questions"])
    ids = [q.id for q in questions]
    if len(set(ids)) != len(ids):
        raise GoldenError("duplicate question id")
    return Golden(today=raw["today"], questions=questions)


def expected_invoice(dataset_id: str, root: Path = DATASET_DIR) -> dict[str, Any]:
    return json.loads((root / f"{dataset_id}.expected.json").read_text(encoding="utf-8"))


def _matches(text: str, needles: list[str]) -> bool:
    # Like the API's ILIKE '%…%': case-insensitive, diacritics kept.
    folded = text.casefold()
    return any(n.casefold() in folded for n in needles)


def _invoice_value(inv: dict[str, Any], metric: str, items: list[str] | None) -> int:
    if metric == "lineAmount":
        return sum(ln["amount"] for ln in inv["lines"] if _matches(ln["description"], items or []))
    if metric == "vatAmount":
        return sum(b["amount"] for b in inv["vatBreakdown"])
    return int(inv[metric])


def _selected(expect: dict[str, Any], invoices: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for inv in invoices.values():
        if expect.get("sellers") and not _matches(inv["seller"]["name"], expect["sellers"]):
            continue
        if expect.get("from") and inv["issueDate"] < expect["from"]:
            continue
        if expect.get("to") and inv["issueDate"] > expect["to"]:
            continue
        if expect.get("currency") and inv["currency"] != expect["currency"]:
            continue
        items = expect.get("items")
        if items and not any(_matches(ln["description"], items) for ln in inv["lines"]):
            continue
        out.append(inv)
    return out


def oracle(expect: dict[str, Any], invoices: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """The right answer: `invoiceCount` and one sum per currency (minor units), as the API streams
    it. With `groupBy` (seller or month), one such answer per group, for the report only."""
    selected = _selected(expect, invoices)
    metric = expect["metric"]

    def sums(group: list[dict[str, Any]]) -> dict[str, Any]:
        per_currency: dict[str, int] = defaultdict(int)
        if metric != "invoiceCount":
            for inv in group:
                per_currency[inv["currency"]] += _invoice_value(inv, metric, expect.get("items"))
        return {"invoiceCount": len(group), "results": dict(sorted(per_currency.items()))}

    group_by = expect.get("groupBy")
    if group_by is None:
        return sums(selected)
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for inv in selected:
        key = inv["seller"]["name"] if group_by == "seller" else inv["issueDate"][:7]
        groups[key].append(inv)
    return {"groups": {k: sums(v) for k, v in sorted(groups.items())}}


def money(minor: int, currency: str) -> str:
    """Minor units as the chunks write them: "449000" VND, "122.75" USD (no separators)."""
    exp = EXPONENT[currency]
    if exp == 0:
        return str(minor)
    sign = "-" if minor < 0 else ""
    whole, frac = divmod(abs(minor), 10**exp)
    return f"{sign}{whole}.{frac:0{exp}d}"


def invoice_text(inv: dict[str, Any]) -> str:
    """Every value of an invoice a fact may quote, one per line (for checking the golden file)."""
    cur = inv["currency"]
    parts = [
        inv["seller"]["name"],
        inv["buyer"]["name"],
        inv["invoiceNo"],
        f"{inv['series']}-{inv['invoiceNo']}",
        inv["issueDate"],
        money(inv["total"], cur),
        money(inv["subtotal"], cur),
    ]
    for line in inv["lines"]:
        parts += [line["description"], money(line["unitPrice"], cur), money(line["amount"], cur)]
    return "\n".join(parts)
