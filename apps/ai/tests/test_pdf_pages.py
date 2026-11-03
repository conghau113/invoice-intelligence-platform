import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.services import pdf_pages
from app.services.pdf_pages import (
    MAX_EDGE_PX,
    MAX_PAGES,
    PdfError,
    encode_png,
    render_pdf_pages,
    sniff_image_mime,
)

SAMPLE = Path(__file__).parent / "fixtures" / "pdf_invoices" / "invoice-00.pdf"


def make_pdf(pages: int, media_box: str = "0 0 595 842") -> bytes:
    """Smallest valid multi-page PDF (empty pages)."""
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join(f"{3 + i} 0 R" for i in range(pages))
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>".encode())
    objs += [
        f"<< /Type /Page /Parent 2 0 R /MediaBox [{media_box}] >>".encode() for _ in range(pages)
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def png_size(png: bytes) -> tuple[int, int]:
    return struct.unpack(">II", png[16:24])


def test_sample_pdf_renders_to_one_png_at_about_150_dpi() -> None:
    pages = render_pdf_pages(SAMPLE.read_bytes())
    assert len(pages) == 1
    assert pages[0].startswith(b"\x89PNG\r\n\x1a\n")
    width, height = png_size(pages[0])
    assert width == 1240 and abs(height - 1754) <= 1  # A4 at 150 DPI


def test_encoded_png_is_readable_by_pdfium_neighbour_decoders() -> None:
    # 2x2 RGB image with a 2-byte row padding: the stride must be skipped, not copied.
    rgb = bytes([255, 0, 0, 0, 255, 0, 9, 9]) + bytes([0, 0, 255, 255, 255, 255, 9, 9])
    png = encode_png(2, 2, rgb, stride=8)
    assert png_size(png) == (2, 2)
    import zlib

    idat_len = struct.unpack(">I", png[33:37])[0]
    raw = zlib.decompress(png[41 : 41 + idat_len])
    assert raw == b"\x00" + rgb[0:6] + b"\x00" + rgb[8:14]


def test_page_count_is_capped() -> None:
    assert len(render_pdf_pages(make_pdf(MAX_PAGES))) == MAX_PAGES
    with pytest.raises(PdfError) as err:
        render_pdf_pages(make_pdf(MAX_PAGES + 1))
    assert err.value.code == "PDF_TOO_MANY_PAGES"


def test_huge_page_size_is_clamped() -> None:
    (page,) = render_pdf_pages(make_pdf(1, "0 0 14400 14400"))  # a 200-inch poster
    assert max(png_size(page)) <= MAX_EDGE_PX


@pytest.mark.parametrize(
    "data",
    [b"", b"not a pdf", b"%PDF-1.4\ngarbage", SAMPLE.read_bytes()[:200]],
)
def test_bad_pdfs_get_a_code(data: bytes) -> None:
    with pytest.raises(PdfError) as err:
        render_pdf_pages(data)
    assert err.value.code == "PDF_INVALID"


def test_image_sniffing_uses_magic_bytes_not_names() -> None:
    assert sniff_image_mime(b"\x89PNG\r\n\x1a\nrest") == "image/png"
    assert sniff_image_mime(b"\xff\xd8\xff\xe0rest") == "image/jpeg"
    assert sniff_image_mime(b"GIF89a") is None
    assert sniff_image_mime(b"%PDF-1.4") is None


def test_pdfium_is_never_used_by_two_threads_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    active = 0
    peak = 0
    guard = threading.Lock()

    def fake_render(data: bytes) -> list[bytes]:
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
        time.sleep(0.02)
        with guard:
            active -= 1
        return []

    monkeypatch.setattr(pdf_pages, "_render", fake_render)
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda _: render_pdf_pages(b"%PDF-"), range(8)))
    assert peak == 1
