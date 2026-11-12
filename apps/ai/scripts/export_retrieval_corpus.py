"""Writes the corpus of the API's retrieval test (T5.3): the chunks of the 100 `core` invoices of
the frozen eval set, made by the real `chunk_invoice` (T5.1). The API test cannot run Python, so it
reads this file; `tests/test_retrieval_corpus.py` fails when chunking changes and the file was not
written again. Synthetic data only (eval/datasets/v1).

    cd apps/ai && uv run python -m scripts.export_retrieval_corpus
"""

import json
import sys
import uuid
from pathlib import Path
from typing import Any

from app.services.chunking import ApprovedInvoiceRow, chunk_invoice

ROOT = Path(__file__).resolve().parents[3]
DATASET = ROOT / "eval" / "datasets" / "v1"
OUTPUT = ROOT / "apps" / "api" / "test" / "fixtures" / "retrieval" / "corpus.json"
# Fixed ids so that the same dataset always gives the same file (chunk text holds no id).
NAMESPACE = uuid.UUID("5e7a0c3e-0000-4000-8000-00000000c053")


def build_corpus() -> dict[str, Any]:
    manifest = json.loads((DATASET / "manifest.json").read_text(encoding="utf-8"))
    invoices = []
    for dataset_id in manifest["splits"]["core"]:
        expected = DATASET / "documents" / f"{dataset_id}.expected.json"
        data = json.loads(expected.read_text(encoding="utf-8"))
        row = ApprovedInvoiceRow(
            id=uuid.uuid5(NAMESPACE, f"invoice/{dataset_id}"),
            tenant_id=uuid.uuid5(NAMESPACE, "tenant"),
            document_id=uuid.uuid5(NAMESPACE, f"document/{dataset_id}"),
            document_version=1,
            data=data,
        )
        chunks = [
            {"kind": c.kind, "ordinal": c.ordinal, "content": c.content} for c in chunk_invoice(row)
        ]
        invoices.append({"datasetId": dataset_id, "chunks": chunks})
    return {
        "source": "eval/datasets/v1 split core, chunked by apps/ai/app/services/chunking.py",
        "invoices": invoices,
    }


def main() -> int:
    OUTPUT.write_text(
        json.dumps(build_corpus(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(f"wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
