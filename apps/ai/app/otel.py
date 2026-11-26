"""OpenTelemetry tracing for the AI service (T7.1, ADR 0015).

Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set: tests, CI and a plain dev server start no SDK, and
the tracer calls below are then no-ops. The OTLP exporter reads the standard variables itself
(endpoint, headers with the Grafana Cloud token) from the process environment, not from the
service's own env file.

Traced: incoming requests (continuing the `traceparent` the API worker sends), outgoing httpx calls
(the provider's REST API) and one manual span per LLM call. Spans carry names, sizes and codes,
never document content, prompts, answers or query strings.
"""

import os
from typing import Any

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

from app.providers.base import ImagePart, LLMError, LLMProvider, LLMResult

SERVICE_NAME = "invoice-ai"
_tracer = trace.get_tracer(SERVICE_NAME)

# Attributes that may carry a query string: user input never leaves in a span.
_URL_ATTRIBUTES = ("url.full", "http.url", "http.target")
_QUERY_ATTRIBUTE = "url.query"
_REDACTED = "REDACTED"

# The SDK TracerProvider once started (Any: the SDK is imported lazily). A dict, not a `global`.
_state: dict[str, Any] = {"provider": None}


def without_query(url: str) -> str:
    for mark in ("?", "#"):
        url = url.split(mark, 1)[0]
    return url


def strip_query(span: Span, *_: Any) -> None:
    """Hook for the HTTP instrumentations: rewrites URL attributes set when the span started."""
    attributes = getattr(span, "attributes", None) or {}
    for key in _URL_ATTRIBUTES:
        value = attributes.get(key)
        if isinstance(value, str):
            span.set_attribute(key, without_query(value))
    if attributes.get(_QUERY_ATTRIBUTE) is not None:
        span.set_attribute(_QUERY_ATTRIBUTE, _REDACTED)


def setup_tracing(app: FastAPI, exporter: Any = None) -> bool:
    """Starts the SDK once per process and instruments `app`. `exporter`: tests (in memory)."""
    if exporter is None and not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return False
    # Imported here so a process without tracing never loads the SDK.
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = _state["provider"]
    if provider is None:
        if exporter is None:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

            exporter = OTLPSpanExporter()
        # The provider flushes its batch at interpreter exit (shutdown_on_exit).
        provider = TracerProvider(resource=Resource.create({"service.name": SERVICE_NAME}))
        provider.add_span_processor(BatchSpanProcessor(RedactingExporter(exporter)))
        trace.set_tracer_provider(provider)
        _state["provider"] = provider
        # The provider key travels in a header (x-goog-api-key), never in the URL.
        HTTPXClientInstrumentor().instrument(tracer_provider=provider, request_hook=strip_query)
    FastAPIInstrumentor.instrument_app(
        app,
        tracer_provider=provider,
        server_request_hook=strip_query,
        # Probes say nothing about a request; per-message ASGI spans only add volume.
        excluded_urls="health",
        exclude_spans=["receive", "send"],
    )
    return True


_EXCEPTION_EVENT = "exception"


def redact(span: Any) -> Any:
    """`span` without what instrumentations copy from an exception (a `ReadableSpan` either way).

    FastAPI, ASGI and httpx record an `exception` event (message, stacktrace) and a status
    description; a pydantic or provider error message can quote document text or a model answer.
    Only the exception's type is kept, as `error.type`. Spans are immutable once ended, so a span
    that needs it is rebuilt (the SDK prefers not to; its constructor is public and stable).
    """
    from opentelemetry.sdk.trace import ReadableSpan

    exception = next((e for e in span.events if e.name == _EXCEPTION_EVENT), None)
    if exception is None and span.status.description is None:
        return span
    attributes = dict(span.attributes or {})
    kind = (exception.attributes or {}).get("exception.type") if exception else None
    if "error.type" not in attributes and isinstance(kind, str):
        attributes["error.type"] = kind
    return ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=attributes,
        events=[e for e in span.events if e.name != _EXCEPTION_EVENT],
        links=span.links,
        kind=span.kind,
        status=Status(span.status.status_code),
        start_time=span.start_time,
        end_time=span.end_time,
        instrumentation_scope=span.instrumentation_scope,
    )


class RedactingExporter:
    """Hands every span to `inner` through `redact` (the one place all spans pass)."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def export(self, spans: Any) -> Any:
        return self._inner.export([redact(s) for s in spans])

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return bool(self._inner.force_flush(timeout_millis))


def flush_tracing() -> None:
    """Exports the spans waiting in the batch now (tests read the exporter right after)."""
    if _state["provider"] is not None:
        _state["provider"].force_flush()


class TracedLLMProvider:
    """An LLMProvider whose every call is one CLIENT span (GenAI semantic conventions).

    Attributes: provider name, model, token counts and whether the answer was cut. No prompt, no
    answer, no image: the arguments and `LLMResult.text` are never read here. A failed call records
    the error code only (an `LLMError` code is registered in error_codes.py).
    """

    def __init__(self, inner: LLMProvider) -> None:
        self._inner = inner
        self.name = inner.name
        self.model = inner.model
        self.timeout_s = inner.timeout_s

    def generate(
        self,
        *,
        system: str,
        user_text: str,
        images: list[ImagePart],
        json_schema: dict[str, Any],
    ) -> LLMResult:
        with _tracer.start_as_current_span(
            f"chat {self.model}",
            kind=SpanKind.CLIENT,
            attributes={
                "gen_ai.operation.name": "chat",
                "gen_ai.provider.name": self.name,
                "gen_ai.request.model": self.model,
                "llm.request.images": len(images),
            },
            # The default records the exception message, which may quote the provider's answer.
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                result = self._inner.generate(
                    system=system, user_text=user_text, images=images, json_schema=json_schema
                )
            except LLMError as e:
                span.set_status(Status(StatusCode.ERROR))
                span.set_attribute("error.type", e.code)
                raise
            except Exception as e:
                span.set_status(Status(StatusCode.ERROR))
                span.set_attribute("error.type", type(e).__name__)
                raise
            span.set_attribute("gen_ai.response.model", result.model)
            span.set_attribute("gen_ai.usage.input_tokens", result.input_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", result.output_tokens)
            span.set_attribute("llm.response.truncated", result.truncated)
            return result
