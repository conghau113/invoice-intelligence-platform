"""Runs the pipeline on one split and appends one JSON line per (document, repeat).

The line holds the model's invoice so the report can be scored again after a matcher fix without
calling the model again, and so T4.4 can classify errors. It lives in git-ignored `eval/runs/`.
Nothing about a document's content is printed: ids, statuses and codes only (CLAUDE.md).
"""

import hashlib
import json
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.providers.base import LLMProvider
from app.services.extract import (
    MAX_FIELD_META,
    PROMPT_VERSION,
    SYSTEM_PROMPT,
    ExtractError,
    extract,
)
from runner.dataset import Dataset, source_type
from runner.provider import Pacer, RecordingProvider, StopRun

MAX_ATTEMPTS = 3  # per document, for temporary failures (503, timeout): free tier, T3.1
RETRY_WAIT_S = 20.0
MAX_FAILED_IN_A_ROW = 5
FINAL = ("ok", "rejected")  # an `error` is tried again on the next run
# 4xx answers from the provider itself, not about the file: a 400 can be passing, and recording it
# as a final wrong document would put it into the baseline unnoticed. Tried again like a 503.
PROVIDER_REFUSALS = frozenset({"LLM_REQUEST_REJECTED", "LLM_NO_CANDIDATE"})
PROMPT_SHA256 = hashlib.sha256(SYSTEM_PROMPT.encode("utf-8")).hexdigest()

Extract = Callable[..., dict[str, Any]]


def read_records(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line]
    records = []
    for number, line in enumerate(lines, start=1):
        try:
            records.append(json.loads(line))
        except ValueError:
            if number < len(lines):
                raise
            # The process was killed while writing its last line: that document runs again.
    return records


def _config(dataset: Dataset, model: str) -> dict[str, str]:
    return {
        "dataset": dataset.name,
        "manifestSha256": dataset.manifest_sha256,
        "model": model,
        "promptVersion": PROMPT_VERSION,
        "promptSha256": PROMPT_SHA256,
    }


def check_same_config(records: list[dict[str, Any]], config: dict[str, str]) -> None:
    """One file is one configuration: a prompt edited without a new version must not be mixed in."""
    for record in records:
        for key, value in config.items():
            if record.get(key) != value:
                raise SystemExit(f"{key} differs from the runs already in the file: new version?")


def _one_document(
    data: bytes,
    kind: str,
    provider: RecordingProvider,
    pacer: Pacer,
    extract_fn: Extract,
    retry_wait_s: float,
) -> dict[str, Any]:
    outcome: dict[str, Any] = {"status": "error", "code": "UNKNOWN"}
    totals = {"calls": 0, "inputTokens": 0, "outputTokens": 0}
    max_meta: int | None = None
    for number in range(1, MAX_ATTEMPTS + 1):
        pacer.wait()  # outside extract: pacing must not eat into its 55 s budget
        provider.reset()
        started = time.monotonic()
        try:
            out = extract_fn(data, kind, lambda: provider)
            outcome = {"status": "ok", "got": out["invoice"].model_dump(mode="json")}
        except ExtractError as err:
            final = err.status < 500 and err.code not in PROVIDER_REFUSALS
            outcome = {"status": "rejected" if final else "error", "code": err.code}
        wall_ms = int((time.monotonic() - started - provider.slept_s) * 1000)
        totals["calls"] += provider.calls
        totals["inputTokens"] += provider.input_tokens  # rejected attempts are billed too
        totals["outputTokens"] += provider.output_tokens
        if provider.max_field_meta is not None:
            max_meta = max(provider.max_field_meta, max_meta or 0)
        outcome |= {
            "attempts": number,
            "latencyMs": wall_ms,
            "providerMs": provider.provider_ms,
            "pacingMs": int(provider.slept_s * 1000),  # taken out of latencyMs
        }
        if outcome["status"] != "error":
            break
        if number < MAX_ATTEMPTS:
            time.sleep(retry_wait_s)
    if outcome["status"] == "rejected" and max_meta is not None and max_meta > MAX_FIELD_META:
        outcome["reason"] = "FIELD_META_TOO_MANY"  # T4.1: a limit of ours, not a reading error
    return outcome | totals | {"maxFieldMeta": max_meta}


def run_split(
    dataset: Dataset,
    split: str,
    repeats: int,
    provider: LLMProvider,
    results: Path,
    *,
    rpm: int,
    max_calls: int,
    extract_fn: Extract = extract,
    retry_wait_s: float = RETRY_WAIT_S,
    say: Callable[[str], None] = print,
    pacer: Pacer | None = None,
) -> bool:
    """True when every (document, repeat) of the split has a final result."""
    records = read_records(results)
    config = _config(dataset, provider.model)
    check_same_config(records, config)
    finished = {(r["split"], r["doc"], r["repeat"]) for r in records if r["status"] in FINAL}
    pacer = pacer or Pacer(rpm)
    recorder = RecordingProvider(provider, pacer, max_calls)
    results.parent.mkdir(parents=True, exist_ok=True)
    failed_in_a_row = 0
    complete = True
    for repeat in range(repeats):
        for doc_id in dataset.splits[split]:
            if (split, doc_id, repeat) in finished:
                continue
            doc = dataset.documents[doc_id]
            try:
                outcome = _one_document(
                    dataset.primary(doc_id),
                    source_type(doc["primary"]),
                    recorder,
                    pacer,
                    extract_fn,
                    retry_wait_s,
                )
            except StopRun as stop:
                say(f"STOPPED: {stop}. calls={recorder.total_calls}. Run the same command later.")
                return False
            record = {
                "split": split,
                "doc": doc_id,
                "repeat": repeat,
                **config,
                "at": datetime.now(UTC).isoformat(timespec="seconds"),
                **outcome,
            }
            with results.open("a", encoding="utf-8") as out:
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
            say(f"{split} {doc_id} repeat={repeat} {outcome['status']} {outcome.get('code', '')}")
            complete = complete and outcome["status"] in FINAL
            failed_in_a_row = 0 if outcome["status"] == "ok" else failed_in_a_row + 1
            if failed_in_a_row >= MAX_FAILED_IN_A_ROW:
                say(f"STOPPED: {failed_in_a_row} documents failed in a row.")
                return False
    say(f"{split} done. calls={recorder.total_calls} complete={complete}")
    return complete
