"""LLM metrics of the AI service (T7.3): real FastAPI app, in-memory reader, fake LLM provider.

Counters are cumulative for the whole test process, so each test reads the change it caused.
"""

import json
import os
from typing import Any

import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from app import otel
from app.main import create_app
from app.providers.base import LLMResult, LLMUnavailable
from app.providers.fake import CANNED_LLM_OUTPUT, FakeProvider
from app.providers.pricing import estimate_cost_usd
from app.services.pdf_pages import encode_png

TENANT = "00000000-0000-4000-8000-0000000000a1"
PNG = encode_png(1, 1, b"\x00\x00\x00", 3)
PII = "TEN-BI-MAT-ABC"  # stands for document text and questions: never a label

Key = tuple[str, tuple[tuple[str, Any], ...]]


@pytest.fixture(scope="module")
def reader() -> InMemoryMetricReader:
    reader = InMemoryMetricReader()
    assert otel.setup_metrics(reader) is True
    return reader


def snapshot(reader: InMemoryMetricReader) -> dict[Key, float]:
    data = reader.get_metrics_data()
    values: dict[Key, float] = {}
    for rm in data.resource_metrics if data else []:
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                for point in metric.data.data_points:  # type: ignore[union-attr]
                    labels = tuple(sorted((point.attributes or {}).items()))
                    # A counter has a value; a histogram (should one get through) its count.
                    value = point.value if hasattr(point, "value") else point.count  # type: ignore[union-attr]
                    values[(metric.name, labels)] = value
    return values


@pytest.fixture
def delta(reader: InMemoryMetricReader):
    """What changed since the test started: {(metric, labels): increase}."""
    before = snapshot(reader)

    def read() -> dict[Key, float]:
        after = snapshot(reader)
        return {k: v - before.get(k, 0) for k, v in after.items() if v != before.get(k, 0)}

    return read


def labels(**kv: str) -> tuple[tuple[str, Any], ...]:
    return tuple(sorted(kv.items()))


@pytest.fixture
def client(reader: InMemoryMetricReader, monkeypatch: pytest.MonkeyPatch):
    app = create_app()

    def make(provider: FakeProvider, tenant: str | None = TENANT) -> TestClient:
        monkeypatch.setattr(app.state, "llm_provider", provider, raising=False)
        headers = {"Authorization": f"Bearer {os.environ['AI_SERVICE_TOKEN']}"}
        if tenant is not None:
            headers["X-Tenant-Id"] = tenant
        return TestClient(app, headers=headers)

    return make


def test_metrics_stay_off_without_an_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    assert otel.setup_metrics() is False


def test_extract_counts_tokens_cost_and_the_call_by_tenant(client, delta) -> None:
    res = client(FakeProvider([json.dumps(CANNED_LLM_OUTPUT)])).post(
        "/extract", files={"file": ("f", PNG)}, data={"sourceType": "image"}
    )
    assert res.status_code == 200

    who = {"tenant_id": TENANT, "operation": "extract", "model": "fake-model"}
    assert delta() == {
        ("llm.calls", labels(**who, outcome="ok")): 1,
        ("llm.tokens", labels(**who, token_type="input")): 1000,
        ("llm.tokens", labels(**who, token_type="output")): 200,
        ("llm.cost.list_price_usd", labels(**who)): pytest.approx(
            estimate_cost_usd("fake-model", 1000, 200)
        ),
    }


def test_each_attempt_is_counted(client, delta) -> None:
    """A first answer that fails validation is retried: both calls were billed."""
    provider = FakeProvider(["not json", json.dumps(CANNED_LLM_OUTPUT)])
    res = client(provider).post(
        "/extract", files={"file": ("f", PNG)}, data={"sourceType": "image"}
    )
    assert res.status_code == 200
    who = {"tenant_id": TENANT, "operation": "extract", "model": "fake-model"}
    assert delta()[("llm.calls", labels(**who, outcome="ok"))] == 2


@pytest.mark.parametrize(
    ("path", "body", "answer"),
    [
        (
            "/classify",
            {"question": f"Ai bán {PII}?", "today": "2026-11-11"},
            {"intent": "lookup"},
        ),
        (
            "/answer",
            {"question": f"Ai bán {PII}?", "sources": [{"n": 1, "content": PII}]},
            {"insufficientEvidence": True, "answer": "Không đủ thông tin."},
        ),
    ],
)
def test_questions_are_counted_under_their_operation(client, delta, path, body, answer) -> None:
    provider = FakeProvider(
        [LLMResult(text=json.dumps(answer), model="fake-model", input_tokens=40, output_tokens=8)]
    )
    assert client(provider).post(path, json=body).status_code == 200

    changed = delta()
    operation = path.removeprefix("/")
    who = {"tenant_id": TENANT, "operation": operation, "model": "fake-model"}
    assert changed[("llm.tokens", labels(**who, token_type="input"))] == 40
    assert PII not in json.dumps([k for k in changed], default=str)


@pytest.mark.parametrize("header", [None, "not-a-uuid", f"{TENANT}x"])
def test_a_missing_or_malformed_tenant_is_none(client, delta, header) -> None:
    res = client(FakeProvider([json.dumps(CANNED_LLM_OUTPUT)]), tenant=header).post(
        "/extract", files={"file": ("f", PNG)}, data={"sourceType": "image"}
    )
    assert res.status_code == 200
    tenants = {dict(k[1]).get("tenant_id") for k in delta()}
    assert tenants == {otel.NO_TENANT}


def test_a_failed_call_is_counted_without_tokens(client, delta) -> None:
    res = client(FakeProvider([LLMUnavailable("LLM_RATE_LIMITED")])).post(
        "/classify", json={"question": "q", "today": "2026-11-11"}
    )
    assert res.status_code == 503
    who = {"tenant_id": TENANT, "operation": "classify", "model": "fake-model"}
    assert delta() == {("llm.calls", labels(**who, outcome="error")): 1}


def test_an_unknown_operation_is_other(delta) -> None:
    provider = FakeProvider(
        [LLMResult(text="{}", model="fake-model", input_tokens=1, output_tokens=1)]
    )
    otel.TracedLLMProvider(provider, operation=PII).generate(
        system="s", user_text="u", images=[], json_schema={}
    )
    operations = {dict(k[1])["operation"] for k in delta()}
    assert operations == {"other"}


def test_http_histograms_of_the_instrumentations_are_dropped(reader, delta) -> None:
    from opentelemetry import metrics

    metrics.get_meter("opentelemetry.instrumentation.fastapi").create_histogram(
        "http.server.duration"
    ).record(12.0)
    names = {name for name, _ in snapshot(reader)}
    assert not any(n.startswith("http.") for n in names)
    assert delta() == {}
