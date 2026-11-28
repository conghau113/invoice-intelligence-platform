"""OpenTelemetry tracing and LLM metrics for the AI service (T7.1, T7.3, ADR 0015).

Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set: tests, CI and a plain dev server start no SDK, and
the tracer calls below are then no-ops. The OTLP exporter reads the standard variables itself
(endpoint, headers with the Grafana Cloud token) from the process environment, not from the
service's own env file.

Traced: incoming requests (continuing the `traceparent` the API worker sends), outgoing httpx calls
(the provider's REST API) and one manual span per LLM call. Spans carry names, sizes and codes,
never document content, prompts, answers or query strings.

Metrics (T7.3), under the same condition: tokens, list-price cost and calls of every LLM call, by
tenant, operation and model. Every call goes through `TracedLLMProvider`, so it is the one place
they are counted, retries included.
"""

import os
from typing import Any

from fastapi import FastAPI
from opentelemetry import metrics, trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

from app.logging import tenant_id_var
from app.providers.base import ImagePart, LLMError, LLMProvider, LLMResult
from app.providers.pricing import estimate_cost_usd

SERVICE_NAME = "invoice-ai"
_tracer = trace.get_tracer(SERVICE_NAME)

# Attributes that may carry a query string: user input never leaves in a span.
_URL_ATTRIBUTES = ("url.full", "http.url", "http.target")
_QUERY_ATTRIBUTE = "url.query"
_REDACTED = "REDACTED"
_ERROR_TYPE = "error.type"

# The SDK providers once started (Any: the SDK is imported lazily). A dict, not a `global`.
_state: dict[str, Any] = {"provider": None, "meter_provider": None}

# Bound to the real provider by `setup_metrics`; until then (tests, CI, plain dev) they do nothing.
_meter = metrics.get_meter(SERVICE_NAME)
_llm_tokens = _meter.create_counter(
    "llm.tokens", unit="{token}", description="Tokens of LLM calls (input and output)."
)
# No unit on purpose: an exporter would append it to the name. The name says what it is.
_llm_cost = _meter.create_counter(
    "llm.cost.list_price_usd",
    description="LLM cost at list price (pricing.py), in USD. Not money paid: the free tier is $0.",
)
_llm_calls = _meter.create_counter("llm.calls", unit="{call}", description="LLM calls by outcome.")

# Labels of every LLM metric. `operation` is one of these; anything else is `other`.
OPERATIONS = frozenset({"extract", "classify", "answer"})
NO_TENANT = "none"
# One data point per series per minute, as on the Node side (Grafana Cloud Free).
EXPORT_INTERVAL_MS = 60_000


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


def setup_metrics(reader: Any = None) -> bool:
    """Starts the metrics SDK once per process. `reader`: tests (an in-memory reader)."""
    if reader is None and not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return False
    if _state["meter_provider"] is not None:
        return True
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.metrics.view import DropAggregation, View
    from opentelemetry.sdk.resources import Resource

    if reader is None:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter

        reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(), export_interval_millis=EXPORT_INTERVAL_MS
        )
    # Flushes the last values at interpreter exit (shutdown_on_exit), like the tracer provider.
    provider = MeterProvider(
        metric_readers=[reader],
        resource=Resource.create({"service.name": SERVICE_NAME}),
        # The FastAPI and httpx instrumentations record HTTP histograms into the global provider.
        # RED metrics are the API's (T7.3); here they would only spend the free series quota.
        views=[View(instrument_name="http.*", aggregation=DropAggregation())],
    )
    metrics.set_meter_provider(provider)
    _state["meter_provider"] = provider
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
    if _ERROR_TYPE not in attributes and isinstance(kind, str):
        attributes[_ERROR_TYPE] = kind
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

    Each call is also counted (T7.3): tokens, list-price cost and the call, labelled with the
    tenant from the API's X-Tenant-Id header (a uuid or `none`; the routes that call a model all
    require the service token first), `operation` and the requested model. A failed call is counted
    with no tokens: the provider bills what it answered, and a failure answers nothing we can read.
    """

    def __init__(self, inner: LLMProvider, operation: str = "other") -> None:
        self._inner = inner
        self.operation = operation if operation in OPERATIONS else "other"
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
            labels = {
                "tenant_id": tenant_id_var.get() or NO_TENANT,
                "operation": self.operation,
                "model": self.model,
            }
            try:
                result = self._inner.generate(
                    system=system, user_text=user_text, images=images, json_schema=json_schema
                )
            except LLMError as e:
                span.set_status(Status(StatusCode.ERROR))
                span.set_attribute(_ERROR_TYPE, e.code)
                _llm_calls.add(1, {**labels, "outcome": "error"})
                raise
            except Exception as e:
                span.set_status(Status(StatusCode.ERROR))
                span.set_attribute(_ERROR_TYPE, type(e).__name__)
                _llm_calls.add(1, {**labels, "outcome": "error"})
                raise
            _record_usage(labels, result)
            span.set_attribute("gen_ai.response.model", result.model)
            span.set_attribute("gen_ai.usage.input_tokens", result.input_tokens)
            span.set_attribute("gen_ai.usage.output_tokens", result.output_tokens)
            span.set_attribute("llm.response.truncated", result.truncated)
            return result


def _record_usage(labels: dict[str, str], result: LLMResult) -> None:
    """Counts one answered call. Priced on the model that answered, as services/extract.py does."""
    _llm_calls.add(1, {**labels, "outcome": "ok"})
    _llm_tokens.add(result.input_tokens, {**labels, "token_type": "input"})
    _llm_tokens.add(result.output_tokens, {**labels, "token_type": "output"})
    cost = estimate_cost_usd(result.model, result.input_tokens, result.output_tokens)
    _llm_cost.add(cost, labels)
