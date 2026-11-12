"""Scripted provider for tests and CI: no network, no key. Never allowed in production."""

import json
from typing import Any

from app.providers.base import ImagePart, LLMError, LLMResult

# A valid, obviously synthetic invoice: what LLM_PROVIDER=fake answers when nothing is scripted.
CANNED_INVOICE = {
    "seller": {"name": "Công ty SAMPLE Bán", "taxCode": "0100000001", "address": "1 Đường Mẫu"},
    "buyer": {"name": "Công ty SAMPLE Mua", "taxCode": None, "address": "2 Đường Mẫu"},
    "invoiceNo": "0000001",
    "series": "C26TSM",
    "issueDate": "2026-01-15",
    "currency": "VND",
    "lines": [
        {
            "description": "Dịch vụ SAMPLE",
            "quantity": 2,
            "unit": "gói",
            "unitPrice": 500000,
            "vatRate": 10,
            "amount": 1000000,
        }
    ],
    "subtotal": 1000000,
    "vatBreakdown": [{"rate": 10, "base": 1000000, "amount": 100000}],
    "total": 1100000,
    "fieldMeta": {
        "total": {"confidence": 0.95, "evidence": {"page": 1, "text": "Tổng cộng 1.100.000"}},
        "invoiceNo": {"confidence": 0.6, "evidence": None},
    },
}

# What the MODEL answers (fieldMeta as a list, see services/extract.invoice_json_schema).
CANNED_LLM_OUTPUT = {
    **CANNED_INVOICE,
    "fieldMeta": [
        {"path": path, **meta}
        for path, meta in CANNED_INVOICE["fieldMeta"].items()  # type: ignore[union-attr]
    ],
}


# Q&A answers when nothing is scripted (T5.4), chosen by the title of the schema asked for, so that
# LLM_PROVIDER=fake runs the whole Q&A path in dev, in the web's browser tests (T5.5) and in load
# tests (M6): every question is a lookup, answered from the first source.
CANNED_BY_SCHEMA_TITLE = {
    "QaRoute": {"intent": "lookup", "filter": None},
    "QaAnswer": {
        "insufficientEvidence": False,
        "answer": "SAMPLE answer from the fake model provider [1].",
    },
}


class FakeProvider:
    name = "fake"
    timeout_s = 0.0

    def __init__(
        self, script: list[str | LLMResult | LLMError] | None = None, model: str = "fake-model"
    ) -> None:
        self.model = model
        self._scripted = bool(script)
        self._script = list(script) if script else [json.dumps(CANNED_LLM_OUTPUT)]
        self.calls: list[dict[str, Any]] = []  # what extract sent, for assertions

    def generate(
        self,
        *,
        system: str,
        user_text: str,
        images: list[ImagePart],
        json_schema: dict[str, Any],
    ) -> LLMResult:
        self.calls.append(
            {"system": system, "user_text": user_text, "images": images, "schema": json_schema}
        )
        canned = CANNED_BY_SCHEMA_TITLE.get(str(json_schema.get("title")))
        if not self._scripted and canned is not None:
            return LLMResult(
                text=json.dumps(canned), model=self.model, input_tokens=300, output_tokens=30
            )
        step = self._script.pop(0) if len(self._script) > 1 else self._script[0]
        if isinstance(step, LLMError):
            raise step
        if isinstance(step, LLMResult):  # a scripted cut answer: tokens and `truncated` as given
            return step
        return LLMResult(text=step, model=self.model, input_tokens=1000, output_tokens=200)
