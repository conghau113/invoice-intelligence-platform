"""Wraps the real provider: paces the calls and records what `extract` does not return.

`extract` drops the tokens of attempts that failed schema validation when every attempt fails, and
does not say why a model answer was rejected. Both matter for an honest report (cost; a too-long
`fieldMeta` list is not a reading error, T4.1), so they are counted here, around each call.
"""

import json
import time
from collections.abc import Callable
from typing import Any

from app.providers.base import LLMError, LLMProvider, LLMResult

# Stop the run, keep what was measured: retrying cannot help and every document would look wrong.
STOP_CODES = frozenset({"LLM_RATE_LIMITED", "LLM_MISCONFIGURED", "LLM_NOT_CONFIGURED"})


class StopRun(Exception):
    """Quota reached, call cap reached or the provider is misconfigured. Run again later."""


class Pacer:
    """At most `rpm` call starts a minute. Time spent waiting is counted in `slept_s`."""

    def __init__(
        self,
        rpm: int,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.interval = 60.0 / rpm
        self._clock = clock
        self._sleep = sleep
        self._last: float | None = None
        self.slept_s = 0.0

    def wait(self) -> None:
        if self._last is not None:
            gap = self.interval - (self._clock() - self._last)
            if gap > 0:
                self._sleep(gap)
                self.slept_s += gap

    def started(self) -> None:
        self._last = self._clock()


def _field_meta_count(text: str) -> int | None:
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        return None
    entries = data.get("fieldMeta") if isinstance(data, dict) else None
    return len(entries) if isinstance(entries, list) else None


class RecordingProvider:
    """Same interface as LLMProvider. `reset()` before each document, read the counters after."""

    def __init__(self, inner: LLMProvider, pacer: Pacer, max_calls: int) -> None:
        self._inner = inner
        self._pacer = pacer
        self.name = inner.name
        self.model = inner.model
        self.timeout_s = inner.timeout_s
        self.max_calls = max_calls
        self.total_calls = 0
        self.reset()

    def reset(self) -> None:
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.provider_ms = 0
        self.max_field_meta: int | None = None
        self.truncated = False  # an answer stopped at MAX_OUTPUT_TOKENS (T4.5b)
        self.slept_at_reset = self._pacer.slept_s

    @property
    def slept_s(self) -> float:
        """Pacing inside this document, to be taken out of its latency."""
        return self._pacer.slept_s - self.slept_at_reset

    def generate(self, **kwargs: Any) -> LLMResult:
        if self.total_calls >= self.max_calls:
            raise StopRun(f"call cap reached ({self.max_calls})")
        self._pacer.wait()
        self._pacer.started()
        self.total_calls += 1
        self.calls += 1
        started = time.monotonic()
        try:
            result = self._inner.generate(**kwargs)
        except LLMError as err:
            if err.code in STOP_CODES:
                raise StopRun(f"provider answered {err.code}") from None
            raise
        finally:
            self.provider_ms += int((time.monotonic() - started) * 1000)
        self.input_tokens += result.input_tokens
        self.output_tokens += result.output_tokens
        self.truncated = self.truncated or result.truncated
        count = _field_meta_count(result.text)
        if count is not None:
            self.max_field_meta = max(count, self.max_field_meta or 0)
        return result
