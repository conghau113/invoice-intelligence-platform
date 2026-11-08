"""What is printed on an invoice, read from the PDF text layer (T4.4 error analysis only).

Every document in `v1` has a PDF; a picture variant has the PDF of the same invoice next to it, so
"is this value printed anywhere on the invoice" can be answered for pictures too, even though the
model saw pixels. Checks are by whole token, never by substring: the cut tax code `2181960011` is
a substring of the printed `2181960011-224`, and a substring check would call it printed (T3.7).

Amounts are compared in minor units, like the contract: `24.973,09` on a vi invoice in USD is
2497309. Dates are not checked: one date is printed in several ways ("03 tháng 09 năm 2026",
"24/09/2026", "March 22, 2026").
"""

import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium

MINOR_DIGITS = {"VND": 0, "USD": 2}
# Thousands and decimal separators per locale of the generator (tools/invoice-gen).
SEPARATORS = {"vi": (".", ","), "en": (",", ".")}
_EDGE = "\"'()[]{}:;,.!?"
# Bounded, no nested repetition: digits and separators, a digit at both ends. The grouping is
# checked in code below.
_NUMBER = re.compile(r"^\d[\d.,]{0,28}\d$|^\d$")


def clean_token(token: str) -> str:
    """NFC, case-folded, punctuation at either end removed: "MST:" -> "mst", "(cá" -> "cá"."""
    return unicodedata.normalize("NFC", token).casefold().strip(_EDGE)


def tokens_of(text: str) -> list[str]:
    return [t for t in (clean_token(raw) for raw in text.split()) if t]


def minor_digits(currency: str) -> int:
    """Digits after the decimal point. v1 has VND and USD; a new currency must be added here."""
    if currency not in MINOR_DIGITS:
        raise ValueError(f"unknown currency for minor units: {currency}")
    return MINOR_DIGITS[currency]


def parse_number(token: str, locale: str) -> Decimal | None:
    """A printed number as written ("16,5" on vi is 16.5, "8%" is 8), or None."""
    token = token.removesuffix("%")
    if not _NUMBER.fullmatch(token):
        return None
    thousands, decimal = SEPARATORS[locale]
    whole, _, fraction = token.partition(decimal)
    groups = whole.split(thousands)
    if decimal in fraction or not fraction.isdigit() and fraction:
        return None
    if len(groups) > 1 and (not 1 <= len(groups[0]) <= 3 or any(len(g) != 3 for g in groups[1:])):
        return None  # "1.23.4" is not a number; "12.345" is
    digits = "".join(groups) + ("." + fraction if fraction else "")
    if not digits.replace(".", "").isdigit():
        return None
    try:
        return Decimal(digits)
    except InvalidOperation:
        return None


def parse_amount(token: str, locale: str, currency: str) -> int | None:
    """A printed amount in minor units, or None when the token is not a number in this locale."""
    number = parse_number(token, locale)
    if number is None or token.endswith("%"):
        return None
    value = number * (10 ** minor_digits(currency))
    return int(value) if value == value.to_integral_value() else None


@dataclass(frozen=True)
class Printed:
    """The text layer of one invoice: its tokens, the amounts among them (minor units, for money)
    and the plain numbers (as written, for quantities and VAT rates)."""

    tokens: tuple[str, ...]
    amounts: frozenset[int]
    numbers: frozenset[Decimal] = frozenset()

    def has_text(self, value: str) -> bool:
        """`value`'s tokens appear one after another, each a whole token."""
        want = tokens_of(value)
        if not want:
            return False
        n = len(want)
        return any(list(self.tokens[i : i + n]) == want for i in range(len(self.tokens) - n + 1))

    def has_amount(self, value: int) -> bool:
        return value in self.amounts

    def has_number(self, value: Decimal) -> bool:
        return value in self.numbers


def read_printed(pdf_path: Path, locale: str, currency: str) -> Printed:
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        text = "\n".join(pdf[i].get_textpage().get_text_bounded() for i in range(len(pdf)))
    finally:
        pdf.close()
    tokens = tokens_of(text)
    raw = text.split() + tokens
    amounts = {parse_amount(t, locale, currency) for t in raw}
    numbers = {parse_number(t, locale) for t in raw}
    return Printed(
        tuple(tokens),
        frozenset(a for a in amounts if a is not None),
        frozenset(n for n in numbers if n is not None),
    )


def pdf_of(documents_dir: Path, doc: dict[str, Any]) -> Path:
    """The PDF of a document: itself, or the PDF of the same invoice for a picture variant."""
    names = [n for n in doc["files"] if n.endswith(".pdf")]
    if len(names) != 1:
        raise ValueError(f"{doc['id']}: expected one PDF")
    return documents_dir / names[0]


def format_amount(value: int, locale: str, currency: str) -> str:
    """How the generator prints an amount in minor units: 2497309 USD on vi -> "24.973,09"."""
    thousands, decimal = SEPARATORS[locale]
    digits = minor_digits(currency)
    whole, fraction = divmod(abs(value), 10**digits) if digits else (abs(value), 0)
    text = f"{whole:,}".replace(",", thousands)
    if digits:
        text += decimal + str(fraction).rjust(digits, "0")
    return ("-" if value < 0 else "") + text
