"""Normalised comparison of one extracted value with the ground truth, and line pairing.

Three kinds of field, three rules (docs/learning/T4.3-task-notes.md):
- identifiers (numbers, series, tax codes, currency, dates): the whole string after NFC and trim.
  A tax code without its branch suffix is wrong (ADR 0020), so is a different letter case.
- numbers (money, quantities, rates): equal as decimals, so 2, 2.0 and 2.50 / 2.5 agree.
- free text (names, addresses, descriptions, units): NFC, case-folded, punctuation read as a space,
  whitespace collapsed. Lost Vietnamese diacritics still count as wrong: "Nguyen" is not "Nguyễn"
  for whoever keys the invoice in. `accent_only` tells those errors apart for the report.
"""

import unicodedata
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
from typing import Any, Literal

Kind = Literal["id", "number", "text"]

FIELD_KINDS: dict[str, Kind] = {
    "seller.name": "text",
    "seller.taxCode": "id",
    "seller.address": "text",
    "buyer.name": "text",
    "buyer.taxCode": "id",
    "buyer.address": "text",
    "invoiceNo": "id",
    "series": "id",
    "issueDate": "id",
    "currency": "id",
    "subtotal": "number",
    "total": "number",
}
HEADER_FIELDS = tuple(FIELD_KINDS)
# ADR 0020: the fields the acceptance floor and the regression gate are about.
CRITICAL_FIELDS = (
    "invoiceNo",
    "series",
    "issueDate",
    "currency",
    "subtotal",
    "total",
    "seller.taxCode",
    "buyer.taxCode",
)
LINE_COLUMNS: dict[str, Kind] = {
    "description": "text",
    "quantity": "number",
    "unit": "text",
    "unitPrice": "number",
    "vatRate": "number",
    "amount": "number",
}
# A predicted line is paired with an expected one only from this similarity on (0..1). Pairing
# decides which line a column is compared with; a pair counts as right only if every column is.
PAIR_THRESHOLD = 0.5


def normalize_id(value: str) -> str:
    return unicodedata.normalize("NFC", value).strip()


def normalize_text(value: str) -> str:
    text = unicodedata.normalize("NFC", value).casefold()
    spaced = "".join(" " if unicodedata.category(ch).startswith("P") else ch for ch in text)
    return " ".join(spaced.split())


def strip_accents(value: str) -> str:
    """Base letters only. `đ` has no decomposition, so it is mapped by hand."""
    decomposed = unicodedata.normalize("NFD", value.replace("đ", "d").replace("Đ", "D"))
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


def as_number(value: Any) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def same(kind: Kind, got: Any, want: Any) -> bool:
    """True when `got` is the expected value. A missing value equals only a missing value."""
    if got is None or want is None:
        return got is None and want is None
    if kind == "number":
        a, b = as_number(got), as_number(want)
        return a is not None and a == b
    if not isinstance(got, str) or not isinstance(want, str):
        return False
    if kind == "id":
        return normalize_id(got) == normalize_id(want)
    return normalize_text(got) == normalize_text(want)


def accent_only(got: Any, want: Any) -> bool:
    """Wrong text that would be right without diacritics."""
    if not isinstance(got, str) or not isinstance(want, str) or same("text", got, want):
        return False
    return strip_accents(normalize_text(got)) == strip_accents(normalize_text(want))


def line_similarity(got: dict[str, Any], want: dict[str, Any]) -> float:
    """Half the description (without diacritics, so they cannot break a pair), half the other
    columns that agree exactly."""
    a = strip_accents(normalize_text(str(got.get("description") or "")))
    b = strip_accents(normalize_text(str(want.get("description") or "")))
    text = SequenceMatcher(None, a, b, autojunk=False).ratio()
    others = [c for c in LINE_COLUMNS if c != "description"]
    agree = sum(same(LINE_COLUMNS[c], got.get(c), want.get(c)) for c in others)
    return 0.5 * text + 0.5 * agree / len(others)


def pair_lines(got: list[dict[str, Any]], want: list[dict[str, Any]]) -> list[tuple[int, int]]:
    """Greedy pairing by similarity: (got index, want index) pairs, best first.

    Greedy instead of an optimal assignment (Hungarian): no dependency, and on this dataset no two
    lines of an invoice share a description. When greedy does pair badly, the score goes down,
    never up, because a pair is right only if all its columns are.
    """
    candidates = sorted(
        (
            (-score, w, g)
            for g, got_line in enumerate(got)
            for w, want_line in enumerate(want)
            if (score := line_similarity(got_line, want_line)) >= PAIR_THRESHOLD
        ),
    )
    used_got: set[int] = set()
    used_want: set[int] = set()
    pairs: list[tuple[int, int]] = []
    for _, w, g in candidates:
        if g in used_got or w in used_want:
            continue
        used_got.add(g)
        used_want.add(w)
        pairs.append((g, w))
    return pairs
