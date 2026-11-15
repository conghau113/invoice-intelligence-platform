"""LLM provider contract (Strategy pattern, ADR 0009).

`extract` depends only on `LLMProvider`; Gemini, the fallback and the fake are interchangeable
adapters chosen by configuration. Errors carry a stable `code` and the HTTP status /extract answers
with. The API worker retries 5xx/408/429 and fails 4xx at once, so the status IS the taxonomy.

No exception message ever contains a provider response body or document text (CLAUDE.md).
"""

import math
import re
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from app.error_codes import registered

# Largest answer a provider may write, thinking tokens included (Gemini counts them; T4.5b).
# Set from time, not from the model (gemini-3.5-flash-lite allows 65,536): it must arrive inside
# `llm_timeout_s` (45 s) at the worst single speed observed on `core`/`smoke` (3.2 ms per output
# token; the fit over 195 calls is 1.8) plus the fitted 2.2 s start: 2.2 + 12,288 x 3.2 ms =
# 41.5 s, a margin of only 3.5 s; a slower day can still time out the longest answers. A larger
# cap would turn more long answers into timeouts, which the worker retries (and pays for) as
# temporary; a cut answer is final. One line with its `fieldMeta` entry is ~133 tokens, so about
# 86 lines fit (8,192 fitted ~54: invoice-0004 was cut, T4.4).
MAX_OUTPUT_TOKENS = 12288

# Longest wait we pass on from a provider's 429 (T6.2). A longer one (a daily quota that resets in
# hours) is cut here; the API worker then waits again and, after enough waits, fails the job. The
# worker caps at the same 300 s (`MAX_RATE_LIMIT_WAIT_MS`, apps/api extraction/resilience.ts).
MAX_RETRY_AFTER_S = 300
# Google's RetryInfo writes a duration like "37s" or "1.5s". Bounded, so no backtracking.
_GOOGLE_DURATION = re.compile(r"(\d{1,6}(?:\.\d{1,9})?)s", re.ASCII)
# Whole seconds, ASCII digits only ("²".isdigit() is True but int() refuses it).
_SECONDS = re.compile(r"\d{1,6}", re.ASCII)


@dataclass(frozen=True)
class ImagePart:
    """One page/photo. Document content only ever travels as data parts like this one."""

    data: bytes
    mime: str  # image/png | image/jpeg


@dataclass(frozen=True)
class LLMResult:
    text: str
    model: str
    input_tokens: int
    output_tokens: int  # includes hidden "thinking" tokens: they are billed as output
    # The answer stopped at MAX_OUTPUT_TOKENS. Asking again would be cut again: extract stops.
    truncated: bool = False


class LLMError(Exception):
    """A provider call failed. `status` >= 500: try again later; 4xx: retrying will not help.

    `retry_after_s`: how long the provider asked us to wait (429 only), passed on to the API worker
    as a `Retry-After` header so the whole queue waits instead of hammering a provider that said no.
    """

    def __init__(self, code: str, status: int, retry_after_s: int | None = None) -> None:
        super().__init__(code)
        self.code = registered(code)
        self.status = status
        self.retry_after_s = retry_after_s


class LLMUnavailable(LLMError):
    """Provider down, rate-limited, timed out or our key/URL wrong: not the file's fault."""

    def __init__(self, code: str = "LLM_UNAVAILABLE", retry_after_s: int | None = None) -> None:
        super().__init__(code, 503, retry_after_s)


class LLMRejected(LLMError):
    """The provider refused this request (blocked content, unusable schema): retrying is futile."""

    def __init__(self, code: str = "LLM_REQUEST_REJECTED") -> None:
        super().__init__(code, 422)


class LLMProvider(Protocol):
    name: str
    model: str
    timeout_s: float  # per-call limit; extract uses it to keep within its total budget

    def generate(
        self,
        *,
        system: str,
        user_text: str,
        images: list[ImagePart],
        json_schema: dict[str, Any],
    ) -> LLMResult: ...


def _error_reasons(res: httpx.Response) -> set[str]:
    try:
        details = res.json()["error"]["details"]
        return {
            d["reason"] for d in details if isinstance(d, dict) and isinstance(d.get("reason"), str)
        }
    except (ValueError, KeyError, TypeError):
        return set()


def _bounded_seconds(value: float) -> int:
    return min(MAX_RETRY_AFTER_S, max(1, math.ceil(value)))


def retry_after_s(res: httpx.Response) -> int | None:
    """The wait a 429 asks for: a `Retry-After` header in seconds (OpenAI-compatible providers), or
    Google's `RetryInfo.retryDelay` in the error details. Only these machine fields are read, never
    the message. None when the provider says nothing usable (an HTTP date is ignored too)."""
    header = res.headers.get("retry-after", "").strip()
    if _SECONDS.fullmatch(header):
        return _bounded_seconds(int(header))
    try:
        details = res.json()["error"]["details"]
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(details, list):
        return None
    for d in details:
        if not isinstance(d, dict) or not str(d.get("@type", "")).endswith("google.rpc.RetryInfo"):
            continue
        delay = d.get("retryDelay")
        match = _GOOGLE_DURATION.fullmatch(delay) if isinstance(delay, str) else None
        if match:
            return _bounded_seconds(float(match.group(1)))
    return None


def post_json(
    client: httpx.Client, url: str, headers: dict[str, str], body: dict[str, Any]
) -> dict[str, Any]:
    """POST and map every failure to the taxonomy above, without echoing anything received."""
    try:
        res = client.post(url, headers=headers, json=body)
    except httpx.HTTPError:  # timeout, refused, reset, DNS: the network's fault, not the file's
        raise LLMUnavailable("LLM_TIMEOUT_OR_NETWORK") from None
    if res.status_code == 429:
        raise LLMUnavailable("LLM_RATE_LIMITED", retry_after_s(res))
    if res.status_code in (401, 403, 404):
        raise LLMUnavailable(
            "LLM_MISCONFIGURED"
        )  # bad key or model name: ours to fix, not the file's
    if res.status_code >= 500 or res.status_code == 408:
        raise LLMUnavailable()
    if res.status_code >= 400:
        # Gemini answers an invalid API key with 400, not 401: read only the machine reason
        # (never the message, which may echo input) to tell "our key is wrong" from "bad request".
        if _error_reasons(res) & {"API_KEY_INVALID", "API_KEY_NOT_FOUND"}:
            raise LLMUnavailable("LLM_MISCONFIGURED")
        raise LLMRejected()
    try:
        data = res.json()
    except ValueError:
        raise LLMUnavailable("LLM_BAD_RESPONSE") from None
    if not isinstance(data, dict):
        raise LLMUnavailable("LLM_BAD_RESPONSE")
    return data
