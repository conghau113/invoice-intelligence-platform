"""Minimal synthetic invoice PDFs for T3.1 (T4.1 replaces this with the full generator).

Renders the ground-truth JSON that min_xml.py already wrote, so the answer is known and the same
invoices exist as XML and PDF. Standard library only. Base-14 Helvetica has no Vietnamese letters,
so diacritics are stripped (a limitation of this tool, not of the product). Every page carries a
SAMPLE watermark line (docs/LEGAL.md).

    cd apps/ai && uv run python ../../tools/invoice-gen/min_pdf.py --n 3
"""

import argparse
import json
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "apps/ai/tests/fixtures"
SRC = ROOT / "xml_invoices"
OUT = ROOT / "pdf_invoices"


def ascii_text(text: str) -> str:
    text = text.replace("đ", "d").replace("Đ", "D")
    out = unicodedata.normalize("NFD", text).encode("ascii", "ignore").decode()
    return out.replace("\\", "").replace("(", "[").replace(")", "]")


def money(minor: int, currency: str) -> str:
    major = minor if currency == "VND" else minor / 100
    text = f"{major:,.0f}" if currency == "VND" else f"{major:,.2f}"
    return f"{text} {currency}"


def lines_for(inv: dict) -> list[tuple[int, str]]:
    cur = inv["currency"]
    rows = [
        (16, "HOA DON GTGT - SAMPLE (du lieu gia, khong co gia tri)"),
        (11, f"Ky hieu: {inv['series']}    So: {inv['invoiceNo']}    Ngay: {inv['issueDate']}"),
        (11, f"Don vi ban: {inv['seller']['name']}"),
        (11, f"MST: {inv['seller']['taxCode']}    Dia chi: {inv['seller']['address']}"),
        (11, f"Don vi mua: {inv['buyer']['name']}"),
        (11, f"MST: {inv['buyer']['taxCode'] or '(khong co)'}    Dia chi: {inv['buyer']['address']}"),
        (11, "STT  Ten hang    DVT   SL    Don gia    Thue%   Thanh tien"),
    ]
    for i, ln in enumerate(inv["lines"], 1):
        rows.append(
            (11, f"{i}  {ln['description']}  {ln['unit']}  {ln['quantity']}  "
                 f"{money(ln['unitPrice'], cur)}  {ln['vatRate']}%  {money(ln['amount'], cur)}")
        )
    rows.append((11, f"Cong tien hang: {money(inv['subtotal'], cur)}"))
    for v in inv["vatBreakdown"]:
        rows.append((11, f"Thue suat {v['rate']}%: tien thue {money(v['amount'], cur)}"))
    rows.append((13, f"Tong thanh toan: {money(inv['total'], cur)}"))
    return rows


def build_pdf(inv: dict, hidden: str | None = None) -> bytes:
    """`hidden` (test fixtures only): text a viewer does not paint, placed where PDFs can hide it."""
    y = 790
    ops = []
    for size, text in lines_for(inv):
        ops.append(f"BT /F1 {size} Tf 40 {y} Td ({ascii_text(text)}) Tj ET")
        y -= size + 14
    ops.append("BT /F1 40 Tf 120 300 Td (SAMPLE) Tj ET")  # watermark
    if hidden is not None:
        secret = ascii_text(hidden)
        ops.append(f"BT /F1 11 Tf 3 Tr 40 80 Td ({secret}) Tj ET")  # render mode 3: invisible
        ops.append(f"q 1 1 1 rg BT /F1 11 Tf 40 60 Td ({secret}) Tj ET Q")  # white on white
    stream = "\n".join(ops).encode("latin-1")
    annots = b"/Annots [6 0 R] " if hidden is not None else b""
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> " + annots + b"/Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    info_ref = ""
    if hidden is not None:
        secret_bytes = ascii_text(hidden).encode("latin-1")
        # No appearance stream and the Hidden flag (F 2): an annotation that carries text only.
        objs.append(
            b"<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] /F 2 /Contents ("
            + secret_bytes
            + b") >>"
        )
        objs.append(b"<< /Title (" + secret_bytes + b") >>")  # document metadata
        info_ref = f" /Info {len(objs)} 0 R"
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R{info_ref} >>\nstartxref\n{xref}\n%%EOF\n"
    ).encode()
    return bytes(out)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=3)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for i in range(args.n):
        inv = json.loads((SRC / f"invoice-{i:02d}.expected.json").read_text(encoding="utf-8"))
        (OUT / f"invoice-{i:02d}.pdf").write_bytes(build_pdf(inv))
        (OUT / f"invoice-{i:02d}.expected.json").write_text(
            json.dumps(inv, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
