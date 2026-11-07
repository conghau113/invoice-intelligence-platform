"""The synthetic invoice generator without a browser: data, XML, HTML, the checker. Runs in CI.

The browser half (PDF, pictures, repeatability of the bytes) is in test_invoice_gen_render.py.
"""

import html as html_module
import importlib
import random
import re
import struct
import sys
from collections import Counter
from collections.abc import Iterator
from dataclasses import replace
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.schemas.generated import Invoice
from app.services.xml_invoice import parse_xml_invoice

GENERATOR_DIR = Path(__file__).resolve().parents[3] / "tools" / "invoice-gen"
GENERATOR_MODULES = ("gen_data", "gen_render", "generate", "verify", "min_xml")


@pytest.fixture(scope="module")
def gen() -> Iterator[SimpleNamespace]:
    # Not monkeypatch: this fixture lives for the module, and the 100 documents are slow to rebuild.
    sys.path.insert(0, str(GENERATOR_DIR))
    try:
        yield SimpleNamespace(
            data=importlib.import_module("gen_data"),
            render=importlib.import_module("gen_render"),
            generate=importlib.import_module("generate"),
            verify=importlib.import_module("verify"),
        )
    finally:
        sys.path.remove(str(GENERATOR_DIR))
        # test_injection.py imports min_xml through its own path: leave no name behind for it.
        for name in GENERATOR_MODULES:
            sys.modules.pop(name, None)


@pytest.fixture(scope="module")
def documents(gen: SimpleNamespace) -> list[Any]:
    return [gen.data.build_document(42, index) for index in range(100)]


def valid_code() -> str:
    """Passes the check digit. Only for testing the checker that must refuse it."""
    return "9" * 9 + str(10 - (9 * 147) % 11)  # 147 is the sum of the nine weights


def answer(invoice: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in invoice.items() if key != "fieldMeta"}


# ---- repeatable ----------------------------------------------------------------------------------


def test_same_seed_gives_the_same_document_and_another_seed_does_not(gen: SimpleNamespace) -> None:
    first = gen.data.build_document(42, 7)
    assert gen.data.build_document(42, 7) == first
    assert gen.data.build_document(43, 7).invoice != first.invoice


def test_a_document_does_not_depend_on_what_was_built_before_it(gen: SimpleNamespace) -> None:
    alone = gen.data.build_document(42, 30)
    for index in range(30):
        gen.data.build_document(99, index)  # another seed moves any random state that is shared
    assert gen.data.build_document(42, 30) == alone


def test_a_document_is_the_same_whether_or_not_the_company_pool_is_cached(
    gen: SimpleNamespace, documents: list[Any]
) -> None:
    """Building the pool reseeds the shared Faker. Seed 42 hid this: document 0 has a company."""
    for doc, index in zip(documents, range(len(documents)), strict=True):
        gen.data._pools.cache_clear()
        assert gen.data.build_document(42, index) == doc, doc.id


def test_committed_samples_are_what_the_generator_produces(gen: SimpleNamespace) -> None:
    """Catches a Faker upgrade or a change in the data, without Chromium."""
    files = gen.generate.golden_files()
    assert len(files) == 2 * gen.generate.GOLDEN_COUNT
    for name, content in files.items():
        assert (gen.generate.GOLDEN_DIR / name).read_bytes() == content, name


# ---- what T4.2 to T5.6 rely on -------------------------------------------------------------------


def test_one_hundred_documents_are_split_40_40_20(documents: list[Any]) -> None:
    assert Counter(d.difficulty for d in documents) == {"easy": 40, "medium": 40, "hard": 20}


def test_every_difficulty_sees_every_layout(gen: SimpleNamespace, documents: list[Any]) -> None:
    for difficulty in ("easy", "medium", "hard"):
        seen = {d.layout for d in documents if d.difficulty == difficulty}
        assert seen == set(gen.data.LAYOUTS)


def test_every_variant_exists_and_is_not_tied_to_one_layout(
    gen: SimpleNamespace, documents: list[Any]
) -> None:
    for variants in gen.data.VARIANTS.values():
        for variant in variants:
            layouts = {d.layout for d in documents if d.variant == variant}
            assert len(layouts) >= 2, variant.name


def test_the_data_has_the_hard_cases_later_tasks_measure(documents: list[Any]) -> None:
    invoices = [d.invoice for d in documents]
    assert {i["currency"] for i in invoices} == {"VND", "USD"}
    assert {d.locale for d in documents} == {"vi", "en"}
    assert any("-" in i["seller"]["taxCode"] for i in invoices), "branch code: T4.4 measures it"
    assert any(i["buyer"]["taxCode"] is None for i in invoices), "individual buyer"
    assert any(len(i["vatBreakdown"]) > 1 for i in invoices), "several VAT rates"
    assert any(line["quantity"] % 1 for i in invoices for line in i["lines"]), "decimal quantity"
    assert max(len(i["lines"]) for i in invoices) >= 35, "long invoice"


def test_companies_repeat_so_aggregate_questions_have_answers(documents: list[Any]) -> None:
    per_seller = Counter(d.invoice["seller"]["name"] for d in documents)
    assert len(per_seller) <= 12
    assert min(per_seller.values()) >= 3
    # T5.x demo: "how much in September for supplier X".
    september = [d for d in documents if d.invoice["issueDate"][:7] == "2026-09"]
    assert september, "the M5 demo question needs invoices in September"


def test_dates_stay_in_the_fixed_range(gen: SimpleNamespace, documents: list[Any]) -> None:
    """A date after today would raise ISSUE_DATE_FUTURE, and a clock would break repeatability."""
    for doc in documents:
        issued = date.fromisoformat(doc.invoice["issueDate"])
        assert gen.data.FIRST_DAY <= issued <= gen.data.LAST_DAY
    # Fails if someone moves the range past the day it was chosen: such a date could become future.
    assert date(2026, 11, 7) > gen.data.LAST_DAY


def test_pictures_only_come_from_short_invoices(gen: SimpleNamespace) -> None:
    """A picture holds one page; the 8-line limit is what keeps a document on one page."""
    for variants in gen.data.VARIANTS.values():
        for variant in variants:
            if variant.image is not None:
                assert variant.line_range[1] <= 8, variant.name


# ---- ground truth is valid and matches its XML ---------------------------------------------------


def test_every_ground_truth_is_a_valid_invoice(documents: list[Any]) -> None:
    for doc in documents:
        Invoice.model_validate(doc.invoice)
        assert doc.invoice["fieldMeta"] == {}


def test_the_xml_of_every_document_parses_back_to_its_ground_truth(
    gen: SimpleNamespace, documents: list[Any]
) -> None:
    for doc in documents:
        parsed = parse_xml_invoice(gen.render.xml_bytes(doc.invoice))
        assert answer(parsed) == answer(doc.invoice), doc.id


def test_the_sums_agree(documents: list[Any]) -> None:
    for doc in documents:
        invoice = doc.invoice
        assert sum(line["amount"] for line in invoice["lines"]) == invoice["subtotal"]
        vat = sum(item["amount"] for item in invoice["vatBreakdown"])
        assert invoice["subtotal"] + vat == invoice["total"]


# ---- legally safe --------------------------------------------------------------------------------


def test_no_tax_code_passes_the_check_digit(gen: SimpleNamespace, documents: list[Any]) -> None:
    report = gen.verify.Report()
    for doc in documents:
        gen.verify.check_ground_truth(report, doc.id, doc.invoice)
    assert report.tax_codes >= 150
    assert report.problems == []


def test_the_check_digit_function_knows_a_valid_code(gen: SimpleNamespace) -> None:
    # Worked on paper with an obviously made-up prefix: nines times the weights give 1323,
    # 1323 mod 11 = 3, 10 - 3 = 7. Built here, so no code with a valid digit sits in the repository.
    code = valid_code()
    assert code[-1] == "7"
    assert gen.verify.passes_check_digit(code)
    assert gen.verify.passes_check_digit(f"{code}-001")
    assert not gen.verify.passes_check_digit("9999999998")


def test_a_prefix_whose_check_digit_would_be_ten_counts_zero_as_passing(
    gen: SimpleNamespace,
) -> None:
    # The sum is 0, so the digit would be 10. Stricter than the real rule on purpose.
    assert gen.verify.passes_check_digit("0000000000")
    for last in range(1, 10):
        assert not gen.verify.passes_check_digit(f"000000000{last}")


def test_the_generator_never_writes_a_code_the_checker_refuses(gen: SimpleNamespace) -> None:
    """Includes the prefixes whose real digit would be 10, the edge of the stricter reading."""
    rng = random.Random(1)
    for _ in range(5000):
        assert not gen.verify.passes_check_digit(gen.data.tax_code(rng, False))


def test_checker_rejects_a_real_check_digit(gen: SimpleNamespace, documents: list[Any]) -> None:
    invoice = {**documents[0].invoice, "seller": {**documents[0].invoice["seller"]}}
    invoice["seller"]["taxCode"] = valid_code()
    report = gen.verify.Report()
    gen.verify.check_ground_truth(report, "doc", invoice)
    assert report.problems == [("doc", "TAX_CODE_HAS_REAL_CHECK_DIGIT")]


@pytest.mark.parametrize("party", ["seller", "buyer"])
def test_checker_rejects_a_name_without_the_suffix(
    gen: SimpleNamespace, documents: list[Any], party: str
) -> None:
    invoice = {**documents[0].invoice, party: {**documents[0].invoice[party], "name": "Công ty A"}}
    report = gen.verify.Report()
    gen.verify.check_ground_truth(report, "doc", invoice)
    assert report.problems == [("doc", "NAME_WITHOUT_SAMPLE_SUFFIX")]


def test_checker_rejects_xml_that_differs_from_the_answer(
    gen: SimpleNamespace, documents: list[Any]
) -> None:
    invoice = documents[0].invoice
    report = gen.verify.Report()
    gen.verify.check_xml(report, "doc", gen.render.xml_bytes(invoice), {**invoice, "total": 1})
    assert report.problems == [("doc", "XML_DIFFERS_FROM_GROUND_TRUTH")]


# ---- the answer is on the page ------------------------------------------------------------------


def page_like_text(gen: SimpleNamespace, doc: Any) -> str:
    """What the page says, without a browser: the HTML with style and tags removed."""
    html = re.sub(r"<style.*?</style>", " ", gen.render.render_html(doc), flags=re.DOTALL)
    return html_module.unescape(re.sub(r"<[^>]+>", " ", html))


@pytest.mark.parametrize(
    "layout", ["vn-classic", "vn-modern", "vn-compact", "en-standard", "en-ledger"]
)
def test_every_layout_shows_the_whole_answer(
    gen: SimpleNamespace, documents: list[Any], layout: str
) -> None:
    for doc in (d for d in documents if d.layout == layout):
        assert gen.verify.answer_problems(page_like_text(gen, doc), doc.invoice) == [], doc.id


@pytest.mark.parametrize("field", ["quantity", "unitPrice", "unit"])
def test_a_column_missing_from_the_page_is_reported(
    gen: SimpleNamespace, documents: list[Any], field: str
) -> None:
    # A decimal quantity: a small whole one can be matched by a row number (see answer_problems).
    doc, line = next((d, ln) for d in documents for ln in d.invoice["lines"] if ln["quantity"] % 1)
    fmt = gen.render.Formats(doc.locale, doc.invoice["currency"])
    shown = {
        "quantity": fmt.quantity(line["quantity"]),
        "unitPrice": fmt.money(line["unitPrice"]),
        "unit": line["unit"],
    }[field]
    text = re.sub(rf"(?<![\w.,]){re.escape(shown)}(?![\w.,])", " ", page_like_text(gen, doc))
    assert gen.verify.answer_problems(text, doc.invoice) == ["GROUND_TRUTH_NOT_ON_THE_PAGE"]


def test_a_date_missing_from_the_page_is_reported(
    gen: SimpleNamespace, documents: list[Any]
) -> None:
    doc = documents[0]
    moved = {**doc.invoice, "issueDate": "2020-01-02"}
    problems = gen.verify.answer_problems(page_like_text(gen, doc), moved)
    assert problems == ["GROUND_TRUTH_NOT_ON_THE_PAGE"]


def test_digits_of_neighbouring_cells_do_not_add_up_to_an_amount(
    gen: SimpleNamespace, documents: list[Any]
) -> None:
    doc = documents[0]
    text = page_like_text(gen, doc)
    glued = {**doc.invoice, "total": int(f"{doc.invoice['subtotal']}{doc.invoice['total']}")}
    assert gen.verify.answer_problems(text, glued) == ["GROUND_TRUTH_NOT_ON_THE_PAGE"]


def test_a_tax_code_broken_across_lines_is_reported(
    gen: SimpleNamespace, documents: list[Any]
) -> None:
    doc = documents[0]
    code = doc.invoice["seller"]["taxCode"]
    text = page_like_text(gen, doc).replace(code, f"{code[:5]}\r\n{code[5:]}")
    assert "TAX_CODE_SPLIT_ON_PAGE" in gen.verify.answer_problems(text, doc.invoice)


def test_fonts_are_read_with_or_without_a_subset_prefix(gen: SimpleNamespace) -> None:
    pdf = b"<< /BaseFont /ABCDEF+Tinos-Bold >> << /BaseFont /Helvetica >> /BaseFont/GHIJKL+Arimo"
    assert gen.verify._pdf_fonts(pdf) == {"Tinos", "Helvetica", "Arimo"}


# ---- HTML ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "layout", ["vn-classic", "vn-modern", "vn-compact", "en-standard", "en-ledger"]
)
def test_every_layout_prints_the_watermark_and_each_field(
    gen: SimpleNamespace, documents: list[Any], layout: str
) -> None:
    doc = next(d for d in documents if d.layout == layout)
    html = gen.render.render_html(doc)
    assert f'<div class="wm">{gen.render.WATERMARK}</div>' in html
    invoice = doc.invoice
    fmt = gen.render.Formats(doc.locale, invoice["currency"])
    assert invoice["seller"]["taxCode"] in html
    assert invoice["series"] in html
    assert invoice["invoiceNo"] in html
    assert fmt.money(invoice["total"]) in html


def test_document_text_cannot_become_markup(gen: SimpleNamespace, documents: list[Any]) -> None:
    doc = documents[0]
    line = {**doc.invoice["lines"][0], "description": "<script>alert(1)</script>"}
    tampered = replace(doc, invoice={**doc.invoice, "lines": [line]})
    html = gen.render.render_html(tampered)
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


@pytest.mark.parametrize(
    ("locale", "currency", "minor", "expected"),
    [
        ("vi", "VND", 1234567, "1.234.567"),
        ("en", "VND", 1234567, "1,234,567"),
        ("vi", "USD", 123456, "1.234,56"),
        ("en", "USD", 123405, "1,234.05"),
        ("en", "USD", 5, "0.05"),
        ("vi", "VND", 0, "0"),
    ],
)
def test_money_is_printed_the_way_the_language_writes_it(
    gen: SimpleNamespace, locale: str, currency: str, minor: int, expected: str
) -> None:
    assert gen.render.Formats(locale, currency).money(minor) == expected


def test_quantity_has_no_trailing_zeros_and_a_local_decimal_mark(gen: SimpleNamespace) -> None:
    assert gen.render.Formats("vi", "VND").quantity(10) == "10"
    assert gen.render.Formats("vi", "VND").quantity(2.5) == "2,5"
    assert gen.render.Formats("en", "USD").quantity(2.25) == "2.25"
    assert gen.render.Formats("en", "USD").quantity(20.0) == "20"


# ---- byte tricks ---------------------------------------------------------------------------------


def test_pdf_dates_become_fixed_without_moving_any_byte(gen: SimpleNamespace) -> None:
    pdf = (
        b"%PDF\n/CreationDate (D:20261107093901+00'00')\n/ModDate (D:20261107093901+00'00')>>\nEOF"
    )
    out = gen.render.normalize_pdf_dates(pdf)
    assert len(out) == len(pdf)
    assert out.count(gen.render.FIXED_PDF_DATE) == 2
    assert b"2026110709" not in out


@pytest.mark.parametrize(
    "pdf",
    [
        b"%PDF no dates at all",
        b"/CreationDate (D:20261107093901+00'00') only one",
        b"/CreationDate (D:2026) /ModDate (D:2026)",  # another length would shift the offsets
    ],
)
def test_a_pdf_with_unexpected_dates_stops_the_run(gen: SimpleNamespace, pdf: bytes) -> None:
    with pytest.raises(gen.render.RenderError, match="PDF_DATE_FORMAT_CHANGED"):
        gen.render.normalize_pdf_dates(pdf)


def test_exif_block_holds_the_orientation_and_keeps_the_picture(gen: SimpleNamespace) -> None:
    jpeg = b"\xff\xd8\xff\xe0\x00\x04ab\xff\xd9"
    out = gen.render.add_exif_orientation(jpeg, 6)
    assert out[:4] == b"\xff\xd8\xff\xe1"
    length = struct.unpack(">H", out[4:6])[0]
    body = out[6 : 4 + length]
    assert body[:6] == b"Exif\x00\x00"
    tiff = body[6:]
    assert tiff[:2] == b"MM"
    tag, kind, count, value = struct.unpack(">HHIH", tiff[10:20])
    assert (tag, kind, count, value) == (0x0112, 3, 1, 6)
    assert out[4 + length :] == jpeg[2:]


def test_exif_refuses_a_file_that_is_not_a_jpeg(gen: SimpleNamespace) -> None:
    with pytest.raises(gen.render.RenderError, match="NOT_A_JPEG"):
        gen.render.add_exif_orientation(b"\x89PNG", 6)
