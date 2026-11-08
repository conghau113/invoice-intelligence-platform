"""Pictures for the error examples of compare-v1.md: a band of the invoice page with a red box
around where the right value is printed.

pypdfium2 finds the text and renders the band; PNG is written by `encode_png` from the service, so
no image library is added (Pillow is not on the licence allow-list, docs/LEGAL.md). The page comes
from the invoice PDF. For a picture variant the model saw a photo of the same invoice, and the
caption says so. Inputs are the frozen dataset only, and file names come from manifest ids.
"""

from dataclasses import dataclass
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from app.services.pdf_pages import encode_png

SCALE = 2.0  # 144 dpi: small digits stay legible
BAND_PT = 70.0  # page height kept above and below the box, in points
BOX_PX = 3
RED = (220, 38, 38)


@dataclass(frozen=True)
class Found:
    page: int
    left: float
    bottom: float
    right: float
    top: float


def find_text(pdf: pdfium.PdfDocument, needles: list[str]) -> Found | None:
    """The first needle printed in the PDF, as a box in PDF points (origin bottom left)."""
    for needle in (n for n in needles if n):
        for index in range(len(pdf)):
            textpage = pdf[index].get_textpage()
            searcher = textpage.search(needle, match_case=False)
            hit = searcher.get_next()
            if hit is None:
                continue
            start, count = hit
            boxes = [textpage.get_charbox(i) for i in range(start, start + count)]
            return Found(
                index,
                min(b[0] for b in boxes),
                min(b[1] for b in boxes),
                max(b[2] for b in boxes),
                max(b[3] for b in boxes),
            )
    return None


def _draw_box(rgb: bytearray, stride: int, size: tuple[int, int], box: tuple[int, ...]) -> None:
    width, height = size
    x0, y0, x1, y1 = (max(0, v) for v in box)
    x1, y1 = min(width - 1, x1), min(height - 1, y1)
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            edge = x - x0 < BOX_PX or x1 - x < BOX_PX or y - y0 < BOX_PX or y1 - y < BOX_PX
            if edge:
                at = y * stride + x * 3
                rgb[at : at + 3] = bytes(RED)


def render_band(pdf_path: Path, needles: list[str]) -> bytes | None:
    """PNG of the page band around the first needle found, or None when none is printed."""
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        found = find_text(pdf, needles)
        if found is None:
            return None
        page = pdf[found.page]
        width_pt, height_pt = page.get_size()
        top_cut = max(0.0, height_pt - found.top - BAND_PT)
        bottom_cut = max(0.0, found.bottom - BAND_PT)
        bitmap = page.render(scale=SCALE, crop=(0, bottom_cut, 0, top_cut), rev_byteorder=True)
        if bitmap.format != pdfium_c.FPDFBitmap_BGR:  # rev_byteorder: this is RGB
            raise ValueError("unexpected bitmap format")
        rgb = bytearray(bitmap.buffer)
        pad = 4.0
        box = (
            int((found.left - pad) * SCALE),
            int((height_pt - top_cut - found.top - pad) * SCALE),
            int((found.right + pad) * SCALE),
            int((height_pt - top_cut - found.bottom + pad) * SCALE),
        )
        _draw_box(rgb, bitmap.stride, (bitmap.width, bitmap.height), box)
        return encode_png(bitmap.width, bitmap.height, bytes(rgb), bitmap.stride)
    finally:
        pdf.close()
