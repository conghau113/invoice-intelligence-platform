"""One-time: copies a checked `out/` into eval/datasets/v1 and writes the manifest eval reads.

    pnpm gen:invoices --n 100 --seed 42 --injection && pnpm gen:invoices:verify
    pnpm gen:invoices:freeze

Once frozen, the bytes are the dataset. Generating again on another machine may give other pixels
(README), so eval reads these files and never regenerates. It refuses to overwrite: a changed
dataset is a new version (`v2`), because scores on two different sets cannot be compared.
"""

import hashlib
import json
import shutil
from collections import Counter
from importlib.metadata import version
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
OUT_DIR = Path(__file__).resolve().parent / "out"
TARGET = REPO / "eval/datasets/v1"
REGRESSION_SOURCE = REPO / "apps/ai/tests/fixtures/pdf_invoices/invoice-00"
SEED = 42
CORE_COUNT = 100
INJECTION_COUNT = 24
# Fixed before any model run, so the smoke set cannot be picked for how well it scores. Same 8/8/4
# mix as the 100. Hard has five variants and four places: jpeg-tilt-noise stays out because tilt and
# noise are each covered on their own, while EXIF rotation is the risk of T4.1b and must be in.
SMOKE_QUOTA = {
    "pdf-clean": 8,
    "pdf-many-lines": 3,
    "png-clean": 3,
    "jpeg-tilt": 2,
    "pdf-multi-page": 1,
    "jpeg-exif-rotated": 1,
    "jpeg-low-res": 1,
    "png-noise": 1,
}


class FreezeError(RuntimeError):
    """The source is not what the manifest says, or the target already exists."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def select_smoke(core: list[dict[str, Any]]) -> list[str]:
    """The first documents of each variant by position, returned in position order."""
    taken: Counter[str] = Counter()
    chosen = []
    for entry in core:
        variant = entry["variant"]
        if taken[variant] < SMOKE_QUOTA.get(variant, 0):
            taken[variant] += 1
            chosen.append(entry["id"])
    if taken != Counter(SMOKE_QUOTA):
        raise FreezeError("SMOKE_QUOTA_NOT_MET")
    return chosen


def _regression_entry(source: Path) -> tuple[dict[str, Any], dict[str, bytes]]:
    """The real case of T3.7: Gemini dropped the -224 branch suffix of this document's tax code."""
    import pypdfium2

    pdf = source.with_suffix(".pdf").read_bytes()
    answer = source.with_suffix(".expected.json").read_bytes()
    invoice = json.loads(answer)
    document = pypdfium2.PdfDocument(pdf)
    try:
        pages = len(document)
    finally:
        document.close()
    files = {"regression-00.expected.json": answer, "regression-00.pdf": pdf}
    entry = {
        "id": "regression-00",
        "difficulty": "regression",
        "variant": "pdf-minimal",
        "layout": "minimal",
        "locale": "vi",
        "currency": invoice["currency"],
        "lineCount": len(invoice["lines"]),
        "pages": pages,
        "primary": "regression-00.pdf",
        "files": {name: sha256(content) for name, content in sorted(files.items())},
    }
    return entry, files


def _read_checked(source: Path, entry: dict[str, Any]) -> dict[str, bytes]:
    contents = {}
    for name, expected in entry["files"].items():
        path = source / name
        if not path.is_file():
            raise FreezeError(f"{entry['id']} FILE_MISSING")
        contents[name] = path.read_bytes()
        if sha256(contents[name]) != expected:
            raise FreezeError(f"{entry['id']} HASH_MISMATCH")
    return contents


def _write_all(target: Path, contents: dict[str, bytes], manifest: dict[str, Any]) -> None:
    """Written beside the target and renamed last: a failed write must not look frozen."""
    partial = target.with_name(f"{target.name}.partial")
    if partial.exists():  # left by a killed run; only ever this name
        shutil.rmtree(partial)
    try:
        documents = partial / "documents"
        documents.mkdir(parents=True)
        for name, content in contents.items():
            (documents / name).write_bytes(content)
        text = json.dumps(manifest, indent=2) + "\n"
        (partial / "manifest.json").write_text(text, encoding="utf-8")
        partial.rename(target)
    except OSError:
        shutil.rmtree(partial, ignore_errors=True)
        raise


def freeze(source: Path, target: Path, regression: Path, generator: dict[str, str]) -> dict:
    """Everything is read and checked before the first write, so a refused source writes nothing."""
    if target.exists():
        raise FreezeError("TARGET_EXISTS")
    source_manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    if source_manifest["seed"] != SEED or source_manifest["count"] != CORE_COUNT:
        raise FreezeError("UNEXPECTED_SEED_OR_COUNT")
    entries = source_manifest["documents"]
    core = [entry for entry in entries if "attack" not in entry]
    injection = [entry for entry in entries if "attack" in entry]
    if len(core) != CORE_COUNT or len(injection) != INJECTION_COUNT:
        raise FreezeError("UNEXPECTED_DOCUMENT_COUNT")
    contents: dict[str, bytes] = {}
    for entry in entries:
        contents.update(_read_checked(source, entry))
    regression_entry, regression_files = _regression_entry(regression)
    contents.update(regression_files)
    manifest = {
        "schemaVersion": 1,
        "name": "v1",
        "generator": {"tool": "tools/invoice-gen", "seed": SEED, **generator},
        "splits": {
            "core": [entry["id"] for entry in core],
            "smoke": select_smoke(core),
            "injection": [entry["id"] for entry in injection],
            "regression": [regression_entry["id"]],
        },
        "documents": [*entries, regression_entry],
    }
    _write_all(target, contents, manifest)
    return manifest


def _chromium_version() -> str:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            return str(browser.version)
        finally:
            browser.close()


def main() -> None:
    generator = {"playwright": version("playwright"), "chromium": _chromium_version()}
    try:
        manifest = freeze(OUT_DIR, TARGET, REGRESSION_SOURCE, generator)
    except FreezeError as error:
        raise SystemExit(f"refused: {error}") from error
    sizes = {name: len(ids) for name, ids in manifest["splits"].items()}
    print(f"documents={len(manifest['documents'])} splits={sizes} target=eval/datasets/v1")


if __name__ == "__main__":
    main()
