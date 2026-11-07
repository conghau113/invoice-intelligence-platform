"""The generator with a real Chromium: `pnpm test:invoice-gen` (also part of `pnpm check:full`).

Not in CI: the generator only runs by hand and T4.2 pins its output by hash. The marker keeps these
out of a plain `pytest` on purpose, instead of skipping them when Playwright is missing, which could
hide them forever.
"""

import hashlib
import importlib
import json
import shutil
import struct
import subprocess
import sys
from collections.abc import Callable, Iterator
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

pytestmark = pytest.mark.browser

REPO = Path(__file__).resolve().parents[3]
GENERATOR_DIR = REPO / "tools" / "invoice-gen"
# Enough documents for one of each difficulty and picture kind, including the multi-page PDF.
DATASET_SIZE = 25


@pytest.fixture(scope="module")
def gen() -> Iterator[SimpleNamespace]:
    sys.path.insert(0, str(GENERATOR_DIR))
    try:
        yield SimpleNamespace(
            data=importlib.import_module("gen_data"),
            render=importlib.import_module("gen_render"),
            generate=importlib.import_module("generate"),
            verify=importlib.import_module("verify"),
            min_pdf=importlib.import_module("min_pdf"),
        )
    finally:
        sys.path.remove(str(GENERATOR_DIR))
        for name in ("gen_data", "gen_render", "generate", "verify", "min_pdf", "min_xml"):
            sys.modules.pop(name, None)


@pytest.fixture(scope="module")
def renderer(gen: SimpleNamespace) -> Iterator[Any]:
    with gen.render.open_renderer() as opened:
        yield opened


@pytest.fixture(scope="module")
def clean_dataset(gen: SimpleNamespace, tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("dataset") / "out"
    gen.generate.generate(root, 42, DATASET_SIZE)
    return root


@pytest.fixture
def dataset(clean_dataset: Path, tmp_path: Path) -> Path:
    """A private copy each test can damage."""
    return Path(shutil.copytree(clean_dataset, tmp_path / "out"))


def manifest(root: Path) -> dict[str, Any]:
    return json.loads((root / "manifest.json").read_text(encoding="utf-8"))


def find(root: Path, variant: str) -> dict[str, Any]:
    return next(d for d in manifest(root)["documents"] if d["variant"] == variant)


def replace_file(root: Path, doc_id: str, name: str, content: bytes) -> None:
    """Writes the file and fixes its hash, so only the check under test can object."""
    (root / name).write_bytes(content)
    data = manifest(root)
    entry = next(d for d in data["documents"] if d["id"] == doc_id)
    entry["files"][name] = hashlib.sha256(content).hexdigest()
    (root / "manifest.json").write_text(json.dumps(data), encoding="utf-8")


def codes(gen: SimpleNamespace, root: Path) -> set[str]:
    return {code for _, code in gen.verify.verify_dataset(root).problems}


def jpeg_stored_size(jpeg: bytes) -> tuple[int, int]:
    """Width and height of the pixels as stored, read from the frame header (ignores EXIF)."""
    index = 2
    while index < len(jpeg):
        marker = jpeg[index + 1]
        length = struct.unpack(">H", jpeg[index + 2 : index + 4])[0]
        if marker in (0xC0, 0xC2):
            height, width = struct.unpack(">HH", jpeg[index + 5 : index + 9])
            return width, height
        index += 2 + length
    raise AssertionError("no frame header")


# ---- the same seed gives the same bytes ----------------------------------------------------------


def test_the_same_seed_writes_the_same_bytes_and_another_seed_does_not(
    gen: SimpleNamespace, clean_dataset: Path, tmp_path: Path
) -> None:
    """Includes pictures and the multi-page PDF, and a run seconds later (the PDF date changes)."""
    again = tmp_path / "again"
    gen.generate.generate(again, 42, DATASET_SIZE)
    names = sorted(path.name for path in clean_dataset.iterdir())
    assert names == sorted(path.name for path in again.iterdir())
    for name in names:
        assert (clean_dataset / name).read_bytes() == (again / name).read_bytes(), name
    other = tmp_path / "other"
    gen.generate.generate(other, 43, 3)
    assert (clean_dataset / "invoice-0000.pdf").read_bytes() != (
        other / "invoice-0000.pdf"
    ).read_bytes()


def test_a_smaller_run_removes_what_a_bigger_run_left(gen: SimpleNamespace, tmp_path: Path) -> None:
    root = tmp_path / "out"
    gen.generate.generate(root, 42, 2)
    gen.generate.generate(root, 42, 1)
    assert not (root / "invoice-0001.pdf").exists()
    assert gen.verify.verify_dataset(root).problems == []


def test_a_run_never_deletes_files_that_are_not_its_own(
    gen: SimpleNamespace, tmp_path: Path
) -> None:
    root = tmp_path / "out"
    root.mkdir()
    (root / "keep.txt").write_text("not ours", encoding="utf-8")
    gen.generate.generate(root, 42, 1)
    assert (root / "keep.txt").read_text(encoding="utf-8") == "not ours"


# ---- what the clean dataset holds ----------------------------------------------------------------


def test_the_clean_dataset_passes_every_check(gen: SimpleNamespace, clean_dataset: Path) -> None:
    report = gen.verify.verify_dataset(clean_dataset)
    assert report.problems == []
    assert report.documents == DATASET_SIZE
    assert report.tax_codes > DATASET_SIZE


def test_the_multi_page_variant_really_has_several_pages(clean_dataset: Path) -> None:
    assert find(clean_dataset, "pdf-multi-page")["pages"] >= 2


def test_pdf_uses_only_the_committed_fonts_and_keeps_vietnamese_letters(
    gen: SimpleNamespace, clean_dataset: Path
) -> None:
    import pypdfium2

    entry = next(d for d in manifest(clean_dataset)["documents"] if d["layout"] == "vn-classic")
    pdf = (clean_dataset / f"{entry['id']}.pdf").read_bytes()
    assert gen.verify._pdf_fonts(pdf) <= {"Tinos", "Arimo"}
    document = pypdfium2.PdfDocument(pdf)
    upright, _ = gen.verify.page_text(document[0])
    document.close()
    assert "HÓA ĐƠN GIÁ TRỊ GIA TĂNG" in upright


def test_exif_variant_is_stored_sideways_and_shown_upright(
    renderer: Any, clean_dataset: Path
) -> None:
    """T4.1b measures with this file: the pixels must really depend on the EXIF tag."""
    name = find(clean_dataset, "jpeg-exif-rotated")["primary"]
    jpeg = (clean_dataset / name).read_bytes()
    stored_width, stored_height = jpeg_stored_size(jpeg)
    assert stored_width > stored_height
    context = renderer._browser.new_context()
    try:
        page = context.new_page()
        page.goto((clean_dataset / name).as_uri())
        shown = page.evaluate(
            "() => { const i = document.images[0]; return [i.naturalWidth, i.naturalHeight]; }"
        )
    finally:
        context.close()
    assert shown == [stored_height, stored_width]


@pytest.mark.parametrize(
    "variant",
    ["png-clean", "jpeg-tilt", "jpeg-tilt-noise", "jpeg-low-res", "png-noise", "jpeg-exif-rotated"],
)
def test_pictures_are_recognised_by_the_pipeline(
    gen: SimpleNamespace, clean_dataset: Path, variant: str
) -> None:
    name = find(clean_dataset, variant)["primary"]
    expected = "image/png" if name.endswith(".png") else "image/jpeg"
    assert gen.verify.sniff_image_mime((clean_dataset / name).read_bytes()) == expected


# ---- guards inside rendering ---------------------------------------------------------------------


def _doc(gen: SimpleNamespace, variant: str) -> Any:
    return next(
        doc
        for doc in (gen.data.build_document(42, i) for i in range(DATASET_SIZE))
        if doc.variant.name == variant
    )


def test_a_page_without_a_visible_watermark_stops_the_run(
    gen: SimpleNamespace, renderer: Any
) -> None:
    html = gen.render.render_html(_doc(gen, "pdf-clean"))
    damaged: list[Callable[[Any], None]] = [
        lambda page: page.evaluate("document.querySelector('.wm').remove()"),
        lambda page: page.add_style_tag(content=".wm{display:none}"),
        lambda page: page.add_style_tag(content=".wm{opacity:.01}"),
        lambda page: page.add_style_tag(content=".wm{top:-500%}"),
    ]
    context = renderer._browser.new_context(viewport={"width": 794, "height": 1123})
    try:
        for damage in damaged:
            page = context.new_page()
            page.set_content(html)
            gen.render.check_watermark(page)  # fine before the damage
            damage(page)
            with pytest.raises(gen.render.RenderError, match="WATERMARK_NOT_VISIBLE"):
                gen.render.check_watermark(page)
            page.close()
    finally:
        context.close()


def test_a_watermark_covered_by_something_else_stops_the_run(
    gen: SimpleNamespace, renderer: Any
) -> None:
    html = gen.render.render_html(_doc(gen, "pdf-clean"))
    context = renderer._browser.new_context(viewport={"width": 794, "height": 1123})
    try:
        page = context.new_page()
        page.set_content(html)
        page.add_style_tag(content=".cover{position:fixed;inset:0;z-index:99;background:#fff}")
        page.evaluate(
            "document.body.insertAdjacentHTML('beforeend', '<div class=\"cover\"></div>')"
        )
        gen.render.check_watermark(page)  # the DOM check alone sees nothing wrong
        with pytest.raises(gen.render.RenderError, match="WATERMARK_NOT_PAINTED"):
            gen.render.check_watermark_painted(page)
    finally:
        context.close()


def test_a_picture_too_tall_for_one_page_stops_the_run(gen: SimpleNamespace, renderer: Any) -> None:
    """The picture would lose lines that the ground truth still has."""
    doc = _doc(gen, "png-clean")
    lines = doc.invoice["lines"] * 30
    too_long = replace(doc, invoice={**doc.invoice, "lines": lines})
    with pytest.raises(gen.render.RenderError, match="IMAGE_CONTENT_TOO_TALL"):
        renderer.image(too_long)


# ---- the checker refuses damaged files -----------------------------------------------------------


def test_checker_reports_a_page_without_the_watermark(gen: SimpleNamespace, dataset: Path) -> None:
    entry = find(dataset, "pdf-clean")
    invoice = json.loads((dataset / f"{entry['id']}.expected.json").read_text(encoding="utf-8"))
    # A PDF from the T3.1 generator: readable, right data, but only the word SAMPLE as a mark.
    replace_file(dataset, entry["id"], f"{entry['id']}.pdf", gen.min_pdf.build_pdf(invoice))
    assert "PAGE_WITHOUT_WATERMARK" in codes(gen, dataset)


def test_checker_reports_a_font_from_outside_the_repo(gen: SimpleNamespace, dataset: Path) -> None:
    entry = find(dataset, "pdf-clean")
    invoice = json.loads((dataset / f"{entry['id']}.expected.json").read_text(encoding="utf-8"))
    replace_file(dataset, entry["id"], f"{entry['id']}.pdf", gen.min_pdf.build_pdf(invoice))
    assert "PDF_USES_A_FONT_OUTSIDE_THE_REPO" in codes(gen, dataset)


def test_checker_reports_a_changed_file(gen: SimpleNamespace, dataset: Path) -> None:
    entry = find(dataset, "pdf-clean")
    path = dataset / f"{entry['id']}.xml"
    path.write_bytes(path.read_bytes() + b"\n")
    assert codes(gen, dataset) == {"HASH_MISMATCH"}


def test_checker_reports_a_missing_file_and_an_unlisted_file(
    gen: SimpleNamespace, dataset: Path
) -> None:
    entry = find(dataset, "png-clean")
    (dataset / entry["primary"]).unlink()
    assert "FILE_MISSING" in codes(gen, dataset)
    (dataset / "stray.pdf").write_bytes(b"x")
    assert "FILE_NOT_IN_MANIFEST" in codes(gen, dataset)


def test_checker_reports_an_answer_that_is_not_on_the_page(
    gen: SimpleNamespace, dataset: Path
) -> None:
    entry = find(dataset, "pdf-clean")
    name = f"{entry['id']}.expected.json"
    invoice = json.loads((dataset / name).read_text(encoding="utf-8"))
    invoice["invoiceNo"] = "ZZ-NOT-ON-PAGE"
    invoice["seller"]["address"] = "Somewhere that was never printed"
    replace_file(dataset, entry["id"], name, gen.render.ground_truth_bytes(invoice))
    assert "GROUND_TRUTH_NOT_ON_THE_PAGE" in codes(gen, dataset)


def test_checker_reports_a_real_tax_code_printed_only_on_the_page(
    gen: SimpleNamespace, renderer: Any, dataset: Path
) -> None:
    """The ground truth is clean; the PDF alone carries a code with a valid check digit."""
    doc = _doc(gen, "pdf-clean")
    code = "9" * 9 + str(10 - (9 * 147) % 11)  # valid check digit, built only for this test
    line = {**doc.invoice["lines"][0], "description": f"Ref {code}"}
    printed = replace(doc, invoice={**doc.invoice, "lines": [line, *doc.invoice["lines"][1:]]})
    replace_file(dataset, doc.id, f"{doc.id}.pdf", renderer.pdf(printed))
    assert "TAX_CODE_HAS_REAL_CHECK_DIGIT" in codes(gen, dataset)


def test_checker_reports_a_picture_of_a_multi_page_document(
    gen: SimpleNamespace, dataset: Path
) -> None:
    data = manifest(dataset)
    entry = next(d for d in data["documents"] if d["variant"] == "png-clean")
    entry["pages"] = 2
    (dataset / "manifest.json").write_text(json.dumps(data), encoding="utf-8")
    assert "IMAGE_OF_A_MULTI_PAGE_DOCUMENT" in codes(gen, dataset)


def test_checker_refuses_an_empty_or_absent_dataset(gen: SimpleNamespace, tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    assert codes(gen, empty) == {"MANIFEST_MISSING"}
    (empty / "manifest.json").write_text(json.dumps({"documents": []}), encoding="utf-8")
    assert codes(gen, empty) == {"NO_DOCUMENTS"}


# ---- the TypeScript rules ------------------------------------------------------------------------


def run_rules(root: Path) -> subprocess.CompletedProcess[str]:
    node = shutil.which("node")
    assert node is not None
    return subprocess.run(
        [node, str(GENERATOR_DIR / "check-rules.mjs")],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_rules_accept_the_clean_dataset(clean_dataset: Path) -> None:
    result = run_rules(clean_dataset)
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"documents={DATASET_SIZE} problems=0" in result.stdout


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({"total": 1}, "TOTAL_MISMATCH"),
        ({"subtotal": 1}, "LINES_SUM_MISMATCH"),
        ({"issueDate": "2999-01-01"}, "ISSUE_DATE_FUTURE"),
        ({"invoiceNo": ""}, "NOT_AN_INVOICE"),
    ],
)
def test_rules_refuse_a_wrong_invoice(dataset: Path, change: dict[str, Any], expected: str) -> None:
    entry = manifest(dataset)["documents"][0]
    path = dataset / f"{entry['id']}.expected.json"
    invoice = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps({**invoice, **change}, ensure_ascii=False), encoding="utf-8")
    result = run_rules(dataset)
    assert result.returncode == 1
    assert f"{entry['id']} {expected}" in result.stdout


def test_rules_refuse_an_id_that_points_outside_the_folder(dataset: Path) -> None:
    data = manifest(dataset)
    data["documents"][0]["id"] = "../../secret"
    (dataset / "manifest.json").write_text(json.dumps(data), encoding="utf-8")
    result = run_rules(dataset)
    assert result.returncode == 1
    assert "BAD_DOCUMENT_ID" in result.stdout


def test_rules_refuse_an_empty_dataset(tmp_path: Path) -> None:
    (tmp_path / "manifest.json").write_text(json.dumps({"documents": []}), encoding="utf-8")
    assert run_rules(tmp_path).returncode == 1
