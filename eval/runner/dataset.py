"""The frozen dataset, checked byte for byte before any model is called (T4.2, ADR 0020)."""

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
DATASET_DIR = REPO / "eval" / "datasets" / "v1"
# Same pin as scripts/check-eval-dataset.mjs. Both fail closed, so a new version (v2) cannot slip
# through one of them unnoticed: change both lines in the same commit.
MANIFEST_SHA256 = "09abbf3843d2cd8345c7f796840bf36d65d0170e5700ced3126d76a115ef2614"
SPLITS = ("smoke", "core", "injection", "regression")


class DatasetError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code} {detail}")
        self.code = code


@dataclass(frozen=True)
class Dataset:
    root: Path
    name: str
    manifest_sha256: str
    splits: dict[str, list[str]]
    documents: dict[str, dict[str, Any]]

    def primary(self, doc_id: str) -> bytes:
        return (self.root / "documents" / self.documents[doc_id]["primary"]).read_bytes()

    def expected(self, doc_id: str) -> dict[str, Any]:
        path = self.root / "documents" / f"{doc_id}.expected.json"
        return json.loads(path.read_text(encoding="utf-8"))


def source_type(primary: str) -> str:
    if primary.endswith(".pdf"):
        return "pdf"
    if primary.endswith((".png", ".jpg")):
        return "image"
    raise DatasetError("BAD_PRIMARY", primary)


def _safe_name(name: str) -> bool:
    return bool(name) and "/" not in name and "\\" not in name and not name.startswith(".")


def load(root: Path = DATASET_DIR, pinned: str = MANIFEST_SHA256) -> Dataset:
    """Every file of every document is hashed, not only the split about to run: a changed file
    anywhere means this is no longer the set the scores are compared on."""
    raw = (root / "manifest.json").read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != pinned:
        raise DatasetError("MANIFEST_CHANGED", digest)
    manifest = json.loads(raw)
    documents = {d["id"]: d for d in manifest["documents"]}
    for doc_id, doc in documents.items():
        if doc["primary"] not in doc["files"] or f"{doc_id}.expected.json" not in doc["files"]:
            raise DatasetError("FILE_NOT_LISTED", doc_id)
        for name, want in doc["files"].items():
            if not _safe_name(name):
                raise DatasetError("BAD_FILE_NAME", doc_id)
            path = root / "documents" / name
            if not path.is_file():
                raise DatasetError("FILE_MISSING", name)
            if hashlib.sha256(path.read_bytes()).hexdigest() != want:
                raise DatasetError("HASH_MISMATCH", name)
        source_type(doc["primary"])
    for split, ids in manifest["splits"].items():
        if any(i not in documents for i in ids):
            raise DatasetError("UNKNOWN_DOCUMENT", split)
    return Dataset(root, manifest["name"], digest, manifest["splits"], documents)
