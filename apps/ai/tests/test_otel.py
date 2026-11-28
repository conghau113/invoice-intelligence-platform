"""Tracing of the AI service (T7.1): real FastAPI app, in-memory exporter, fake LLM provider."""

import json
import os
from typing import Any

import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, StatusCode

from app import otel
from app.main import create_app
from app.providers.base import LLMResult, LLMUnavailable
from app.providers.fake import CANNED_LLM_OUTPUT, FakeProvider
from app.services.pdf_pages import encode_png

TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
API_SPAN = "b7ad6b7169203331"
TRACEPARENT = f"00-{TRACE_ID}-{API_SPAN}-01"
PII = "TEN-BI-MAT-ABC"  # stands for document text: must never reach a span
PNG = encode_png(1, 1, b"\x00\x00\x00", 3)


def test_tracing_stays_off_without_an_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    assert otel.setup_tracing(create_app()) is False


@pytest.fixture(scope="module")
def traced() -> tuple[Any, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    app = create_app()
    assert otel.setup_tracing(app, exporter) is True
    return app, exporter


@pytest.fixture
def spans(traced: tuple[Any, InMemorySpanExporter]):
    _, exporter = traced
    exporter.clear()

    def read() -> list[ReadableSpan]:
        otel.flush_tracing()
        return list(exporter.get_finished_spans())

    return read


@pytest.fixture
def client(traced: tuple[Any, InMemorySpanExporter], monkeypatch: pytest.MonkeyPatch):
    app, _ = traced

    def make(provider: FakeProvider) -> TestClient:
        monkeypatch.setattr(app.state, "llm_provider", provider, raising=False)
        return TestClient(
            app, headers={"Authorization": f"Bearer {os.environ['AI_SERVICE_TOKEN']}"}
        )

    return make


def everything_recorded(recorded: list[ReadableSpan]) -> str:
    return json.dumps(
        [
            {
                "name": s.name,
                "attributes": dict(s.attributes or {}),
                "events": [(e.name, dict(e.attributes or {})) for e in s.events],
                "status": s.status.description,
            }
            for s in recorded
        ],
        default=str,
    )


def test_extract_joins_the_workers_trace_with_an_llm_span(client, spans) -> None:
    res = client(FakeProvider([json.dumps(CANNED_LLM_OUTPUT)])).post(
        "/extract",
        files={"file": ("f", PNG)},
        data={"sourceType": "image"},
        headers={"traceparent": TRACEPARENT},
    )
    assert res.status_code == 200
    recorded = spans()

    server = next(s for s in recorded if s.kind == SpanKind.SERVER)
    assert format(server.context.trace_id, "032x") == TRACE_ID
    assert server.parent is not None
    assert format(server.parent.span_id, "016x") == API_SPAN

    llm = next(s for s in recorded if s.name.startswith("chat "))
    assert llm.kind == SpanKind.CLIENT
    assert llm.context.trace_id == server.context.trace_id
    attributes = dict(llm.attributes or {})
    assert attributes["gen_ai.provider.name"] == "fake"
    assert attributes["gen_ai.request.model"] == "fake-model"
    assert attributes["gen_ai.response.model"] == "fake-model"
    assert (attributes["gen_ai.usage.input_tokens"], attributes["gen_ai.usage.output_tokens"]) == (
        1000,
        200,
    )
    assert attributes["llm.response.truncated"] is False


class EchoingProvider:
    """Answers with the document text, like a model that quotes the invoice."""

    name = "fake"
    model = "fake-model"
    timeout_s = 1.0

    def generate(self, **kwargs: Any) -> LLMResult:
        return LLMResult(
            text=f"{kwargs['user_text']} {PII}", model=self.model, input_tokens=5, output_tokens=7
        )


def test_llm_span_holds_no_prompt_and_no_answer(spans) -> None:
    traced = otel.TracedLLMProvider(EchoingProvider())  # type: ignore[arg-type]
    traced.generate(system=f"system {PII}", user_text=f"user {PII}", images=[], json_schema={})
    recorded = spans()
    assert [s.name for s in recorded] == ["chat fake-model"]
    assert PII not in everything_recorded(recorded)


def test_failed_llm_call_records_its_code_only(spans) -> None:
    traced = otel.TracedLLMProvider(FakeProvider([LLMUnavailable("LLM_RATE_LIMITED")]))
    with pytest.raises(LLMUnavailable):
        traced.generate(system="s", user_text="u", images=[], json_schema={})
    (span,) = spans()
    assert span.status.status_code == StatusCode.ERROR
    assert (span.attributes or {})["error.type"] == "LLM_RATE_LIMITED"
    assert span.events == ()  # no exception event: its message could quote the provider


def test_query_string_never_reaches_a_span(client, spans) -> None:
    client(FakeProvider([])).post(f"/extract?q={PII}", data={"sourceType": "xml"})
    recorded = spans()
    server = next(s for s in recorded if s.kind == SpanKind.SERVER)
    assert (server.attributes or {}).get("url.query") in (None, "REDACTED")
    assert PII not in everything_recorded(recorded)


def test_an_unhandled_error_reaches_a_span_by_its_type_only(traced, spans) -> None:
    """FastAPI and ASGI record the exception (message, stacktrace): only its type may leave."""
    app, _ = traced

    async def boom() -> None:
        raise ValueError(f"input_value='{PII}'")  # like a pydantic error quoting the document

    app.add_api_route("/otel-test-boom", boom, methods=["GET"])
    res = TestClient(app, raise_server_exceptions=False).get("/otel-test-boom")
    assert res.status_code == 500
    recorded = spans()

    server = next(s for s in recorded if s.kind == SpanKind.SERVER)
    assert server.status.status_code == StatusCode.ERROR
    assert server.status.description is None
    assert (server.attributes or {}).get("error.type") == "ValueError"
    assert all(e.name != "exception" for s in recorded for e in s.events)
    assert PII not in everything_recorded(recorded)


def test_setting_tracing_up_twice_does_not_double_the_spans(traced, client, spans) -> None:
    app, exporter = traced
    assert otel.setup_tracing(app, exporter) is True  # e.g. a second create_app in one process
    client(FakeProvider([])).post("/extract", data={"sourceType": "xml"})
    assert len([s for s in spans() if s.kind == SpanKind.SERVER]) == 1
