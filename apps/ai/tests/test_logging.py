"""T7.2: JSON log lines with trace and tenant ids, PII redacted (app/logging.py).

The redaction cases are shared with packages/logger (Jest), so Node and Python redact alike.
"""

import io
import json
import logging
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider

from app.logging import (
    REDACTED,
    configure_logging,
    is_sensitive_key,
    redact_string,
    redact_value,
    tenant_from_header,
)
from app.main import create_app

CASES: dict[str, Any] = json.loads(
    (
        Path(__file__).resolve().parents[3] / "packages/logger/fixtures/redaction-cases.json"
    ).read_text(encoding="utf-8")
)
TENANT = "00000000-0000-4000-8000-0000000000a1"


@pytest.mark.parametrize("case", CASES["redact"], ids=lambda c: c["why"])
def test_redacts_shared_case(case: dict[str, str]) -> None:
    assert redact_string(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", CASES["keep"], ids=lambda c: c["why"])
def test_keeps_shared_case(case: dict[str, str]) -> None:
    assert redact_string(case["input"]) == case["input"]


def test_long_hostile_line_is_fast() -> None:
    line = "Nguyễn " * 5_000 + "a@" * 5_000 + "0" * 20_000
    started = time.perf_counter()
    redact_string(line)
    assert time.perf_counter() - started < 1.0


def test_redact_value_drops_fields_named_after_personal_data() -> None:
    out = redact_value(
        {
            "documentId": "d-1",
            "seller": {"name": "x", "taxCode": "6904000855"},
            "buyer_email": "x",
            "items": [{"contactPhone": "1"}],
            "ms": 12,
        }
    )
    assert out == {
        "documentId": "d-1",
        "seller": REDACTED,
        "buyer_email": REDACTED,
        "items": [{"contactPhone": REDACTED}],
        "ms": 12,
    }
    assert not any(map(is_sensitive_key, ["documentId", "code", "ms", "logger", "service"]))


def test_tenant_header_must_be_a_uuid() -> None:
    assert tenant_from_header(TENANT) == TENANT
    assert tenant_from_header(TENANT.upper()) == TENANT
    for bad in (None, "", "acme", "x" * 36, f"{TENANT} "):
        assert tenant_from_header(bad) is None


class Capture:
    """The JSON handler, writing to a buffer instead of stdout."""

    def __init__(self) -> None:
        self.buffer = io.StringIO()
        self.install()

    def install(self) -> None:
        self.handler = configure_logging("info", stream=self.buffer)

    def lines(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.buffer.getvalue().splitlines() if line]


@pytest.fixture
def capture() -> Iterator[Capture]:
    cap = Capture()
    yield cap
    logging.getLogger().removeHandler(cap.handler)


def test_line_is_json_with_service_level_logger_and_redacted_message(
    capture: Capture,
) -> None:
    logging.getLogger("ai.extract").warning(
        "llm output rejected for %s, MST %s", "Nguyễn Văn Jane SAMPLE", "6904000855"
    )
    [line] = capture.lines()
    assert line["service"] == "invoice-ai"
    assert line["level"] == "warning"
    assert line["logger"] == "ai.extract"
    assert line["msg"] == "llm output rejected for [NAME], MST [TAX_CODE]"
    assert "T" in line["time"]  # ISO 8601
    assert "trace_id" not in line
    assert "tenant_id" not in line


def test_line_inside_a_span_carries_its_trace_and_span_id(capture: Capture) -> None:
    tracer = TracerProvider().get_tracer("test")
    with tracer.start_as_current_span("work") as span:
        logging.getLogger("ai.answer").info("qa answer ok")
    ctx = span.get_span_context()
    [line] = capture.lines()
    assert line["trace_id"] == format(ctx.trace_id, "032x")
    assert line["span_id"] == format(ctx.span_id, "016x")


def test_traceback_is_redacted(capture: Capture) -> None:
    try:
        raise ValueError("bad buyer jane@example.com")
    except ValueError:
        logging.getLogger("ai.extract").exception("failed")
    [line] = capture.lines()
    assert "jane@example.com" not in json.dumps(line)
    assert "[EMAIL]" in line["exception"]


def test_uvicorn_access_line_goes_through_the_same_chain(capture: Capture) -> None:
    logging.getLogger("uvicorn.access").info(
        '%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "GET", "/x?mail=a@b.co", "1.1", 200
    )
    [line] = capture.lines()
    assert line["logger"] == "uvicorn.access"
    assert line["msg"] == '127.0.0.1:5000 - "GET /x?mail=[EMAIL] HTTP/1.1" 200'


def test_request_log_lines_carry_the_tenant_from_x_tenant_id(
    capture: Capture,
) -> None:
    app = create_app()
    log = logging.getLogger("ai.test")

    @app.get("/_log")
    def write_log() -> dict[str, str]:
        log.info("inside request")
        return {}

    capture.install()  # create_app put its stdout handler in place of the test's
    client = TestClient(app)
    client.get("/_log", headers={"X-Tenant-Id": TENANT})
    client.get("/_log", headers={"X-Tenant-Id": "acme"})
    client.get("/_log")
    log.info("outside request")
    tenants = [line.get("tenant_id") for line in capture.lines() if line["logger"] == "ai.test"]
    assert tenants == [TENANT, None, None, None]


def test_ids_passed_to_a_structlog_call_are_kept_only_with_the_shape_of_an_id(
    capture: Capture,
) -> None:
    import structlog

    log = structlog.get_logger("ai.native")
    log.info("spoof", tenant_id="Nguyễn Văn Jane SAMPLE", trace_id="jane@example.com")
    log.info("ok", tenant_id=TENANT)
    spoof, ok = capture.lines()
    assert spoof["tenant_id"] == "[NAME]"
    assert spoof["trace_id"] == "[EMAIL]"
    assert ok["tenant_id"] == TENANT


def test_binary_values_are_not_written() -> None:
    assert redact_value({"file": b"Nguyen Van A", "view": memoryview(b"x")}) == {
        "file": "[Binary]",
        "view": "[Binary]",
    }
