"""Renders a Document: HTML (Jinja) -> PDF and picture (Chromium through Playwright).

Chromium is byte-for-byte repeatable here except for the two dates a PDF records, which are replaced
with a fixed value of the same length. Fonts are committed and the browser is offline, so the output
never depends on the fonts or the network of the machine.
"""

import base64
import json
import re
import struct
from collections.abc import Iterator
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from typing import Any

from gen_data import Document, ImageSpec
from jinja2 import Environment, FileSystemLoader, StrictUndefined
from min_xml import render_xml

HERE = Path(__file__).resolve().parent
WATERMARK = "SAMPLE – SYNTHETIC DATA"
PAGE_WIDTH = 794  # A4 at 96 DPI in CSS px
PAGE_HEIGHT = 1123
PAGE_MARGIN = 45  # 12 mm, the same as @page in the templates: the text wraps the same in a picture
FIXED_PDF_DATE = b"D:20260101000000+00'00'"
EXPONENT = {"VND": 0, "USD": 2}
SEPARATORS = {"vi": (".", ","), "en": (",", ".")}  # thousands, decimal
MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]
# The ranges come from the @fontsource CSS: a browser picks the file that holds each letter.
UNICODE_RANGES = {
    "vietnamese": "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,"
    "U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
    "latin-ext": "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,"
    "U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,"
    "U+A720-A7FF",
    "latin": "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,"
    "U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
}


class RenderError(RuntimeError):
    """A rendered document would be unsafe or wrong; stop instead of writing it."""


class Formats:
    """How one layout's language prints numbers and dates. The ground truth stays integers/ISO."""

    def __init__(self, locale: str, currency: str) -> None:
        self.locale = locale
        self.currency = currency
        self.thousands, self.decimal = SEPARATORS[locale]

    def _group(self, value: int) -> str:
        return f"{value:,}".replace(",", self.thousands)

    def money(self, minor: int) -> str:
        exponent = EXPONENT[self.currency]
        if exponent == 0:
            return self._group(minor)
        whole, fraction = divmod(minor, 10**exponent)
        return f"{self._group(whole)}{self.decimal}{fraction:0{exponent}d}"

    def quantity(self, value: float) -> str:
        text = format(Decimal(str(value)).normalize(), "f")
        return text.replace(".", self.decimal)

    def rate(self, value: float) -> str:
        return f"{self.quantity(value)}%"

    def date_short(self, iso: str) -> str:
        year, month, day = iso.split("-")
        return f"{day}/{month}/{year}"

    def date_long(self, iso: str) -> str:
        year, month, day = iso.split("-")
        if self.locale == "vi":
            return f"Ngày {day} tháng {month} năm {year}"
        return f"{MONTHS[int(month) - 1]} {int(day)}, {year}"


def _fonts_css() -> str:
    faces = []
    for family in ("Tinos", "Arimo"):
        for weight in (400, 700):
            for subset, unicode_range in UNICODE_RANGES.items():
                path = HERE / "fonts" / f"{family.lower()}-{subset}-{weight}-normal.woff2"
                data = base64.b64encode(path.read_bytes()).decode()
                faces.append(
                    f"@font-face{{font-family:{family};font-weight:{weight};"
                    f"src:url(data:font/woff2;base64,{data}) format('woff2');"
                    f"unicode-range:{unicode_range}}}"
                )
    return "".join(faces)


# autoescape: a description is text, even when a test or T4.2 puts markup or an attack in it.
_ENV = Environment(
    loader=FileSystemLoader(HERE / "templates"), autoescape=True, undefined=StrictUndefined
)
_FONTS_CSS = _fonts_css()


def render_html(doc: Document) -> str:
    template = _ENV.get_template(f"{doc.layout}.html.j2")
    return template.render(
        inv=doc.invoice,
        fmt=Formats(doc.locale, doc.invoice["currency"]),
        lang=doc.locale,
        doc_id=doc.id,
        watermark=WATERMARK,
        fonts_css=_FONTS_CSS,
        note=doc.note,
        note_color=doc.note_color,
    )


def normalize_pdf_dates(pdf: bytes) -> bytes:
    """Fixes the two dates, keeping the length so the cross-reference offsets stay right."""

    def fixed(match: re.Match[bytes]) -> bytes:
        if len(match.group(2)) != len(FIXED_PDF_DATE):
            raise RenderError("PDF_DATE_FORMAT_CHANGED")
        return match.group(1) + FIXED_PDF_DATE + b")"

    out, count = re.subn(rb"(/(?:CreationDate|ModDate) \()(D:[^)]{1,40})\)", fixed, pdf)
    if count != 2:  # a newer Chromium may write dates elsewhere: fail, do not lose repeatability
        raise RenderError("PDF_DATE_FORMAT_CHANGED")
    return out


def add_exif_orientation(jpeg: bytes, orientation: int) -> bytes:
    """Inserts an EXIF block holding only the Orientation tag, right after the start of the file."""
    if jpeg[:2] != b"\xff\xd8":
        raise RenderError("NOT_A_JPEG")
    tiff = (
        b"MM\x00*\x00\x00\x00\x08"  # big-endian TIFF header, first directory at offset 8
        + struct.pack(">H", 1)  # one entry
        + struct.pack(">HHIHH", 0x0112, 3, 1, orientation, 0)  # Orientation, SHORT, count 1
        + struct.pack(">I", 0)  # no next directory
    )
    body = b"Exif\x00\x00" + tiff
    return jpeg[:2] + b"\xff\xe1" + struct.pack(">H", len(body) + 2) + body + jpeg[2:]


def _image_css(spec: ImageSpec, tilt: float) -> str:
    transform = "none"
    if spec.exif_rotated:
        # Stored turned 90 degrees counter-clockwise: Orientation 6 tells a viewer to turn it back.
        transform = f"translateY({PAGE_WIDTH}px) rotate(-90deg)"
    elif tilt:
        transform = f"scale(.88) rotate({tilt}deg)"  # the scale keeps the corners in the picture
    origin = "0 0" if spec.exif_rotated else "center"
    blur = f"filter:blur({spec.blur}px);" if spec.blur else ""
    return (
        "html{background:#d4d4d0;overflow:hidden}"
        f"body{{position:absolute;left:0;top:0;margin:0;width:{PAGE_WIDTH}px;"
        f"height:{PAGE_HEIGHT}px;box-sizing:border-box;padding:{PAGE_MARGIN}px;background:#fff;"
        f"overflow:hidden;transform-origin:{origin};transform:{transform};{blur}}}"
    )


# Watermark is required by docs/LEGAL.md, and a picture has no text layer to check afterwards, so
# the check runs on the page, just before the screenshot.
_WATERMARK_VISIBLE = """(expected) => {
  const el = document.querySelector('.wm');
  if (!el || el.textContent.trim() !== expected) return false;
  const style = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  const inView = box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0
    && box.left < innerWidth && box.top < innerHeight;
  return style.display !== 'none' && style.visibility === 'visible'
    && Number(style.opacity) >= 0.15 && inView;
}"""


def check_watermark(page: Any) -> None:
    if not page.evaluate(_WATERMARK_VISIBLE, WATERMARK):
        raise RenderError("WATERMARK_NOT_VISIBLE")


def check_watermark_painted(page: Any) -> None:
    """The picture must change when the mark is hidden: catches a mark covered by something else.

    Run it last, it hides the mark. It proves that some of the mark shows, not that all of it does.
    """
    with_mark = page.screenshot(type="png")
    page.add_style_tag(content=".wm{visibility:hidden}")
    if page.screenshot(type="png") == with_mark:
        raise RenderError("WATERMARK_NOT_PAINTED")


_NOISE = """([seed, opacity]) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"
    style="position:fixed;inset:0;opacity:${opacity};mix-blend-mode:multiply;pointer-events:none">
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2"
    seed="${seed}"/><feColorMatrix type="saturate" values="0"/></filter>
    <rect width="100%" height="100%" filter="url(#grain)"/></svg>`;
  document.documentElement.insertAdjacentHTML('beforeend', svg);
}"""
_FONTS_READY = "async () => { await document.fonts.ready; return true; }"


class Renderer:
    """One browser for the whole run; a new page per document, so nothing carries over."""

    def __init__(self, browser: Any) -> None:
        self._browser = browser

    def _context(self, scale: float, width: int, height: int) -> Any:
        return self._browser.new_context(
            offline=True,  # nothing may come from the network: same bytes on every run
            viewport={"width": width, "height": height},
            device_scale_factor=scale,
            locale="en-US",
            timezone_id="UTC",
        )

    def pdf(self, doc: Document) -> bytes:
        context = self._context(1, PAGE_WIDTH, PAGE_HEIGHT)
        try:
            page = context.new_page()
            page.set_content(render_html(doc))
            page.evaluate(_FONTS_READY)
            check_watermark(page)
            raw = page.pdf(format="A4", print_background=True, prefer_css_page_size=True)
        finally:
            context.close()
        return normalize_pdf_dates(raw)

    def image(self, doc: Document) -> bytes:
        spec = doc.variant.image
        if spec is None:
            raise RenderError("NO_IMAGE_SPEC")
        width, height = PAGE_WIDTH, PAGE_HEIGHT
        if spec.exif_rotated:
            width, height = PAGE_HEIGHT, PAGE_WIDTH
        context = self._context(spec.scale, width, height)
        try:
            page = context.new_page()
            page.set_content(render_html(doc))
            page.add_style_tag(content=_image_css(spec, doc.tilt))
            if spec.noise:
                page.evaluate(_NOISE, [doc.noise_seed, spec.noise])
            page.evaluate(_FONTS_READY)
            # A picture is one page. Text past the edge would be missing from the picture while
            # still being in the ground truth, which would blame the model for our cut.
            overflow = page.evaluate("document.querySelector('.sheet').scrollHeight")
            if overflow > PAGE_HEIGHT - 2 * PAGE_MARGIN:
                raise RenderError("IMAGE_CONTENT_TOO_TALL")
            check_watermark(page)
            if spec.kind == "png":
                shot = page.screenshot(type="png")
            else:
                shot = page.screenshot(type="jpeg", quality=spec.quality)
            check_watermark_painted(page)
        finally:
            context.close()
        return add_exif_orientation(shot, 6) if spec.exif_rotated else shot


@contextmanager
def open_renderer() -> Iterator[Renderer]:
    # Imported here so the data and HTML tests (CI, no browser) do not need the `invoice-gen` group.
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            yield Renderer(browser)
        finally:
            browser.close()


def ground_truth_bytes(invoice: dict[str, Any]) -> bytes:
    return (json.dumps(invoice, ensure_ascii=False, indent=2) + "\n").encode()


def xml_bytes(invoice: dict[str, Any]) -> bytes:
    return render_xml(invoice)
