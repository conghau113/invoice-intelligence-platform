"""CLI: `pnpm gen:invoices:verify` checks the generated files themselves, exit 1 on any problem.

It reads what was written, not what the generator meant to write, and the check digit is computed
here on its own: a bug in the generator must not hide inside its own checker. Output is document ids
and fixed codes, never document content (CLAUDE.md).
"""

import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "apps/ai"))

import pypdfium2  # noqa: E402
import pypdfium2.raw as pdfium_c  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app.schemas.generated import Invoice  # noqa: E402
from app.services.extract import MAX_TOTAL_IMAGE_BYTES  # noqa: E402
from app.services.pdf_pages import PdfError, render_pdf_pages, sniff_image_mime  # noqa: E402
from app.services.xml_invoice import XmlInvoiceError, parse_xml_invoice  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent / "out"
WATERMARK = "SAMPLE – SYNTHETIC DATA"
SUFFIX = "SAMPLE"
MST_WEIGHTS = (31, 29, 23, 19, 17, 13, 7, 5, 3)
MST_TOKEN = re.compile(r"(?<![0-9])[0-9]{10}(?:-[0-9]{3})?(?![0-9])")
NUMBER_TOKEN = re.compile(r"(?<![0-9A-Za-z])[0-9](?:[0-9.,]*[0-9])?(?![0-9A-Za-z])")
MONTHS = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
]  # fmt: skip
ALLOWED_FONTS = {"Tinos", "Arimo"}
MAX_FILE_BYTES = 10 * 1024 * 1024  # the upload cap of the API and the AI service


@dataclass
class Report:
    problems: list[tuple[str, str]] = field(default_factory=list)
    documents: int = 0
    tax_codes: int = 0
    pages: int = 0

    def add(self, doc_id: str, code: str) -> None:
        self.problems.append((doc_id, code))


def passes_check_digit(code: str) -> bool:
    """Would a real Vietnamese tax code have this check digit? Ours must always answer False.

    The tenth digit is 10 - (sum of the first nine digits times the weights) mod 11. When that gives
    10 no such digit exists; it counts as 0 here, the stricter reading, as `min_xml.tax_code` does.
    """
    digits = [int(char) for char in code[:10]]
    remainder = sum(d * w for d, w in zip(digits[:9], MST_WEIGHTS, strict=True)) % 11
    return (10 - remainder) % 10 == digits[9]


def _compact(text: str) -> str:
    return "".join(unicodedata.normalize("NFC", text).split())


def check_tax_code(report: Report, doc_id: str, code: str) -> None:
    report.tax_codes += 1
    if passes_check_digit(code):
        report.add(doc_id, "TAX_CODE_HAS_REAL_CHECK_DIGIT")


def check_ground_truth(report: Report, doc_id: str, invoice: dict[str, Any]) -> None:
    try:
        Invoice.model_validate(invoice)
    except ValidationError:
        report.add(doc_id, "GROUND_TRUTH_NOT_AN_INVOICE")
        return
    for party in (invoice["seller"], invoice["buyer"]):
        if not party["name"].endswith(f" {SUFFIX}"):
            report.add(doc_id, "NAME_WITHOUT_SAMPLE_SUFFIX")
        if party["taxCode"] is not None:
            check_tax_code(report, doc_id, party["taxCode"])


def check_xml(report: Report, doc_id: str, xml: bytes, invoice: dict[str, Any]) -> None:
    try:
        parsed = parse_xml_invoice(xml)
    except XmlInvoiceError:
        report.add(doc_id, "XML_REFUSED_BY_PARSER")
        return
    answer = {key: value for key, value in invoice.items() if key != "fieldMeta"}
    if {key: value for key, value in parsed.items() if key != "fieldMeta"} != answer:
        report.add(doc_id, "XML_DIFFERS_FROM_GROUND_TRUTH")


def _pdf_fonts(pdf: bytes) -> set[str]:
    """Font families of a PDF, embedded subsets (ABCDEF+Tinos-Bold) and plain names (Helvetica)."""
    names = re.findall(rb"/BaseFont\s*/(?:[A-Z]{6}\+)?([^\s/<>\[\]()]+)", pdf)
    return {name.decode().split("-")[0] for name in names}


def page_text(page: Any) -> tuple[str, str]:
    """The upright text of a page and its rotated text (the watermark).

    Separated by the angle of each character. Asking for the whole page's text mixes the two when
    the diagonal watermark crosses a line ("S", "N", "A" land between other words).
    """
    textpage = page.get_textpage()
    upright, rotated = [], []
    try:
        for index in range(pdfium_c.FPDFText_CountChars(textpage)):
            char = chr(pdfium_c.FPDFText_GetUnicode(textpage, index))
            angle = pdfium_c.FPDFText_GetCharAngle(textpage, index)
            (rotated if angle > 0.01 else upright).append(char)
    finally:
        textpage.close()
    return "".join(upright), "".join(rotated)


def _printed_number(value: float) -> int:
    """A number as digits without marks: 1.234,56 and 1,234.56 both read 123456, 2.5 reads 25."""
    return int(format(Decimal(str(value)).normalize(), "f").replace(".", ""))


def _date_forms(iso: str) -> list[str]:
    year, month, day = iso.split("-")
    return [
        f"{day}/{month}/{year}",
        f"Ngày {day} tháng {month} năm {year}",
        f"{MONTHS[int(month) - 1]} {int(day)}, {year}",
    ]


def answer_problems(text: str, invoice: dict[str, Any]) -> list[str]:
    """Is every field of the answer on the page? If not, eval would blame the model for a template.

    Numbers are compared as whole tokens and counted, so digits of neighbouring cells cannot add up
    to an amount, and a dropped column shows even when another cell holds the same value. Limit: a
    small whole quantity can be matched by a row number on one document; across a dataset a dropped
    column still shows, because many quantities are decimal or large.
    """
    problems = []
    parties = (invoice["seller"], invoice["buyer"])
    codes = [party["taxCode"] for party in parties if party["taxCode"] is not None]
    tokens = MST_TOKEN.findall(text)
    if any(code not in tokens for code in codes):  # wrapped: the scan above could not have seen it
        problems.append("TAX_CODE_SPLIT_ON_PAGE")
    compact = _compact(text)
    lines = invoice["lines"]
    expected_text = [
        *(value for party in parties for value in party.values() if value is not None),
        invoice["invoiceNo"],
        invoice["series"],
        invoice["currency"],
        *(line["description"] for line in lines),
        *(line["unit"] for line in lines),
    ]
    missing_text = any(_compact(value) not in compact for value in expected_text)
    missing_date = not any(_compact(form) in compact for form in _date_forms(invoice["issueDate"]))
    numbers = [invoice["subtotal"], invoice["total"]]
    for line in lines:
        numbers += [line["quantity"], line["unitPrice"], line["vatRate"], line["amount"]]
    for item in invoice["vatBreakdown"]:
        numbers += [item["rate"], item["base"], item["amount"]]
    printed = Counter(int(re.sub(r"[.,]", "", token)) for token in NUMBER_TOKEN.findall(text))
    missing_number = Counter(_printed_number(value) for value in numbers) - printed
    if missing_text or missing_date or missing_number:
        problems.append("GROUND_TRUTH_NOT_ON_THE_PAGE")
    return problems


def check_pdf(report: Report, doc_id: str, pdf: bytes, invoice: dict[str, Any], pages: int) -> None:
    document = pypdfium2.PdfDocument(pdf)
    texts = []
    try:
        for page in document:
            upright, rotated = page_text(page)
            texts.append(upright)
            if _compact(WATERMARK) not in _compact(rotated):
                report.add(doc_id, "PAGE_WITHOUT_WATERMARK")
            page.close()
    finally:
        document.close()
    report.pages += len(texts)
    if len(texts) != pages:
        report.add(doc_id, "MANIFEST_PAGE_COUNT_WRONG")
    if not _pdf_fonts(pdf) or not _pdf_fonts(pdf) <= ALLOWED_FONTS:
        report.add(doc_id, "PDF_USES_A_FONT_OUTSIDE_THE_REPO")
    whole = "\n".join(texts)
    # Every 10-digit token on the page, not only the ones the ground truth names.
    for token in MST_TOKEN.findall(whole):
        check_tax_code(report, doc_id, token)
    for code in answer_problems(whole, invoice):
        report.add(doc_id, code)


def check_fits_pipeline(report: Report, doc_id: str, primary: bytes, is_pdf: bool) -> None:
    """Calls the real limits of apps/ai, so a document never fails eval for being out of bounds."""
    if len(primary) > MAX_FILE_BYTES:
        report.add(doc_id, "FILE_OVER_UPLOAD_LIMIT")
    if not is_pdf:
        if sniff_image_mime(primary) is None:
            report.add(doc_id, "IMAGE_NOT_RECOGNISED")
        if len(primary) > MAX_TOTAL_IMAGE_BYTES:
            report.add(doc_id, "IMAGE_OVER_PROVIDER_LIMIT")
        return
    try:
        rendered = render_pdf_pages(primary)
    except PdfError:
        report.add(doc_id, "PDF_REFUSED_BY_PIPELINE")
        return
    if sum(len(page) for page in rendered) > MAX_TOTAL_IMAGE_BYTES:
        report.add(doc_id, "PDF_OVER_PROVIDER_LIMIT")


def check_document(report: Report, root: Path, entry: dict[str, Any]) -> None:
    doc_id = entry["id"]
    contents: dict[str, bytes] = {}
    for name, expected_hash in entry["files"].items():
        path = root / name
        if not path.is_file():
            report.add(doc_id, "FILE_MISSING")
            return
        contents[name] = path.read_bytes()
        if hashlib.sha256(contents[name]).hexdigest() != expected_hash:
            report.add(doc_id, "HASH_MISMATCH")
    required = [f"{doc_id}.expected.json", f"{doc_id}.xml", f"{doc_id}.pdf", entry["primary"]]
    if any(name not in contents for name in required):
        report.add(doc_id, "FILE_NOT_IN_MANIFEST")
        return
    invoice = json.loads(contents[f"{doc_id}.expected.json"])
    check_ground_truth(report, doc_id, invoice)
    check_xml(report, doc_id, contents[f"{doc_id}.xml"], invoice)
    check_pdf(report, doc_id, contents[f"{doc_id}.pdf"], invoice, entry["pages"])
    is_pdf = entry["primary"].endswith(".pdf")
    if not is_pdf and entry["pages"] != 1:
        report.add(doc_id, "IMAGE_OF_A_MULTI_PAGE_DOCUMENT")
    check_fits_pipeline(report, doc_id, contents[entry["primary"]], is_pdf)


def verify_dataset(root: Path) -> Report:
    report = Report()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        report.add("dataset", "MANIFEST_MISSING")
        return report
    documents = json.loads(manifest_path.read_text(encoding="utf-8"))["documents"]
    if not documents:  # an empty dataset must not pass by having nothing to check
        report.add("dataset", "NO_DOCUMENTS")
    for entry in documents:
        report.documents += 1
        check_document(report, root, entry)
    listed = {name for entry in documents for name in entry["files"]} | {"manifest.json"}
    for path in root.iterdir():
        if path.name not in listed:
            report.add("dataset", "FILE_NOT_IN_MANIFEST")
    return report


def main() -> int:
    report = verify_dataset(OUT_DIR)
    for doc_id, code in report.problems:
        print(f"{doc_id} {code}")
    print(
        f"documents={report.documents} pages={report.pages} tax_codes_checked={report.tax_codes} "
        f"problems={len(report.problems)}"
    )
    return 1 if report.problems else 0


if __name__ == "__main__":
    sys.exit(main())
