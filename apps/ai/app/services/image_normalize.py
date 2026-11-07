"""Uploaded picture -> the bytes a provider may see: pixels and what is needed to decode them.

A PDF loses its metadata by being re-rendered. A picture would otherwise reach the provider byte
for byte (SECURITY.md section 6), so it is rebuilt from an ALLOW-list: whatever is not known to be
needed is left behind, including kinds of block nobody has invented yet. The file is untrusted, so a
bad structure gets a fixed code and never the library's message. The stored original, its hash and
the viewer are not touched: only this copy changes.

Removing EXIF also removes the rotation it records, so a turned JPEG is really turned here. That is
the one case that decodes pixels, using pypdfium2, because Pillow's licence is not on the allow-list
(docs/LEGAL.md). There is no JPEG encoder without it, so such a picture leaves as a PNG.

This cleans metadata. It cannot remove text that is printed in the picture, which the model reads.
"""

import logging
import math
import re
import struct
import zlib
from collections.abc import Iterator
from dataclasses import dataclass
from io import BytesIO

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from app.error_codes import registered
from app.providers.base import ImagePart
from app.services.pdf_pages import (
    MAX_EDGE_PX,
    PDFIUM_LOCK,
    PNG_MAGIC,
    encode_png,
    sniff_image_mime,
)

log = logging.getLogger("ai.image")

# Bounds the work a small file can ask for. 120 MP is above the largest common phone camera (108).
MAX_DECODE_PIXELS = 120_000_000
# Raw RGB budget of a turned picture: a PNG cannot grow past this by much, and it must stay under
# the 12 MB that extract.py allows for the images of one document.
MAX_TURNED_RGB_BYTES = 11 * 1024 * 1024
INFLATE_STEP = 1024 * 1024
# 120 MP of 8-bit RGB fits; a 16-bit picture that size would be seconds of work for a small file.
MAX_PNG_RAW_BYTES = 512 * 1024 * 1024
# A real file has at most thousands (libpng writes 8 KB of pixels per chunk): this bounds the loop.
MAX_PNG_CHUNKS = 65536

PNG_FIXED_SIZE_CHUNKS = {b"gAMA": 4, b"cHRM": 32, b"sRGB": 1}
# Color type -> channels and allowed bit depths (PNG specification, table 11.1).
PNG_COLOR_TYPES = {
    0: (1, (1, 2, 4, 8, 16)),
    2: (3, (8, 16)),
    3: (1, (1, 2, 4, 8)),
    4: (2, (8, 16)),
    6: (4, (8, 16)),
}
PALETTE = 3
TRNS_SIZE = {0: 2, 2: 6}  # the palette type has one byte per entry, see _keep_optional
ADAM7 = (
    (0, 0, 8, 8),
    (4, 0, 8, 8),
    (0, 4, 4, 8),
    (2, 0, 4, 4),
    (0, 2, 2, 4),
    (1, 0, 2, 2),
    (0, 1, 1, 2),
)

JPEG_EOI = 0xD9
JPEG_SOS = 0xDA
JPEG_APP0 = 0xE0
JPEG_APP1 = 0xE1
JPEG_APP14 = 0xEE
JPEG_DHT = 0xC4
JPEG_DAC = 0xCC
JPEG_DQT = 0xDB
JPEG_DRI = 0xDD
# Baseline, extended, progressive, and their arithmetic-coded forms. The others are not decoded by
# what a browser or a provider uses, so there is nothing to gain from forwarding them.
JPEG_FRAMES = frozenset({0xC0, 0xC1, 0xC2, 0xC9, 0xCA})
JPEG_FRAMES_PDFIUM_READS = frozenset({0xC0, 0xC1, 0xC2})
# Far above any real file: a progressive JPEG has about ten scans, a phone's few dozen segments.
# Each one costs a loop here and, for a turned picture, work in the decoder. Table bytes are copied
# as they are, so their total is capped: valid tables can spell a sentence.
MAX_JPEG_SEGMENTS = 4096
MAX_JPEG_SCANS = 100
MAX_JPEG_TABLE_BYTES = 64 * 1024
_JPEG_SCAN_END = re.compile(rb"\xff[^\x00\xd0-\xd7\xff]")
_FILL_BYTES = re.compile(rb"\xff*")
# Written by us rather than copied, so a thumbnail or extra bytes in the original cannot come along.
JFIF_SEGMENT = b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
ADOBE_HEADER = b"\xff\xee\x00\x0eAdobe\x00\x64\x00\x00\x00\x00"
EXIF_HEADER = b"Exif\x00\x00"
ORIENTATION_TAG = 0x0112
EXIF_SHORT = 3


class ImageError(Exception):
    def __init__(self, code: str = "IMAGE_INVALID") -> None:
        super().__init__(code)
        self.code = registered(code)


def normalize_image(data: bytes) -> ImagePart:
    mime = sniff_image_mime(data)
    if mime == "image/png":
        return ImagePart(data=clean_png(data), mime=mime)
    if mime == "image/jpeg":
        jpeg = clean_jpeg(data)
        if jpeg.orientation == 1:
            return ImagePart(data=jpeg.data, mime=mime)
        turned = _turn_jpeg(jpeg)
        log.info("image turned orientation=%d", jpeg.orientation)
        return ImagePart(data=turned, mime="image/png")
    raise ImageError("IMAGE_UNSUPPORTED")


# --- PNG ------------------------------------------------------------------------------------------


def _png_chunks(data: bytes) -> Iterator[tuple[bytes, bytes, bool]]:
    """(kind, payload, crc is right), up to and including IEND: what follows it is never read."""
    pos = len(PNG_MAGIC)
    for _ in range(MAX_PNG_CHUNKS):
        if pos + 12 > len(data):
            raise ImageError()  # the file ended before IEND
        size = struct.unpack_from(">I", data, pos)[0]
        end = pos + 12 + size
        if end > len(data):
            raise ImageError()
        kind = data[pos + 4 : pos + 8]
        crc = struct.unpack_from(">I", data, end - 4)[0]
        yield kind, data[pos + 8 : end - 4], zlib.crc32(data[pos + 4 : end - 4]) == crc
        if kind == b"IEND":
            return
        pos = end
    raise ImageError()


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))


@dataclass(frozen=True)
class _PngHeader:
    width: int
    height: int
    depth: int
    color: int
    interlaced: bool

    def row_bytes(self, width: int) -> int:
        channels = PNG_COLOR_TYPES[self.color][0]
        return 1 + math.ceil(width * channels * self.depth / 8)  # +1: the filter byte of each row

    def raw_size(self) -> int:
        if not self.interlaced:
            return self.height * self.row_bytes(self.width)
        total = 0
        for x_start, y_start, x_step, y_step in ADAM7:
            pass_width = math.ceil((self.width - x_start) / x_step)
            pass_height = math.ceil((self.height - y_start) / y_step)
            if pass_width > 0 and pass_height > 0:  # a small picture has empty passes
                total += pass_height * self.row_bytes(pass_width)
        return total


def _png_header(payload: bytes) -> _PngHeader:
    if len(payload) != 13:
        raise ImageError()
    width, height, depth, color, compression, filtering, interlace = struct.unpack(
        ">IIBBBBB", payload
    )
    allowed = PNG_COLOR_TYPES.get(color)
    if allowed is None or depth not in allowed[1] or compression != 0 or filtering != 0:
        raise ImageError()
    if interlace not in (0, 1) or width == 0 or height == 0:
        raise ImageError()
    if width * height > MAX_DECODE_PIXELS:
        raise ImageError()
    header = _PngHeader(width, height, depth, color, interlace == 1)
    if header.raw_size() > MAX_PNG_RAW_BYTES:
        raise ImageError()
    return header


def _keep_optional(kind: bytes, payload: bytes, color: int, palette_size: int) -> bool:
    """Transparency, and the colour notes that hold only a number, so no room for a sentence."""
    if kind == b"tRNS":
        if color == PALETTE:
            return 0 < len(payload) <= palette_size
        return len(payload) == TRNS_SIZE.get(color)
    return len(payload) == PNG_FIXED_SIZE_CHUNKS.get(kind)


def _png_pixels(compressed: bytes, expected: int) -> bytes:
    """The zlib stream, checked to the exact size, without whatever an attacker appended to it.

    Inflated in steps and thrown away, so a small file cannot fill the memory, and the original
    compression is kept, so the file does not grow.
    """
    inflater = zlib.decompressobj()
    total = 0
    pending = compressed
    try:
        while not inflater.eof:
            produced = len(inflater.decompress(pending, INFLATE_STEP))
            total += produced
            if total > expected:
                raise ImageError()
            pending = inflater.unconsumed_tail
            if produced == 0 and not pending:
                break  # the stream was cut short
    except zlib.error:
        raise ImageError() from None
    if not inflater.eof or total != expected:
        raise ImageError()
    return compressed[: len(compressed) - len(inflater.unused_data)]


def clean_png(data: bytes) -> bytes:
    chunks = _png_chunks(data)
    kind, payload, crc_ok = next(chunks)
    if kind != b"IHDR" or not crc_ok:
        raise ImageError()
    header = _png_header(payload)
    kept = [_png_chunk(b"IHDR", payload)]
    palette_size = 0
    seen: set[bytes] = set()  # once each: valid chunks in a row could spell a sentence
    compressed: list[bytes] = []
    for kind, payload, crc_ok in chunks:
        if kind in (b"IDAT", b"IEND", b"PLTE") and not crc_ok:
            raise ImageError()
        if kind == b"IDAT":
            compressed.append(payload)
        elif not crc_ok or compressed or kind in seen:
            continue  # a damaged optional block is not needed; none may follow the pixels
        elif kind == b"PLTE" and header.color == PALETTE:
            if len(payload) == 0 or len(payload) > 768 or len(payload) % 3 != 0:
                raise ImageError()
            palette_size = len(payload) // 3
            seen.add(kind)
            kept.append(_png_chunk(kind, payload))
        elif _keep_optional(kind, payload, header.color, palette_size):
            seen.add(kind)
            kept.append(_png_chunk(kind, payload))
    if not compressed or (header.color == PALETTE and palette_size == 0):
        raise ImageError()
    pixels = _png_pixels(b"".join(compressed), header.raw_size())
    return PNG_MAGIC + b"".join(kept) + _png_chunk(b"IDAT", pixels) + _png_chunk(b"IEND", b"")


# --- JPEG -----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class CleanJpeg:
    data: bytes
    width: int
    height: int
    orientation: int
    pdfium_can_read: bool


def _exif_orientation(tiff: bytes) -> int:
    """1..8 from an EXIF block. Anything odd means 1: bad metadata is no reason to refuse a file."""
    order = {b"II": "<", b"MM": ">"}.get(tiff[:2])
    if order is None:
        return 1
    try:
        magic, directory = struct.unpack_from(f"{order}HI", tiff, 2)
        if magic != 42:
            return 1
        count = struct.unpack_from(f"{order}H", tiff, directory)[0]
        for index in range(count):
            tag, kind, values = struct.unpack_from(f"{order}HHI", tiff, directory + 2 + 12 * index)
            if tag == ORIENTATION_TAG:
                value = struct.unpack_from(f"{order}H", tiff, directory + 2 + 12 * index + 8)[0]
                return value if kind == EXIF_SHORT and values == 1 and 1 <= value <= 8 else 1
    except struct.error:
        return 1
    return 1


def _scan_end(data: bytes, pos: int) -> int:
    """Where the compressed data after a SOS header ends: the first real marker.

    A search, not a loop over each 0xFF: a file full of them would take seconds here.
    """
    found = _JPEG_SCAN_END.search(data, pos)
    if found is None:
        raise ImageError()  # no end-of-image: a cut file decodes to a page half blank
    return found.start()


@dataclass(frozen=True)
class _Frame:
    width: int
    height: int
    precision: int
    components: frozenset[int]


def _read_frame(body: bytes) -> _Frame:
    if len(body) < 6:
        raise ImageError()
    precision, height, width, count = struct.unpack_from(">BHHB", body)
    if precision not in (8, 12) or height == 0 or width == 0 or count not in (1, 3, 4):
        raise ImageError()
    if len(body) != 6 + 3 * count:
        raise ImageError()
    entries = [body[6 + 3 * i : 9 + 3 * i] for i in range(count)]
    for _, sampling, table in entries:
        if not (1 <= sampling >> 4 <= 4 and 1 <= sampling & 0x0F <= 4 and table <= 3):
            raise ImageError()
    components = frozenset(entry[0] for entry in entries)
    if len(components) != count:
        raise ImageError()
    return _Frame(width, height, precision, components)


def _check_scan_header(body: bytes, frame: _Frame | None) -> None:
    if frame is None or not body:
        raise ImageError()
    count = body[0]
    if not 1 <= count <= 4 or len(body) != 4 + 2 * count:
        raise ImageError()
    selected = [body[1 + 2 * i] for i in range(count)]
    tables = [body[2 + 2 * i] for i in range(count)]
    if len(set(selected)) != count or not frame.components.issuperset(selected):
        raise ImageError()
    if any(table >> 4 > 3 or table & 0x0F > 3 for table in tables):
        raise ImageError()


def _check_quantization(body: bytes) -> None:
    pos = 0
    while pos < len(body):
        info = body[pos]
        if info >> 4 > 1 or info & 0x0F > 3:
            raise ImageError()
        pos += 1 + 64 * ((info >> 4) + 1)
    if pos != len(body) or not body:
        raise ImageError()


def _check_huffman(body: bytes) -> None:
    """A table whose counts cannot form a prefix code crashes PDFium outright, not with an error."""
    pos = 0
    while pos < len(body):
        counts = body[pos + 1 : pos + 17]
        if len(counts) != 16 or body[pos] >> 4 > 1 or body[pos] & 0x0F > 3 or sum(counts) > 256:
            raise ImageError()
        code = 0
        for length, count in enumerate(counts, start=1):
            code += count
            if code > 1 << length:
                raise ImageError()
            code <<= 1
        pos += 17 + sum(counts)
    if pos != len(body) or not body:
        raise ImageError()


def _check_restart_interval(body: bytes) -> None:
    if len(body) != 2:
        raise ImageError()


def _check_arithmetic(body: bytes) -> None:
    if not body or len(body) % 2 != 0:
        raise ImageError()
    if any(info >> 4 > 1 or info & 0x0F > 3 for info in body[::2]):
        raise ImageError()


JPEG_TABLE_CHECKS = {
    JPEG_DHT: _check_huffman,
    JPEG_DAC: _check_arithmetic,
    JPEG_DQT: _check_quantization,
    JPEG_DRI: _check_restart_interval,
}


def _kept_app_segment(marker: int, body: bytes) -> bytes:
    if marker == JPEG_APP0 and body.startswith(b"JFIF\x00"):
        return JFIF_SEGMENT
    # The byte after the header says how colours were stored: without it they come out wrong.
    if marker == JPEG_APP14 and body.startswith(b"Adobe") and len(body) >= 12 and body[11] <= 2:
        return ADOBE_HEADER + body[11:12]
    return b""


def _next_marker(data: bytes, pos: int) -> int:
    """Position of the next marker's 0xFF, past any fill bytes before it."""
    after_fill = _FILL_BYTES.match(data, pos).end()  # type: ignore[union-attr]  # * always matches
    if after_fill == pos or after_fill >= len(data):
        raise ImageError()
    return after_fill - 1


def _segment_end(data: bytes, pos: int) -> int:
    if pos + 4 > len(data):
        raise ImageError()
    size = struct.unpack_from(">H", data, pos + 2)[0]
    end = pos + 2 + size
    if size < 2 or end > len(data):
        raise ImageError()
    return end


def clean_jpeg(data: bytes) -> CleanJpeg:
    out = bytearray(b"\xff\xd8")
    pos = 2
    frame_marker = 0
    frame: _Frame | None = None
    orientation: int | None = None
    scans = 0
    table_bytes = 0
    for _ in range(MAX_JPEG_SEGMENTS):
        pos = _next_marker(data, pos)
        marker = data[pos + 1]
        if marker == JPEG_EOI:
            break  # anything after the original's end-of-image stays behind
        if marker in (0x00, 0x01) or 0xD0 <= marker <= 0xD8:
            raise ImageError()  # markers without a length do not belong here
        end = _segment_end(data, pos)
        body = data[pos + 4 : end]
        if marker == JPEG_SOS:
            _check_scan_header(body, frame)
            end = _scan_end(data, end)
            scans += 1
        elif marker in JPEG_FRAMES:
            if frame is not None:
                raise ImageError()
            frame = _read_frame(body)
            frame_marker = marker
        elif marker in JPEG_TABLE_CHECKS:
            JPEG_TABLE_CHECKS[marker](body)
            table_bytes += len(body)
        else:
            if marker == JPEG_APP1 and orientation is None and body.startswith(EXIF_HEADER):
                orientation = _exif_orientation(body[len(EXIF_HEADER) :])
            out += _kept_app_segment(marker, body)
            pos = end
            continue
        out += data[pos:end]
        pos = end
    else:
        raise ImageError()
    if frame is None or not 1 <= scans <= MAX_JPEG_SCANS or table_bytes > MAX_JPEG_TABLE_BYTES:
        raise ImageError()
    out += b"\xff\xd9"
    pdfium_can_read = frame_marker in JPEG_FRAMES_PDFIUM_READS and frame.precision == 8
    return CleanJpeg(bytes(out), frame.width, frame.height, orientation or 1, pdfium_can_read)


def _orientation_matrix(orientation: int, width: int, height: int) -> pdfium.PdfMatrix:
    """Places the picture on a page so it shows as EXIF says. Column names as in the PDF matrix.

    x' = a*u + c*v + e and y' = b*u + d*v + f, where (u, v) runs over the picture's unit square,
    with v going UP (the top row of pixels is v = 1) and y' going up the page.
    """
    w, h = width, height
    return {
        2: pdfium.PdfMatrix(-w, 0, 0, h, w, 0),  # mirrored left to right
        3: pdfium.PdfMatrix(-w, 0, 0, -h, w, h),  # upside down
        4: pdfium.PdfMatrix(w, 0, 0, -h, 0, h),  # mirrored top to bottom
        5: pdfium.PdfMatrix(0, -w, -h, 0, h, w),  # mirrored along the main diagonal
        6: pdfium.PdfMatrix(0, -w, h, 0, 0, w),  # turn 90 degrees clockwise to show it
        7: pdfium.PdfMatrix(0, w, h, 0, 0, 0),  # mirrored along the other diagonal
        8: pdfium.PdfMatrix(0, w, -h, 0, h, 0),  # turn 90 degrees counter-clockwise to show it
    }[orientation]


def _turn_jpeg(jpeg: CleanJpeg) -> bytes:
    if not jpeg.pdfium_can_read or jpeg.width * jpeg.height > MAX_DECODE_PIXELS:
        raise ImageError()
    swapped = jpeg.orientation >= 5
    page_width = jpeg.height if swapped else jpeg.width
    page_height = jpeg.width if swapped else jpeg.height
    # A phone photo is far above what is useful and, as a PNG, above what one request can carry.
    scale = min(
        1.0,
        MAX_EDGE_PX / max(page_width, page_height),
        math.sqrt(MAX_TURNED_RGB_BYTES / (3 * page_width * page_height)),
    )
    with PDFIUM_LOCK:  # pdfium is not thread-safe
        pdf = pdfium.PdfDocument.new()
        try:
            image = pdfium.PdfImage.new(pdf)
            image.load_jpeg(BytesIO(jpeg.data), inline=True)
            page = pdf.new_page(page_width, page_height)
            image.set_matrix(_orientation_matrix(jpeg.orientation, jpeg.width, jpeg.height))
            page.insert_obj(image)
            page.gen_content()
            bitmap = page.render(scale=scale, rev_byteorder=True)
            if bitmap.format != pdfium_c.FPDFBitmap_BGR:
                raise ImageError()
            return encode_png(bitmap.width, bitmap.height, bytes(bitmap.buffer), bitmap.stride)
        except (pdfium.PdfiumError, ValueError, OverflowError, MemoryError):
            # Uncaught, these would be a 500, and the worker would retry the same file.
            raise ImageError() from None
        finally:
            pdf.close()
