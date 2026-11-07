"""CLI: `pnpm gen:invoices --n 100 --seed 42` writes the synthetic dataset to invoice-gen/out/.

Every document has <id>.expected.json (ground truth), <id>.xml and <id>.pdf, plus a picture for the
image variants. manifest.json names the difficulty, the file to feed the pipeline (`primary`) and
the hash of each file. It holds no timestamp: the same seed must give the same bytes.

The output folder is fixed on purpose: a path from the command line could write or clear anywhere.
"""

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from gen_data import Document, build_document
from gen_render import Renderer, ground_truth_bytes, open_renderer, xml_bytes

OUT_DIR = Path(__file__).resolve().parent / "out"
GOLDEN_DIR = Path(__file__).resolve().parents[2] / "packages/contracts/fixtures/generated"
GOLDEN_COUNT = 10
GOLDEN_SEED = 42
MAX_DOCUMENTS = 1000


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def golden_files() -> dict[str, bytes]:
    """The data of the first documents, without a browser: lets CI catch a change in the data."""
    files = {}
    for index in range(GOLDEN_COUNT):
        doc = build_document(GOLDEN_SEED, index)
        files[f"{doc.id}.expected.json"] = ground_truth_bytes(doc.invoice)
        files[f"{doc.id}.xml"] = xml_bytes(doc.invoice)
    return files


def _pdf_page_count(pdf: bytes) -> int:
    import pypdfium2

    document = pypdfium2.PdfDocument(pdf)
    try:
        return len(document)
    finally:
        document.close()


def _render_files(doc: Document, renderer: Renderer) -> tuple[dict[str, bytes], str, int]:
    pdf = renderer.pdf(doc)
    files = {
        f"{doc.id}.expected.json": ground_truth_bytes(doc.invoice),
        f"{doc.id}.xml": xml_bytes(doc.invoice),
        f"{doc.id}.pdf": pdf,
    }
    primary = f"{doc.id}.pdf"
    spec = doc.variant.image
    if spec is not None:
        primary = f"{doc.id}.{'png' if spec.kind == 'png' else 'jpg'}"
        files[primary] = renderer.image(doc)
    return files, primary, _pdf_page_count(pdf)


def manifest_entry(doc: Document, files: dict[str, bytes], primary: str, pages: int) -> dict:
    return {
        "id": doc.id,
        "difficulty": doc.difficulty,
        "variant": doc.variant.name,
        "layout": doc.layout,
        "locale": doc.locale,
        "currency": doc.invoice["currency"],
        "lineCount": len(doc.invoice["lines"]),
        "pages": pages,
        "primary": primary,
        "files": {name: sha256(content) for name, content in sorted(files.items())},
    }


def generate(out_dir: Path, seed: int, count: int) -> dict[str, Any]:
    """Replaces the dataset in out_dir and returns the manifest. Other files are not touched."""
    out_dir.mkdir(parents=True, exist_ok=True)
    # A smaller --n must not leave old documents behind. Only our own names: never a whole folder.
    for path in [*out_dir.glob("invoice-*"), out_dir / "manifest.json"]:
        path.unlink(missing_ok=True)
    entries = []
    with open_renderer() as renderer:
        for index in range(count):
            doc = build_document(seed, index)
            files, primary, pages = _render_files(doc, renderer)
            for name, content in files.items():
                (out_dir / name).write_bytes(content)
            entries.append(manifest_entry(doc, files, primary, pages))
    manifest = {"schemaVersion": 1, "seed": seed, "count": count, "documents": entries}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--n", type=int, default=100)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--write-golden",
        action="store_true",
        help=f"rewrite {GOLDEN_COUNT} data samples in packages/contracts/fixtures/generated",
    )
    args = parser.parse_args()
    if args.write_golden:
        GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
        for name, content in golden_files().items():
            (GOLDEN_DIR / name).write_bytes(content)
        print(f"wrote {GOLDEN_COUNT} golden documents")
        return
    if not 1 <= args.n <= MAX_DOCUMENTS or args.seed < 0:
        parser.error(f"--n must be 1..{MAX_DOCUMENTS} and --seed must not be negative")
    manifest = generate(OUT_DIR, args.seed, args.n)
    size = sum(path.stat().st_size for path in OUT_DIR.iterdir())
    digest = sha256((OUT_DIR / "manifest.json").read_bytes())
    print(f"documents={len(manifest['documents'])} bytes={size} manifest_sha256={digest}")


if __name__ == "__main__":
    main()
