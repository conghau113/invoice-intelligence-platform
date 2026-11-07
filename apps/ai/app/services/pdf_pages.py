"""PDF -> page images (pypdfium2), PNG-encoded with the standard library.

Pillow is deliberately not used (HPND licence is not on the allow-list, docs/LEGAL.md): a PNG is
just zlib-compressed rows with a few chunks. The PDF is untrusted: page count, pixel size and byte
size are all capped, and every failure maps to a fixed code (never the library's message).
"""

import struct
import threading
import zlib

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from app.error_codes import registered

# pdfium is not thread-safe and sync endpoints run in a threadpool: one render at a time.
_PDFIUM_LOCK = threading.Lock()
MAX_PAGES = 10
RENDER_DPI = 150
MAX_EDGE_PX = 2200  # bounds memory for a huge page size (a 200-inch poster at 150 DPI is 30000 px)
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"


class PdfError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = registered(code)


def encode_png(width: int, height: int, rgb: bytes, stride: int) -> bytes:
    row_bytes = width * 3
    raw = b"".join(b"\x00" + rgb[y * stride : y * stride + row_bytes] for y in range(height))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB, no interlace
    return (
        PNG_MAGIC
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def render_pdf_pages(data: bytes) -> list[bytes]:
    with _PDFIUM_LOCK:
        return _render(data)


def _render(data: bytes) -> list[bytes]:
    if not data.startswith(b"%PDF-"):
        raise PdfError("PDF_INVALID")
    try:
        pdf = pdfium.PdfDocument(data)
    except pdfium.PdfiumError:  # corrupt or password-protected
        raise PdfError("PDF_INVALID") from None
    try:
        if len(pdf) == 0:
            raise PdfError("PDF_INVALID")
        if len(pdf) > MAX_PAGES:
            raise PdfError("PDF_TOO_MANY_PAGES")
        pages: list[bytes] = []
        for index in range(len(pdf)):
            page = pdf[index]
            try:
                width_pt, height_pt = page.get_size()
                if width_pt <= 0 or height_pt <= 0:
                    raise PdfError("PDF_INVALID")
                scale = min(RENDER_DPI / 72, MAX_EDGE_PX / max(width_pt, height_pt))
                bitmap = page.render(scale=scale, rev_byteorder=True)  # RGB, white background
                if bitmap.format != pdfium_c.FPDFBitmap_BGR:
                    raise PdfError("PDF_INVALID")
                pages.append(
                    encode_png(bitmap.width, bitmap.height, bytes(bitmap.buffer), bitmap.stride)
                )
            finally:
                page.close()
        return pages
    except pdfium.PdfiumError:
        raise PdfError("PDF_INVALID") from None
    finally:
        pdf.close()


def sniff_image_mime(data: bytes) -> str | None:
    if data.startswith(PNG_MAGIC):
        return "image/png"
    if data.startswith(JPEG_MAGIC):
        return "image/jpeg"
    return None
