"""Freezing the eval dataset (T4.2): runs the real copy on small files, no browser, no model."""

import hashlib
import importlib
import json
import sys
from collections import Counter
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[3]
GENERATOR_DIR = REPO / "tools" / "invoice-gen"
REGRESSION = REPO / "apps/ai/tests/fixtures/pdf_invoices/invoice-00"
MODULES = ("freeze_dataset", "gen_data", "min_xml")
GENERATOR = {"playwright": "test", "chromium": "test"}


@pytest.fixture(scope="module")
def gen() -> Iterator[SimpleNamespace]:
    sys.path.insert(0, str(GENERATOR_DIR))
    try:
        yield SimpleNamespace(
            freeze=importlib.import_module("freeze_dataset"),
            data=importlib.import_module("gen_data"),
        )
    finally:
        sys.path.remove(str(GENERATOR_DIR))
        for name in MODULES:
            sys.modules.pop(name, None)


def _core_entries(gen: SimpleNamespace) -> list[dict[str, Any]]:
    """What the manifest says about the real 100 documents; building them needs no browser."""
    entries = []
    for index in range(100):
        doc = gen.data.build_document(42, index)
        entries.append({"id": doc.id, "variant": doc.variant.name, "difficulty": doc.difficulty})
    return entries


def _source(gen: SimpleNamespace, root: Path) -> Path:
    """A small dataset in the shape `generate` writes: one short file per document."""
    root.mkdir()
    entries = _core_entries(gen)
    entries += [
        {
            "id": f"injection-{i:02d}",
            "difficulty": "injection",
            "attack": {"goal": {"path": "total"}},
        }
        for i in range(24)
    ]
    for entry in entries:
        content = entry["id"].encode()
        name = f"{entry['id']}.expected.json"
        (root / name).write_bytes(content)
        entry["files"] = {name: hashlib.sha256(content).hexdigest()}
    manifest = {"schemaVersion": 1, "seed": 42, "count": 100, "documents": entries}
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def test_smoke_keeps_the_mix_and_holds_the_exif_variant(gen: SimpleNamespace) -> None:
    entries = _core_entries(gen)
    smoke = gen.freeze.select_smoke(entries)
    by_id = {entry["id"]: entry for entry in entries}
    assert len(smoke) == 20
    assert Counter(by_id[id_]["difficulty"] for id_ in smoke) == {"easy": 8, "medium": 8, "hard": 4}
    variants = {by_id[id_]["variant"] for id_ in smoke}
    assert "jpeg-exif-rotated" in variants
    assert "pdf-multi-page" in variants
    assert "jpeg-tilt-noise" not in variants


def test_smoke_refuses_a_dataset_that_cannot_fill_it(gen: SimpleNamespace) -> None:
    entries = [e for e in _core_entries(gen) if e["variant"] != "jpeg-exif-rotated"]
    with pytest.raises(gen.freeze.FreezeError, match="SMOKE_QUOTA_NOT_MET"):
        gen.freeze.select_smoke(entries)


def test_freeze_copies_every_file_and_records_the_splits(
    gen: SimpleNamespace, tmp_path: Path
) -> None:
    target = tmp_path / "v1"
    gen.freeze.freeze(_source(gen, tmp_path / "out"), target, REGRESSION, GENERATOR)
    manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
    assert {name: len(ids) for name, ids in manifest["splits"].items()} == {
        "core": 100,
        "smoke": 20,
        "injection": 24,
        "regression": 1,
    }
    assert manifest["generator"]["seed"] == 42
    for entry in manifest["documents"]:
        for name, digest in entry["files"].items():
            assert hashlib.sha256((target / "documents" / name).read_bytes()).hexdigest() == digest


def test_the_regression_document_keeps_the_full_tax_code(
    gen: SimpleNamespace, tmp_path: Path
) -> None:
    """The case T3.7 saw: without the suffix in the answer, a cut value would score as right."""
    target = tmp_path / "v1"
    gen.freeze.freeze(_source(gen, tmp_path / "out"), target, REGRESSION, GENERATOR)
    answer = json.loads((target / "documents/regression-00.expected.json").read_text("utf-8"))
    assert answer["seller"]["taxCode"].endswith("-224")


def test_freeze_refuses_to_overwrite_a_frozen_dataset(gen: SimpleNamespace, tmp_path: Path) -> None:
    target = tmp_path / "v1"
    target.mkdir()
    (target / "keep").write_text("frozen", encoding="utf-8")
    with pytest.raises(gen.freeze.FreezeError, match="TARGET_EXISTS"):
        gen.freeze.freeze(_source(gen, tmp_path / "out"), target, REGRESSION, GENERATOR)
    assert (target / "keep").read_text(encoding="utf-8") == "frozen"


def test_freeze_writes_nothing_when_a_source_file_changed(
    gen: SimpleNamespace, tmp_path: Path
) -> None:
    source = _source(gen, tmp_path / "out")
    (source / "invoice-0042.expected.json").write_bytes(b"changed")
    target = tmp_path / "v1"
    with pytest.raises(gen.freeze.FreezeError, match="invoice-0042 HASH_MISMATCH"):
        gen.freeze.freeze(source, target, REGRESSION, GENERATOR)
    assert not target.exists()


def test_freeze_writes_nothing_when_a_source_file_is_missing(
    gen: SimpleNamespace, tmp_path: Path
) -> None:
    source = _source(gen, tmp_path / "out")
    (source / "invoice-0042.expected.json").unlink()
    target = tmp_path / "v1"
    with pytest.raises(gen.freeze.FreezeError, match="invoice-0042 FILE_MISSING"):
        gen.freeze.freeze(source, target, REGRESSION, GENERATOR)
    assert not target.exists()


def test_a_write_that_fails_leaves_nothing_that_looks_frozen(
    gen: SimpleNamespace, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = _source(gen, tmp_path / "out")
    target = tmp_path / "v1"

    def disk_full(*_args: Any, **_kwargs: Any) -> int:
        raise OSError("no space left")

    with monkeypatch.context() as patch:
        patch.setattr(Path, "write_text", disk_full)
        with pytest.raises(OSError, match="no space left"):
            gen.freeze.freeze(source, target, REGRESSION, GENERATOR)
    assert not target.exists()
    assert not (tmp_path / "v1.partial").exists()
    gen.freeze.freeze(source, target, REGRESSION, GENERATOR)  # the next run is not refused
    assert (target / "manifest.json").is_file()


def test_freeze_refuses_another_seed(gen: SimpleNamespace, tmp_path: Path) -> None:
    source = _source(gen, tmp_path / "out")
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    (source / "manifest.json").write_text(json.dumps({**manifest, "seed": 7}), encoding="utf-8")
    with pytest.raises(gen.freeze.FreezeError, match="UNEXPECTED_SEED_OR_COUNT"):
        gen.freeze.freeze(source, tmp_path / "v1", REGRESSION, GENERATOR)


def test_freeze_refuses_a_dataset_without_attack_documents(
    gen: SimpleNamespace, tmp_path: Path
) -> None:
    source = _source(gen, tmp_path / "out")
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    manifest["documents"] = manifest["documents"][:100]
    (source / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(gen.freeze.FreezeError, match="UNEXPECTED_DOCUMENT_COUNT"):
        gen.freeze.freeze(source, tmp_path / "v1", REGRESSION, GENERATOR)
