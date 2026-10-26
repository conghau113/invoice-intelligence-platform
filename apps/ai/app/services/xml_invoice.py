"""Deterministic path: Vietnamese e-invoice XML -> Invoice (confidence 1, no LLM).

Supported structure: the subset of the public e-invoice element names (HDon/DLHDon/TTChung/
NDHDon/...) that tools/invoice-gen produces. Real provider files differ (namespaces, optional
fields, "KCT" tax rate); those are rejected with a code instead of guessed. See
tools/invoice-gen/README.md for how to add a mapping.

The XML is untrusted: parsed with defusedxml and DTDs are forbidden outright, which blocks XXE
and entity-expansion bombs. Error messages are fixed strings, never document content.
"""

import re
from decimal import Decimal
from typing import Any
from xml.etree.ElementTree import Element, ParseError

from defusedxml import DefusedXmlException
from defusedxml.ElementTree import fromstring
from pydantic import ValidationError

from app.schemas.generated import Invoice

MAX_XML_BYTES = 10 * 1024 * 1024  # same cap as the API upload
MAX_XML_TAGS = 200_000  # real invoices have ~10 tags per line; this bounds tree size and depth
# Plain ASCII decimal only (re.ASCII keeps \d from matching other scripts' digits). Decimal()
# alone also accepts "1E+999999999" (Overflow later), full-width digits, "1_000", "NaN" and
# surrounding whitespace.
DECIMAL_PATTERN = re.compile(r"-?\d{1,18}(?:\.\d{1,6})?", re.ASCII)
CURRENCY_EXPONENT = {"VND": 0, "USD": 2}  # minor-unit digits; unknown currency is rejected


class XmlInvoiceError(Exception):
    """`code` is stable (the worker and UI key on it); `message` never contains document text."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _text(parent: Element, path: str) -> str:
    el = parent.find(path)
    value = (el.text or "").strip() if el is not None else ""
    if not value:
        raise XmlInvoiceError("XML_MISSING_FIELD", f"Required element missing: {path}")
    return value


def _optional_text(parent: Element, path: str) -> str | None:
    el = parent.find(path)
    value = (el.text or "").strip() if el is not None else ""
    return value or None


def _decimal(value: str, name: str) -> Decimal:
    if not DECIMAL_PATTERN.fullmatch(value):
        raise XmlInvoiceError("XML_INVALID_VALUE", f"Not a plain decimal number: {name}")
    return Decimal(value)


def _money(value: str, name: str, exponent: int) -> int:
    """Decimal text -> integer minor units; never goes through float."""
    scaled = _decimal(value, name).scaleb(exponent)
    if scaled != scaled.to_integral_value():
        raise XmlInvoiceError("XML_INVALID_VALUE", f"Too many decimals for the currency: {name}")
    return int(scaled)


def _rate(value: str, name: str) -> float:
    cleaned = value.removesuffix("%").strip()
    try:
        return float(_decimal(cleaned, name))
    except XmlInvoiceError:
        # "KCT" (not subject to tax) and similar are not 0%; refuse rather than guess.
        raise XmlInvoiceError("XML_UNSUPPORTED_VAT_RATE", f"Unsupported tax rate: {name}") from None


def _party(el: Element, *, tax_code_required: bool) -> dict[str, Any]:
    tax_code = _text(el, "MST") if tax_code_required else _optional_text(el, "MST")
    return {"name": _text(el, "Ten"), "taxCode": tax_code, "address": _text(el, "DChi")}


def leaf_paths(invoice: dict[str, Any]) -> list[str]:
    """Every addressable field path of an Invoice (same grammar as FieldPathSchema)."""
    paths: list[str] = []
    for key, value in invoice.items():
        if key == "fieldMeta":
            continue
        if isinstance(value, dict):
            paths += [f"{key}.{sub}" for sub in value]
        elif isinstance(value, list):
            paths += [f"{key}.{i}.{sub}" for i, item in enumerate(value) for sub in item]
        else:
            paths.append(key)
    return paths


def _map(root: Element) -> dict[str, Any]:
    if root.tag != "HDon":
        raise XmlInvoiceError("XML_UNSUPPORTED_STRUCTURE", "Root element is not HDon")
    general = root.find("DLHDon/TTChung")
    body = root.find("DLHDon/NDHDon")
    if general is None or body is None:
        raise XmlInvoiceError("XML_MISSING_FIELD", "Required element missing: DLHDon")
    currency = _text(general, "DVTTe")
    if currency not in CURRENCY_EXPONENT:
        raise XmlInvoiceError("XML_UNSUPPORTED_CURRENCY", "Currency is not supported")
    exp = CURRENCY_EXPONENT[currency]

    seller, buyer = body.find("NBan"), body.find("NMua")
    totals = body.find("TToan")
    if seller is None or buyer is None or totals is None:
        raise XmlInvoiceError("XML_MISSING_FIELD", "Required element missing: NBan/NMua/TToan")
    lines = [
        {
            "description": _text(item, "THHDVu"),
            "quantity": float(_decimal(_text(item, "SLuong"), "SLuong")),
            "unit": _text(item, "DVTinh"),
            "unitPrice": _money(_text(item, "DGia"), "DGia", exp),
            "vatRate": _rate(_text(item, "TSuat"), "TSuat"),
            "amount": _money(_text(item, "ThTien"), "ThTien", exp),
        }
        for item in body.findall("DSHHDVu/HHDVu")
    ]
    breakdown = [
        {
            "rate": _rate(_text(item, "TSuat"), "TSuat"),
            "base": _money(_text(item, "TgTien"), "TgTien", exp),
            "amount": _money(_text(item, "TThue"), "TThue", exp),
        }
        for item in totals.findall("THTTLTSuat/LTSuat")
    ]
    invoice: dict[str, Any] = {
        "seller": _party(seller, tax_code_required=True),
        "buyer": _party(buyer, tax_code_required=False),
        "invoiceNo": _text(general, "SHDon"),
        "series": _text(general, "KHHDon"),
        "issueDate": _text(general, "NLap"),
        "currency": currency,
        "lines": lines,
        "subtotal": _money(_text(totals, "TgTCThue"), "TgTCThue", exp),
        "vatBreakdown": breakdown,
        "total": _money(_text(totals, "TgTTTBSo"), "TgTTTBSo", exp),
    }
    # Deterministic extraction: every field certain, no page to cite (evidence stays null).
    invoice["fieldMeta"] = {
        path: {"confidence": 1.0, "evidence": None} for path in leaf_paths(invoice)
    }
    return invoice


def parse_xml_invoice(data: bytes) -> dict[str, Any]:
    if len(data) > MAX_XML_BYTES:
        raise XmlInvoiceError("FILE_TOO_LARGE", "XML exceeds the size limit")
    if data.count(b"<") > MAX_XML_TAGS:  # C-speed check before the tree is built
        raise XmlInvoiceError("XML_TOO_COMPLEX", "XML has too many elements")
    try:
        root = fromstring(data, forbid_dtd=True)
    except DefusedXmlException:
        raise XmlInvoiceError(
            "XML_FORBIDDEN_CONSTRUCT", "DTDs and entities are not allowed"
        ) from None
    except (ParseError, ValueError, LookupError):  # LookupError: unknown encoding name
        raise XmlInvoiceError("XML_MALFORMED", "Not well-formed XML") from None
    invoice = _map(root)
    try:
        Invoice.model_validate(invoice)  # the contract is the last word, not our mapping
    except ValidationError:
        # pydantic's message quotes the offending values; keep them out of errors and logs.
        raise XmlInvoiceError("XML_INVALID_VALUE", "A value breaks the invoice schema") from None
    return invoice
