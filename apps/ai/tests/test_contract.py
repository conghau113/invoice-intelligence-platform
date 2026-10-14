"""Cross-language contract test: the same fixtures are validated by Zod in packages/contracts."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas.generated import InvoiceDraft

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_valid_fixture_passes() -> None:
    InvoiceDraft.model_validate(load("invoice.valid.json"))


def test_invalid_fixture_fails() -> None:
    with pytest.raises(ValidationError):
        InvoiceDraft.model_validate(load("invoice.invalid.json"))


def test_fractional_money_fails() -> None:
    doc = {**load("invoice.valid.json"), "total": 10.5}
    with pytest.raises(ValidationError):
        InvoiceDraft.model_validate(doc)


def test_numeric_string_money_fails() -> None:
    doc = {**load("invoice.valid.json"), "total": "1100000"}
    with pytest.raises(ValidationError):
        InvoiceDraft.model_validate(doc)


def test_unknown_key_fails() -> None:
    doc = {**load("invoice.valid.json"), "surprise": 1}
    with pytest.raises(ValidationError):
        InvoiceDraft.model_validate(doc)
