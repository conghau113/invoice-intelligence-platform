"""Synthetic invoices as data: seed + index -> ground truth and how to render it. No browser here.

Each document has its own random stream, seeded from (seed, index), so document 7 is the same for
--n 10 and --n 100. Nothing reads the clock: dates come from a fixed range, because a date relative
to "today" would change the output every day.

Synthetic data only (docs/LEGAL.md): tax codes get a WRONG check digit, every name ends in SAMPLE.
"""

import random
import unicodedata
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from functools import lru_cache
from typing import Any, Literal

from faker import Faker
from min_xml import tax_code

SUFFIX = "SAMPLE"
FIRST_DAY = date(2025, 10, 1)
LAST_DAY = date(2026, 9, 30)
LAYOUTS: dict[str, Literal["vi", "en"]] = {
    "vn-classic": "vi",
    "vn-modern": "vi",
    "vn-compact": "vi",
    "en-standard": "en",
    "en-ledger": "en",
}
FAKER_LOCALE = {"vi": "vi_VN", "en": "en_US"}

VI_ITEMS = [
    ("Dịch vụ tư vấn kế toán", "tháng"),
    ("Phí bảo trì phần mềm", "tháng"),
    ("Giấy in khổ A4", "ram"),
    ("Mực in laser đen", "hộp"),
    ("Bút bi văn phòng", "hộp"),
    ("Cà phê rang xay", "kg"),
    ("Nước uống đóng chai", "thùng"),
    ("Dịch vụ vận chuyển nội địa", "chuyến"),
    ("Dây cáp mạng", "mét"),
    ("Bàn làm việc gỗ", "cái"),
    ("Ghế xoay văn phòng", "cái"),
    ("Dịch vụ vệ sinh công nghiệp", "lần"),
    ("Thiết bị chuyển mạch", "bộ"),
    ("Sơn nước nội thất", "lít"),
    ("Xi măng xây dựng", "bao"),
    ("Thép cuộn cán nóng", "tấn"),
]
EN_ITEMS = [
    ("Accounting advisory service", "month"),
    ("Software maintenance fee", "month"),
    ("A4 copy paper", "ream"),
    ("Black laser toner", "box"),
    ("Office ballpoint pens", "box"),
    ("Ground coffee", "kg"),
    ("Bottled drinking water", "case"),
    ("Domestic freight service", "trip"),
    ("Network cable", "meter"),
    ("Wooden office desk", "pc"),
    ("Swivel office chair", "pc"),
    ("Industrial cleaning service", "visit"),
    ("Network switch", "set"),
    ("Interior wall paint", "liter"),
    ("Replacement air filter", "pc"),
    ("Steel mounting bracket", "pc"),
]


@dataclass(frozen=True)
class ImageSpec:
    """How a page is degraded on its way to a picture. `scale` 1 is 96 DPI, 2 is 192 DPI."""

    kind: Literal["png", "jpeg"]
    scale: float
    quality: int | None = None
    tilt: tuple[float, float] = (0.0, 0.0)  # smallest and largest angle in degrees
    noise: float = 0.0  # opacity of the noise layer
    blur: float = 0.0  # CSS px
    exif_rotated: bool = False  # pixels turned 90 degrees, EXIF Orientation says how to undo it


@dataclass(frozen=True)
class Variant:
    name: str
    line_range: tuple[int, int]
    image: ImageSpec | None = None


# A picture shows one page, so its line ranges must fit on one page (generate and verify check it).
VARIANTS: dict[str, tuple[Variant, ...]] = {
    "easy": (Variant("pdf-clean", (1, 5)),),
    "medium": (
        Variant("pdf-many-lines", (8, 20)),
        Variant("png-clean", (2, 6), ImageSpec("png", 2.0)),
        Variant("jpeg-tilt", (2, 6), ImageSpec("jpeg", 1.5625, 80, (1.0, 2.0))),
    ),
    "hard": (
        Variant("pdf-multi-page", (35, 60)),
        Variant("jpeg-tilt-noise", (3, 8), ImageSpec("jpeg", 1.5625, 70, (3.0, 5.0), 0.2)),
        Variant("jpeg-low-res", (3, 8), ImageSpec("jpeg", 1.0, 45, blur=0.3)),
        Variant("png-noise", (3, 8), ImageSpec("png", 1.25, noise=0.35)),
        Variant("jpeg-exif-rotated", (3, 8), ImageSpec("jpeg", 1.5625, 80, exif_rotated=True)),
    ),
}


@dataclass(frozen=True)
class Document:
    id: str
    difficulty: str
    variant: Variant
    layout: str
    locale: Literal["vi", "en"]
    invoice: dict[str, Any]
    tilt: float
    noise_seed: int


@dataclass(frozen=True)
class Party:
    name: str
    tax_code: str | None
    address: str

    def as_dict(self) -> dict[str, str | None]:
        return {"name": self.name, "taxCode": self.tax_code, "address": self.address}


def _text(value: str) -> str:
    """One line, NFC (a PDF and a parser must see the same letters)."""
    return unicodedata.normalize("NFC", " ".join(value.split()))


@lru_cache(maxsize=2)
def _faker(locale: str) -> Faker:
    return Faker(FAKER_LOCALE[locale])


def _person(fake: Faker, locale: str) -> str:
    # Not fake.name(): vi_VN adds titles like "Quý ông", which a real invoice does not print.
    if locale == "vi":
        return _text(f"{fake.last_name()} {fake.middle_name()} {fake.first_name()} {SUFFIX}")
    return _text(f"{fake.first_name()} {fake.last_name()} {SUFFIX}")


def _company(fake: Faker, rng: random.Random, branch: bool) -> Party:
    return Party(_text(f"{fake.company()} {SUFFIX}"), tax_code(rng, branch), _text(fake.address()))


@lru_cache(maxsize=4)
def _pools(seed: int) -> dict[str, tuple[tuple[Party, ...], tuple[Party, ...]]]:
    """Companies shared by many invoices, so "how much did we pay X in Q3" has an answer (M5).

    One in four sellers has a branch tax code: real runs show models dropping that suffix (T3.7).
    """
    pools = {}
    for locale, sellers, buyers in (("vi", 8, 5), ("en", 4, 3)):
        rng = random.Random(f"{seed}:parties:{locale}")
        fake = _faker(locale)
        fake.seed_instance(f"{seed}:parties:{locale}")
        pools[locale] = (
            tuple(_company(fake, rng, i % 4 == 0) for i in range(sellers)),
            tuple(_company(fake, rng, False) for _ in range(buyers)),
        )
    return pools


def _amount(quantity: float, unit_price: int) -> int:
    exact = Decimal(str(quantity)) * unit_price
    return int(exact.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _quantity(rng: random.Random) -> int | float:
    whole = rng.randint(1, 20)
    return rng.choice([whole, whole, whole, whole + 0.5, whole + 0.25])


def _lines(
    rng: random.Random, locale: str, currency: str, count: int, rates: list[int]
) -> list[dict[str, Any]]:
    catalogue = VI_ITEMS if locale == "vi" else EN_ITEMS
    lines = []
    for _ in range(count):
        name, unit = rng.choice(catalogue)
        quantity = _quantity(rng)
        unit_price = rng.randint(150, 90_000) if currency == "USD" else rng.randint(4, 1_800) * 500
        lines.append(
            {
                # The code keeps descriptions different on a long invoice, like a real SKU would.
                "description": f"{name} {rng.choice('ABCDEHKMNPRT')}{rng.randint(1000, 9999)}",
                "quantity": quantity,
                "unit": unit,
                "unitPrice": unit_price,
                "vatRate": rng.choice(rates),
                "amount": _amount(quantity, unit_price),
            }
        )
    return lines


def _invoice(seed: int, index: int, locale: str, variant: Variant) -> dict[str, Any]:
    # Pools first: building them reseeds this same Faker, which on a cache miss would otherwise
    # replace the seed below and change the individual buyer of this document.
    sellers, buyers = _pools(seed)[locale]
    fake = _faker(locale)
    fake.seed_instance(f"{seed}:{index}:people")
    rng = random.Random(f"{seed}:{index}:invoice")
    return _draw_invoice(rng, fake, sellers, buyers, locale, variant)


def _draw_invoice(
    rng: random.Random,
    fake: Faker,
    sellers: tuple[Party, ...],
    buyers: tuple[Party, ...],
    locale: str,
    variant: Variant,
) -> dict[str, Any]:
    seller = rng.choice(sellers)
    if rng.random() < 0.15:  # an individual buyer has no tax code (T2.7)
        buyer = Party(_person(fake, locale), None, _text(fake.address()))
    else:
        buyer = rng.choice(buyers)
    currency_is_usd = rng.random() < (0.15 if locale == "vi" else 0.8)
    currency = "USD" if currency_is_usd else "VND"
    issue = date.fromordinal(rng.randint(FIRST_DAY.toordinal(), LAST_DAY.toordinal()))
    year = issue.year % 100
    rates = [rng.choice([0, 5, 8, 10])] if rng.random() < 0.7 else rng.sample([0, 5, 8, 10], 2)
    lines = _lines(rng, locale, currency, rng.randint(*variant.line_range), rates)
    breakdown = []
    for rate in sorted({line["vatRate"] for line in lines}):
        base = sum(line["amount"] for line in lines if line["vatRate"] == rate)
        breakdown.append({"rate": rate, "base": base, "amount": (base * rate + 50) // 100})
    subtotal = sum(line["amount"] for line in lines)
    number = rng.randint(1, 9_999_999)
    return {
        "seller": seller.as_dict(),
        "buyer": buyer.as_dict(),
        "invoiceNo": f"{number:07d}" if locale == "vi" else f"INV-{year}{number:07d}",
        "series": f"C{year}T{rng.choice('ABCDE')}{rng.choice('ABCDE')}"
        if locale == "vi"
        else f"S{year}{rng.choice('ABCDE')}",
        "issueDate": issue.isoformat(),
        "currency": currency,
        "lines": lines,
        "subtotal": subtotal,
        "vatBreakdown": breakdown,
        "total": subtotal + sum(item["amount"] for item in breakdown),
        # Key present and empty: the file is a full Invoice for InvoiceSchema (AI_PIPELINE.md §3).
        "fieldMeta": {},
    }


def _bucket(index: int) -> tuple[str, int]:
    """Difficulty by position: exactly 40/40/20 per 100, and any prefix keeps that mix."""
    block, slot = divmod(index, 5)
    if slot == 4:
        return "hard", block
    position = block * 2 + (slot // 2)
    return ("easy", position) if slot % 2 == 0 else ("medium", position)


def _draw_render(rng: random.Random, variant: Variant) -> tuple[float, int]:
    tilt = 0.0
    if variant.image is not None and variant.image.tilt != (0.0, 0.0):
        tilt = round(rng.uniform(*variant.image.tilt) * rng.choice([-1, 1]), 2)
    return tilt, rng.randint(1, 1_000_000)


def build_document(seed: int, index: int) -> Document:
    difficulty, position = _bucket(index)
    options = VARIANTS[difficulty]
    variant = options[position % len(options)]
    # The block terms stop a layout from always pairing with the same difficulty or variant.
    names = list(LAYOUTS)
    layout = names[(index + index // 5 + index // 25) % len(names)]
    locale = LAYOUTS[layout]
    tilt, noise_seed = _draw_render(random.Random(f"{seed}:{index}:render"), variant)
    return Document(
        id=f"invoice-{index:04d}",
        difficulty=difficulty,
        variant=variant,
        layout=layout,
        locale=locale,
        invoice=_invoice(seed, index, locale, variant),
        tilt=tilt,
        noise_seed=noise_seed,
    )
