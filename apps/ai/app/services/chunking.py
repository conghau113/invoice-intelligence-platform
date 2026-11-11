"""Approved invoice -> chunks for RAG (T5.1). Pure and deterministic: no I/O, no LLM, no logging.

Input is one row of the view `current_invoices` (never the table `invoices`, which keeps every
version and reopened invoices too; DATA_MODEL.md). The service is stateless, so the caller
(the index job, T5.2) reads the view and sends the row. Lines come from `data.lines` of that
row: the approval writes `current_invoice_lines` from the same list in the same insert
(`line_no = index + 1`), so both hold the same lines and `data` also holds `fieldMeta`.

Chunks follow the document's structure instead of a character count:
- one `header` chunk: parties, number, date, currency, VAT breakdown, totals;
- `lines` chunks: consecutive lines, at most LINES_PER_CHUNK lines and MAX_CHUNK_CHARS
  characters, each starting with a short context line so a chunk still makes sense alone.
  A line is never split, so one very long line can exceed MAX_CHUNK_CHARS on its own.

Every field rendered into `content` is listed in `refs` (and nothing else), with the page from
`fieldMeta` evidence (`None` for XML, which has no pages), so an answer can cite a field.

Field values are document content: data, never instructions. Whitespace (incl. newlines) inside
a value is collapsed and control characters dropped, so a value cannot forge a new labelled
line in `content`. That is not a defence against prompt injection; the answer step (T5.4) is.
"""

import unicodedata
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.generated import Invoice
from app.services.xml_invoice import CURRENCY_EXPONENT

LINES_PER_CHUNK = 10
MAX_CHUNK_CHARS = 2000


class ApprovedInvoiceRow(BaseModel):
    """The columns of one `current_invoices` row that chunking needs."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    tenant_id: UUID
    document_id: UUID
    document_version: int = Field(ge=1)
    data: Invoice


class ChunkRef(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    document_id: UUID
    field_path: str
    page: int | None


class Chunk(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tenant_id: UUID
    document_id: UUID
    document_version: int
    invoice_id: UUID
    kind: Literal["header", "lines"]
    ordinal: int  # 0 = header, then line groups in order; stable for an idempotent re-index
    content: str
    refs: list[ChunkRef]


def _clean(value: str) -> str:
    """Collapse whitespace (newlines too); control characters (Cc) become a space, invisible
    format characters (Cf: zero-width, bidi overrides such as U+202E) are dropped."""
    kept = []
    for ch in value:
        category = unicodedata.category(ch)
        if category == "Cc":
            kept.append(" ")
        elif category != "Cf":
            kept.append(ch)
    return " ".join("".join(kept).split())


def _money(minor: int, currency: str) -> str:
    exponent = CURRENCY_EXPONENT.get(currency)
    if exponent is None:
        return f"{minor} {currency} (minor units)"
    return f"{Decimal(minor).scaleb(-exponent):f} {currency}"


def _number(value: float) -> str:
    """Plain decimal digits, never scientific notation (repr(1e-07) is "1e-07")."""
    if value.is_integer():
        return str(int(value))
    return format(Decimal(repr(value)), "f")


class _Builder:
    """Collects text lines and the field paths they render."""

    def __init__(self) -> None:
        self.lines: list[str] = []
        self.paths: list[str] = []

    def add(self, text: str, *paths: str) -> None:
        self.lines.append(text)
        self.paths.extend(paths)


def _context(b: _Builder, inv: Invoice) -> None:
    b.add(
        f"Hoá đơn / Invoice: {_clean(inv.series)}-{_clean(inv.invoiceNo)}"
        f" · Người bán / Seller: {_clean(inv.seller.name)}"
        f" · Ngày / Date: {inv.issueDate}",
        "series",
        "invoiceNo",
        "seller.name",
        "issueDate",
    )


def _header(inv: Invoice) -> _Builder:
    b = _Builder()
    _context(b, inv)
    b.add(f"Mã số thuế người bán / Seller tax code: {inv.seller.taxCode}", "seller.taxCode")
    b.add(f"Địa chỉ người bán / Seller address: {_clean(inv.seller.address)}", "seller.address")
    b.add(f"Người mua / Buyer: {_clean(inv.buyer.name)}", "buyer.name")
    if inv.buyer.taxCode is not None:
        b.add(f"Mã số thuế người mua / Buyer tax code: {inv.buyer.taxCode}", "buyer.taxCode")
    b.add(f"Địa chỉ người mua / Buyer address: {_clean(inv.buyer.address)}", "buyer.address")
    b.add(f"Tiền tệ / Currency: {inv.currency}", "currency")
    for i, vat in enumerate(inv.vatBreakdown):
        b.add(
            f"Thuế GTGT / VAT {_number(vat.rate)}%:"
            f" tiền chịu thuế / base {_money(vat.base, inv.currency)},"
            f" tiền thuế / tax {_money(vat.amount, inv.currency)}",
            f"vatBreakdown.{i}.rate",
            f"vatBreakdown.{i}.base",
            f"vatBreakdown.{i}.amount",
        )
    b.add(f"Cộng tiền hàng / Subtotal: {_money(inv.subtotal, inv.currency)}", "subtotal")
    b.add(f"Tổng cộng / Total: {_money(inv.total, inv.currency)}", "total")
    b.add(f"Số dòng hàng / Number of lines: {len(inv.lines)}")
    return b


def _line_text(inv: Invoice, i: int) -> tuple[str, list[str]]:
    line = inv.lines[i]
    text = (
        f"Dòng / Line {i + 1}: {_clean(line.description)}"
        f" · SL / Qty: {_number(line.quantity)} {_clean(line.unit)}"
        f" · Đơn giá / Unit price: {_money(line.unitPrice, inv.currency)}"
        f" · Thuế / VAT: {_number(line.vatRate)}%"
        f" · Thành tiền / Amount: {_money(line.amount, inv.currency)}"
    )
    fields = ("description", "quantity", "unit", "unitPrice", "vatRate", "amount")
    return text, [f"lines.{i}.{f}" for f in fields]


def _line_groups(inv: Invoice) -> list[_Builder]:
    groups: list[_Builder] = []
    current: _Builder | None = None
    count = 0
    for i in range(len(inv.lines)):
        text, paths = _line_text(inv, i)
        full = current is not None and (
            count >= LINES_PER_CHUNK or len("\n".join([*current.lines, text])) > MAX_CHUNK_CHARS
        )
        if current is None or full:
            current = _Builder()
            _context(current, inv)
            groups.append(current)
            count = 0
        current.add(text, *paths)
        count += 1
    return groups


def chunk_invoice(row: ApprovedInvoiceRow) -> list[Chunk]:
    inv = row.data

    def page_of(path: str) -> int | None:
        meta = inv.fieldMeta.get(path)
        return meta.evidence.page if meta is not None and meta.evidence is not None else None

    def build(kind: Literal["header", "lines"], ordinal: int, b: _Builder) -> Chunk:
        return Chunk(
            tenant_id=row.tenant_id,
            document_id=row.document_id,
            document_version=row.document_version,
            invoice_id=row.id,
            kind=kind,
            ordinal=ordinal,
            content="\n".join(b.lines),
            refs=[
                ChunkRef(document_id=row.document_id, field_path=p, page=page_of(p))
                for p in b.paths
            ],
        )

    chunks = [build("header", 0, _header(inv))]
    chunks += [build("lines", n, g) for n, g in enumerate(_line_groups(inv), start=1)]
    return chunks
