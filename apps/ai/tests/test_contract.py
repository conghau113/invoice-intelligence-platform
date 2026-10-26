"""Cross-language contract test: the same fixtures are validated by Zod in packages/contracts."""

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.schemas.generated import Invoice

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures"


def load(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def names(prefix: str) -> list[str]:
    return sorted(p.name for p in FIXTURES.glob(f"{prefix}*.json"))


def test_fixture_glob_is_not_empty() -> None:
    assert len(names("invoice.valid")) + len(names("invoice.invalid")) >= 5


@pytest.mark.parametrize("name", names("invoice.valid"))
def test_valid_fixture_passes(name: str) -> None:
    Invoice.model_validate(load(name))


@pytest.mark.parametrize("name", names("invoice.invalid"))
def test_invalid_fixture_fails(name: str) -> None:
    with pytest.raises(ValidationError):
        Invoice.model_validate(load(name))


def _del(d: dict[str, Any], *path: str) -> None:
    for key in path[:-1]:
        d = d[key]
    del d[path[-1]]


# Each row changes ONE thing in the valid fixture and must fail at the given location.
# packages/contracts/test/contract.spec.ts has the same table.
MUTATIONS: list[tuple[str, Callable[[dict[str, Any]], None], tuple[str, ...]]] = [
    ("fractional money", lambda d: d.update(total=10.5), ("total",)),
    ("numeric-string money", lambda d: d.update(total="1100000"), ("total",)),
    ("date as datetime", lambda d: d.update(issueDate="2026-03-15T00:00:00"), ("issueDate",)),
    ("date that does not exist", lambda d: d.update(issueDate="2026-02-30"), ("issueDate",)),
    ("date as epoch integer", lambda d: d.update(issueDate=1773532800), ("issueDate",)),
    ("date in Arabic-Indic digits", lambda d: d.update(issueDate="٢٠٢٦-٠٣-١٥"), ("issueDate",)),
    (
        "tax code in Arabic-Indic digits",
        lambda d: d["seller"].update(taxCode="٠١٢٣٤٥٦٧٨٩"),
        ("seller", "taxCode"),
    ),
    ("buyer tax code absent", lambda d: _del(d, "buyer", "taxCode"), ("buyer", "taxCode")),
    (
        "confidence above 1",
        lambda d: d["fieldMeta"]["total"].update(confidence=1.5),
        ("fieldMeta", "total"),
    ),
    (
        "confidence below 0",
        lambda d: d["fieldMeta"]["total"].update(confidence=-0.1),
        ("fieldMeta", "total"),
    ),
    (
        "evidence absent",
        lambda d: _del(d, "fieldMeta", "total", "evidence"),
        ("fieldMeta", "total"),
    ),
    (
        "evidence page 0",
        lambda d: d["fieldMeta"]["total"]["evidence"].update(page=0),
        ("fieldMeta", "total"),
    ),
    (
        "evidence text too long",
        lambda d: d["fieldMeta"]["total"]["evidence"].update(text="x" * 501),
        ("fieldMeta", "total"),
    ),
    (
        "fieldMeta key not a field",
        lambda d: d["fieldMeta"].update({"seller.foo": {"confidence": 1, "evidence": None}}),
        ("fieldMeta",),
    ),
    ("fieldMeta missing", lambda d: _del(d, "fieldMeta"), ("fieldMeta",)),
    ("no line items", lambda d: d.update(lines=[]), ("lines",)),
]


@pytest.mark.parametrize(("label", "mutate", "path"), MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_mutation_fails_at_expected_path(
    label: str, mutate: Callable[[dict[str, Any]], None], path: tuple[str, ...]
) -> None:
    doc = copy.deepcopy(load("invoice.valid.json"))
    mutate(doc)
    with pytest.raises(ValidationError) as info:
        Invoice.model_validate(doc)
    assert any(tuple(e["loc"][: len(path)]) == path for e in info.value.errors()), label


def test_unknown_key_is_rejected_and_named() -> None:
    with pytest.raises(ValidationError) as info:
        Invoice.model_validate({**load("invoice.valid.json"), "surprise": 1})
    errors = info.value.errors()
    assert [(e["type"], e["loc"]) for e in errors] == [("extra_forbidden", ("surprise",))]


def test_null_buyer_tax_code_and_null_evidence_pass() -> None:
    doc = load("invoice.valid.json")
    doc["buyer"]["taxCode"] = None
    doc["fieldMeta"]["total"]["evidence"] = None
    Invoice.model_validate(doc)
