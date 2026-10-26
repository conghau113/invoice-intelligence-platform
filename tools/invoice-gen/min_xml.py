"""Minimal synthetic e-invoice generator for T2.8 (T4.1 replaces it with the full generator).

Builds the ground-truth Invoice first, then renders the XML from it, so the parser under test is
checked against an answer it did not produce. Standard library only, fixed seed => same output.

    cd apps/ai && uv run python ../../tools/invoice-gen/min_xml.py --n 10 --seed 42

Synthetic data only: tax codes get a WRONG check digit and names carry "SAMPLE" (docs/LEGAL.md).
"""

import argparse
import json
import random
import xml.etree.ElementTree as ET
from decimal import Decimal
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parents[2] / "apps/ai/tests/fixtures/xml_invoices"
EXPONENT = {"VND": 0, "USD": 2}
WEIGHTS = [31, 29, 23, 19, 17, 13, 7, 5, 3]
PRODUCTS = [("Dịch vụ SAMPLE", "gói"), ("Hàng hóa SAMPLE", "cái"), ("Vật tư SAMPLE", "kg")]


def tax_code(rng: random.Random, branch: bool) -> str:
    digits = [rng.randint(0, 9) for _ in range(9)]
    valid = (10 - sum(d * w for d, w in zip(digits, WEIGHTS, strict=True)) % 11) % 10
    wrong = (valid + 1) % 10  # never the real check digit, so it cannot match a real business
    code = "".join(map(str, digits)) + str(wrong)
    return f"{code}-{rng.randint(1, 999):03d}" if branch else code


def money_text(minor: int, currency: str) -> str:
    exp = EXPONENT[currency]
    return str(minor) if exp == 0 else str(Decimal(minor).scaleb(-exp))


def make_invoice(rng: random.Random, index: int) -> dict:
    currency = "USD" if index % 4 == 3 else "VND"
    rates = [rng.choice([0, 5, 8, 10]) for _ in range(rng.randint(1, 4))]
    lines = []
    for rate in rates:
        name, unit = rng.choice(PRODUCTS)
        quantity = rng.choice([1, 2, 3, 5, 10]) + rng.choice([0, 0, 0.5])
        unit_price = rng.randint(1, 900) * (100 if currency == "USD" else 1000)
        amount = int(Decimal(str(quantity)) * unit_price)
        lines.append(
            {"description": name, "quantity": quantity, "unit": unit,
             "unitPrice": unit_price, "vatRate": rate, "amount": amount}
        )
    breakdown = []
    for rate in sorted({line["vatRate"] for line in lines}):
        base = sum(line["amount"] for line in lines if line["vatRate"] == rate)
        breakdown.append({"rate": rate, "base": base, "amount": base * rate // 100})
    subtotal = sum(line["amount"] for line in lines)
    return {
        "seller": {"name": f"Công ty SAMPLE Bán {index}", "taxCode": tax_code(rng, index % 3 == 0),
                   "address": f"{index + 1} Đường Mẫu, Hà Nội"},
        "buyer": {"name": f"Công ty SAMPLE Mua {index}",
                  "taxCode": None if index % 5 == 4 else tax_code(rng, False),
                  "address": f"{index + 20} Đường Mẫu, TP.HCM"},
        "invoiceNo": f"{rng.randint(1, 9999999):07d}",
        "series": "C26TAA",
        "issueDate": f"2026-{rng.randint(1, 9):02d}-{rng.randint(1, 28):02d}",
        "currency": currency,
        "lines": lines,
        "subtotal": subtotal,
        "vatBreakdown": breakdown,
        "total": subtotal + sum(b["amount"] for b in breakdown),
    }


def render_xml(inv: dict) -> bytes:
    def add(parent: ET.Element, tag: str, text: str | None = None) -> ET.Element:
        el = ET.SubElement(parent, tag)
        if text is not None:
            el.text = text
        return el

    cur = inv["currency"]
    root = ET.Element("HDon")
    dl = add(root, "DLHDon")
    general = add(dl, "TTChung")
    add(general, "KHHDon", inv["series"])
    add(general, "SHDon", inv["invoiceNo"])
    add(general, "NLap", inv["issueDate"])
    add(general, "DVTTe", cur)
    body = add(dl, "NDHDon")
    for tag, party in (("NBan", inv["seller"]), ("NMua", inv["buyer"])):
        el = add(body, tag)
        add(el, "Ten", party["name"])
        if party["taxCode"] is not None:
            add(el, "MST", party["taxCode"])
        add(el, "DChi", party["address"])
    items = add(body, "DSHHDVu")
    for line in inv["lines"]:
        el = add(items, "HHDVu")
        add(el, "THHDVu", line["description"])
        add(el, "DVTinh", line["unit"])
        add(el, "SLuong", str(line["quantity"]))
        add(el, "DGia", money_text(line["unitPrice"], cur))
        add(el, "TSuat", f"{line['vatRate']}%")
        add(el, "ThTien", money_text(line["amount"], cur))
    total = add(body, "TToan")
    rates = add(total, "THTTLTSuat")
    for b in inv["vatBreakdown"]:
        el = add(rates, "LTSuat")
        add(el, "TSuat", f"{b['rate']}%")
        add(el, "TgTien", money_text(b["base"], cur))
        add(el, "TThue", money_text(b["amount"], cur))
    add(total, "TgTCThue", money_text(inv["subtotal"], cur))
    add(total, "TgTTTBSo", money_text(inv["total"], cur))
    ET.indent(root)
    return ET.tostring(root, encoding="UTF-8", xml_declaration=True)


def main() -> None:
    # Output dir is fixed on purpose: a path taken from the command line could write anywhere.
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for i in range(args.n):
        inv = make_invoice(rng, i)
        (OUT_DIR / f"invoice-{i:02d}.xml").write_bytes(render_xml(inv))
        (OUT_DIR / f"invoice-{i:02d}.expected.json").write_text(
            json.dumps(inv, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
