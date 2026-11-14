"""LLM-as-judge for groundedness and citation precision (`pnpm eval:rag:judge`).

For every answered lookup, the judge gets the question, the sources the answer model saw (same
numbers) and the answer split into sentences by `rag.text.sentences` (a rule, not a model), and
says per sentence whether it states a fact and which sources state all of it. From that:
- groundedness: share of fact sentences that at least one source supports;
- citation precision: share of `[n]` markers whose source supports the sentence they are on.

The judge output is model output: it is validated, never repaired. An invalid judgement is a
missing judgement and the report counts it. Pass 1 judges every repeat once; pass 2 judges repeat 1
again, to measure how much the judge disagrees with itself. Judgements are appended to a run file
and a key already judged is skipped, so a run stopped by the quota resumes where it stopped.
"""

import json
import time
from pathlib import Path
from typing import Any

from runner.provider import STOP_CODES, Pacer, StopRun

from app.providers.base import LLMError, LLMProvider
from rag.names import JUDGE_PROMPT, JUDGE_PROMPT_VERSION
from rag.text import sentences

JUDGE_SCHEMA: dict[str, Any] = {
    "title": "RagJudgement",
    "type": "object",
    "properties": {
        "sentences": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "i": {"type": "integer"},
                    "claim": {"type": "boolean"},
                    "supportedBy": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["i", "claim", "supportedBy"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["sentences"],
    "additionalProperties": False,
}

# A temporary provider error (5xx) is retried once after this pause; a second one is recorded.
RETRY_PAUSE_S = 30.0


def judge_items(
    asks: list[dict[str, Any]], repeats: set[int] | None = None
) -> list[dict[str, Any]]:
    """What the judge reads for each answered lookup: question, numbered sources, sentences."""
    items = []
    for rec in asks:
        if rec["outcome"] != "answer" or (repeats is not None and rec["repeat"] not in repeats):
            continue
        split = sentences(rec["answer"])
        items.append(
            {
                "key": f"r{rec['repeat']}/{rec['id']}",
                "payload": {
                    "question": rec["question"],
                    "sources": [
                        {"n": i + 1, "content": c["content"]}
                        for i, c in enumerate(rec["retrieved"])
                    ],
                    "sentences": [
                        {"i": i, "text": s["text"], "cites": s["cites"]}
                        for i, s in enumerate(split)
                    ],
                },
            }
        )
    return items


def parse_judgement(
    text: str, sentence_count: int, source_count: int
) -> list[dict[str, Any]] | None:
    """The judge's sentences, or None when the output does not follow the schema and the rules
    (one item per sentence, in order; source numbers that exist; none for a non-claim)."""
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        return None
    items = data.get("sentences") if isinstance(data, dict) else None
    if not isinstance(items, list) or len(items) != sentence_count:
        return None
    out = []
    for expected_i, item in enumerate(items):
        if not isinstance(item, dict) or item.get("i") != expected_i:
            return None
        claim, by = item.get("claim"), item.get("supportedBy")
        if not isinstance(claim, bool) or not isinstance(by, list):
            return None
        if any(
            not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= source_count for n in by
        ):
            return None
        if not claim and by:
            return None
        out.append({"i": expected_i, "claim": claim, "supportedBy": sorted(set(by))})
    return out


def judged_keys(records: list[dict[str, Any]]) -> set[tuple[int, str]]:
    return {(r["pass"], r["key"]) for r in records if r.get("sentences") is not None}


def run_judge(
    provider: LLMProvider,
    items: list[dict[str, Any]],
    *,
    judge_pass: int,
    done: set[tuple[int, str]],
    out: Path,
    pacer: Pacer,
    max_calls: int,
    sleep: Any = time.sleep,
) -> int:
    """Judges the items not yet judged in this pass, appending one record per item.
    Returns the number of calls made."""
    system = JUDGE_PROMPT.read_text(encoding="utf-8")
    calls = 0
    out.parent.mkdir(parents=True, exist_ok=True)
    for item in items:
        if (judge_pass, item["key"]) in done:
            continue
        payload = item["payload"]
        record: dict[str, Any] = {
            "pass": judge_pass,
            "key": item["key"],
            "promptVersion": JUDGE_PROMPT_VERSION,
            "judgeModel": provider.model,
            "sentences": None,
            "error": None,
        }
        for attempt in (1, 2):
            if calls >= max_calls:
                raise StopRun(f"call cap reached ({max_calls})")
            pacer.wait()
            pacer.started()
            calls += 1
            started = time.monotonic()
            try:
                result = provider.generate(
                    system=system,
                    user_text=json.dumps(payload, ensure_ascii=False),
                    images=[],
                    json_schema=JUDGE_SCHEMA,
                )
            except LLMError as err:
                if err.code in STOP_CODES:
                    raise StopRun(f"provider answered {err.code}") from None
                record["error"] = err.code
                if attempt == 1 and err.status >= 500:
                    sleep(RETRY_PAUSE_S)
                    continue
                break
            record.update(
                error=None,
                ms=int((time.monotonic() - started) * 1000),
                inputTokens=result.input_tokens,
                outputTokens=result.output_tokens,
                sentences=parse_judgement(
                    result.text, len(payload["sentences"]), len(payload["sources"])
                ),
            )
            if record["sentences"] is None:
                record["error"] = "JUDGE_OUTPUT_INVALID"
                # Kept for diagnosis only, in the git-ignored run file (synthetic text).
                record["raw"] = result.text[:2000]
            break
        with out.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(f"pass {judge_pass} {item['key']}: {record['error'] or 'ok'}", flush=True)
    return calls


def verdict(item: dict[str, Any]) -> str:
    """One label per sentence, the same scale the hand labels use."""
    if not item["claim"]:
        return "no_claim"
    return "supported" if item["supportedBy"] else "unsupported"
