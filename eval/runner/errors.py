"""Error classes for T4.4: why a field or a line is wrong, not only that it is.

Classes, from the task (đọc sai số, nhầm field, thiếu dòng, ảo giác) plus two that are not about
reading at all, so they cannot be mistaken for it:

- `failed`: no invoice came back; every field of the document is wrong for that reason alone.
- `missing`: the invoice prints a value, the answer has none.
- `misread`: the answer is close to the printed value. Kinds: `truncated` (tax code without its
  branch suffix), `digits` (an identifier or an amount with other digits), `diacritics` (right
  without the marks), `text` (other close text). A line that is there with a wrong column is
  classified column by column, with the same rules.
- `wrong_field`: the value is printed on this invoice, in another place. Kinds: `other_field`
  (another header field, or another column of the same line), `other_line` (the same column of
  another line: rows read out of step), `printed_elsewhere` (other printed text or number).
- `missing_line`: an invoice line has no line in the answer, not even a badly read one.
- `hallucination`: the value is printed nowhere on the invoice (whole tokens, `textlayer.py`), or
  the field is empty on the invoice and the answer fills it.

The rules are a heuristic: each class has a test, and the five examples in the report are checked
by eye. Pure functions over plain dicts, like `scoring.py`.
"""

from difflib import SequenceMatcher
from typing import Any

from runner.matching import (
    FIELD_KINDS,
    LINE_COLUMNS,
    Kind,
    accent_only,
    as_number,
    normalize_text,
    pair_lines,
    same,
    strip_accents,
)
from runner.scoring import VAT_FIELD, value_at
from runner.textlayer import Printed

CLOSE = 0.6  # SequenceMatcher ratio from which two values are "close" (a misread, not another)
# A line left unpaired by the scorer (similarity < 0.5, T4.3) but with this description is the same
# line read with wrong columns, not a missing line plus an invented one (Phát sinh T4.3).
SAME_DESCRIPTION = 0.8
# Money is compared in minor units (the contract); quantities and VAT rates as written.
MONEY = frozenset({"subtotal", "total", "unitPrice", "amount"})
CLASSES = (
    "failed",
    "missing",
    "misread",
    "wrong_field",
    "missing_line",
    "hallucination",
)


def _ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b, autojunk=False).ratio()


def _text_key(value: Any) -> str:
    return strip_accents(normalize_text(str(value)))


def _printed(kind: Kind, value: Any, printed: Printed, money: bool) -> bool:
    if kind != "number":
        return isinstance(value, str) and printed.has_text(value)
    number = as_number(value)
    if number is None:
        return False
    if not money:
        return printed.has_number(number)
    return number == number.to_integral_value() and printed.has_amount(int(number))


def _close(kind: Kind, got: Any, want: Any) -> str | None:
    """The misread kind when `got` looks like a reading of `want`, else None."""
    if kind == "text":
        if accent_only(got, want):
            return "diacritics"
        if isinstance(got, str) and isinstance(want, str):
            return "text" if _ratio(_text_key(got), _text_key(want)) >= CLOSE else None
        return None
    a, b = str(got).strip(), str(want).strip()
    if kind == "id" and "-" in b and a == b.split("-")[0]:
        return "truncated"
    if kind == "number" and as_number(got) is None:
        return None
    return "digits" if _ratio(a, b) >= CLOSE else None


def classify_value(
    kind: Kind,
    got: Any,
    want: Any,
    others: list[Any],
    printed: Printed,
    *,
    money: bool = True,
    other_lines: tuple[Any, ...] = (),
) -> tuple[str, str | None]:
    """(class, kind) of one wrong value. `others`: the right values of the other fields (or of the
    other columns of the same line) on this invoice. `other_lines`: the right values of the same
    column in the other lines. `money`: compare in minor units with the printed amounts."""
    if got is None or got == "":
        # An empty string where the invoice has nothing is not a reading at all.
        return ("missing", None) if want is not None else ("hallucination", "value_for_absent")
    if any(o is not None and same(kind, got, o) for o in others):
        return ("wrong_field", "other_field")
    if any(o is not None and same(kind, got, o) for o in other_lines):
        return ("wrong_field", "other_line")
    if want is None:  # nothing to read here: printed elsewhere, or made up
        if _printed(kind, got, printed, money):
            return ("wrong_field", "printed_elsewhere")
        return ("hallucination", "value_for_absent")
    close = _close(kind, got, want)
    if close is not None:
        return ("misread", close)
    if _printed(kind, got, printed, money):
        return ("wrong_field", "printed_elsewhere")
    return ("hallucination", "not_printed")


def _vat_total(want: dict[str, Any]) -> int | None:
    items = want.get(VAT_FIELD)
    if not isinstance(items, list):
        return None
    amounts = [i.get("amount") for i in items if isinstance(i, dict)]
    return sum(amounts) if amounts and all(isinstance(a, int) for a in amounts) else None


def _header(got: dict[str, Any], want: dict[str, Any], printed: Printed) -> list[dict[str, Any]]:
    out = []
    for path, kind in FIELD_KINDS.items():
        g, w = value_at(got, path), value_at(want, path)
        if same(kind, g, w):
            continue
        others = [value_at(want, p) for p, k in FIELD_KINDS.items() if p != path and k == kind]
        if kind == "number":
            others.append(_vat_total(want))
        cls, sub = classify_value(kind, g, w, others, printed, money=path in MONEY)
        out.append({"where": path, "class": cls, "kind": sub})
    return out


def _vat(got: dict[str, Any], want: dict[str, Any]) -> list[dict[str, Any]]:
    g, w = got.get(VAT_FIELD), want.get(VAT_FIELD)

    def key(items: Any) -> list[tuple[Any, ...]] | None:
        if not isinstance(items, list):
            return None
        try:
            return sorted(
                (as_number(i["rate"]), as_number(i["base"]), as_number(i["amount"])) for i in items
            )
        except (KeyError, TypeError, ArithmeticError):
            return None

    if key(g) is not None and key(g) == key(w):
        return []
    if not g:
        return [{"where": VAT_FIELD, "class": "missing", "kind": None}]
    if not w:  # the invoice has no breakdown and the answer has one
        return [{"where": VAT_FIELD, "class": "hallucination", "kind": "value_for_absent"}]
    return [{"where": VAT_FIELD, "class": "misread", "kind": "digits"}]


def _line_columns(
    got_line: dict[str, Any],
    want_lines: list[dict[str, Any]],
    at: tuple[int, int],
    printed: Printed,
) -> list[dict[str, Any]]:
    """`at`: (index in the answer, index on the invoice)."""
    want_line = want_lines[at[1]]
    out = []
    for column, kind in LINE_COLUMNS.items():
        g, w = got_line.get(column), want_line.get(column)
        if same(kind, g, w):
            continue
        others = [want_line.get(c) for c, k in LINE_COLUMNS.items() if c != column and k == kind]
        same_column = tuple(ln.get(column) for i, ln in enumerate(want_lines) if i != at[1])
        cls, sub = classify_value(
            kind, g, w, others, printed, money=column in MONEY, other_lines=same_column
        )
        out.append(
            {"where": f"lines[{at[1]}].{column}", "class": cls, "kind": sub, "gotLine": at[0]}
        )
    return out


def _second_pass(
    got: list[dict[str, Any]], want: list[dict[str, Any]], free_got: set[int], free_want: set[int]
) -> list[tuple[int, int]]:
    """Pairs among the lines the scorer left alone, by description only. A line without a
    description pairs with nothing: two empty strings are "equal" but say nothing."""
    keys_got = {g: _text_key(got[g].get("description") or "") for g in free_got}
    keys_want = {w: _text_key(want[w].get("description") or "") for w in free_want}
    candidates = sorted(
        (-r, w, g)
        for g, a in keys_got.items()
        for w, b in keys_want.items()
        if a and b and (r := _ratio(a, b)) >= SAME_DESCRIPTION
    )
    pairs = []
    for _, w, g in candidates:
        if g in free_got and w in free_want:
            free_got.discard(g)
            free_want.discard(w)
            pairs.append((g, w))
    return pairs


def _lines(got: dict[str, Any], want: dict[str, Any], printed: Printed) -> list[dict[str, Any]]:
    got_lines = got.get("lines") if isinstance(got.get("lines"), list) else []
    got_lines = [g if isinstance(g, dict) else {} for g in got_lines]
    want_lines = want["lines"]
    pairs = pair_lines(got_lines, want_lines)
    free_got = set(range(len(got_lines))) - {g for g, _ in pairs}
    free_want = set(range(len(want_lines))) - {w for _, w in pairs}
    pairs += _second_pass(got_lines, want_lines, free_got, free_want)
    out = []
    for g, w in sorted(pairs, key=lambda p: p[1]):
        out += _line_columns(got_lines[g], want_lines, (g, w), printed)
    out += [
        {"where": f"lines[{w}]", "class": "missing_line", "kind": None} for w in sorted(free_want)
    ]
    for g in sorted(free_got):
        description = got_lines[g].get("description")
        on_invoice = isinstance(description, str) and printed.has_text(description)
        out.append(
            {
                "where": f"extra[{g}]",
                "class": "wrong_field" if on_invoice else "hallucination",
                "kind": "extra_line",
            }
        )
    return out


def classify(
    got: dict[str, Any] | None, want: dict[str, Any], printed: Printed
) -> list[dict[str, Any]]:
    """Every wrong field, VAT breakdown and line of one answer, with its class."""
    if got is None:
        return [{"where": "document", "class": "failed", "kind": None}]
    return _header(got, want, printed) + _vat(got, want) + _lines(got, want, printed)
