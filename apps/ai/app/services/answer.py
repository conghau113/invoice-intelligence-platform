"""Q&A model steps (T5.4, AI_PIPELINE.md section 7). Stateless, like the rest of this service: the
API retrieves, runs SQL, checks citations and talks to the user; this module only asks the model.

- `classify_question`: question -> intent (lookup / aggregate / out_of_scope) and, for an aggregate,
  a structured filter. The model sees the question only, never document content, so a stored
  invoice cannot steer the filter that the API turns into a query.
- `answer_question`: question + numbered sources (retrieved chunks) -> answer citing `[n]`.

Model output is untrusted text. It is parsed and validated against the models generated from
`packages/contracts/src/qa.ts`; anything else is reported as "no output" (`None`), never repaired
and never retried (a retry costs a second call while a person waits). The question and the sources
go in the user message as one JSON document, so a newline or a quote inside a chunk cannot end the
data block and pose as an instruction; the instructions are only in the system prompt. Logs carry
counts, codes and timings, never the question, a source or an answer (CLAUDE.md).
"""

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from app.providers.base import LLMError, LLMProvider, LLMResult
from app.providers.pricing import estimate_cost_usd
from app.schemas.qa_generated import QaAnswer, QaRoute

log = logging.getLogger("ai.answer")

_PROMPTS = Path(__file__).parent.parent / "prompts"
ROUTE_PROMPT_VERSION = "qa_route/v1"
ANSWER_PROMPT_VERSION = "qa_answer/v1"
ROUTE_SYSTEM_PROMPT = (_PROMPTS / "qa_route" / "v1.md").read_text(encoding="utf-8")
ANSWER_SYSTEM_PROMPT = (_PROMPTS / "qa_answer" / "v1.md").read_text(encoding="utf-8")


@dataclass(frozen=True)
class Source:
    """One retrieved chunk as the model sees it: a number and the text, no id to copy or invent."""

    n: int
    content: str


@dataclass(frozen=True)
class StepResult:
    """`output` is None when the model's text was not valid JSON for the schema, or was cut off."""

    output: BaseModel | None
    usage: dict[str, Any]


def _usage(result: LLMResult, prompt_version: str, started: float) -> dict[str, Any]:
    return {
        "model": result.model,
        "promptVersion": prompt_version,
        "inputTokens": result.input_tokens,
        "outputTokens": result.output_tokens,
        "latencyMs": int((time.monotonic() - started) * 1000),
        "costUsd": estimate_cost_usd(result.model, result.input_tokens, result.output_tokens),
    }


def _run(
    provider: LLMProvider,
    *,
    system: str,
    payload: dict[str, Any],
    model: type[BaseModel],
    prompt_version: str,
) -> StepResult:
    """One provider call. LLMError goes up as it is (the router answers with its code), after its
    code is logged: the API never reads an error body, so this line is the only place it shows."""
    started = time.monotonic()
    try:
        result = provider.generate(
            system=system,
            user_text=json.dumps(payload, ensure_ascii=False),
            images=[],
            json_schema=model.model_json_schema(),
        )
    except LLMError as err:
        ms = int((time.monotonic() - started) * 1000)
        log.warning("qa model call failed step=%s code=%s ms=%d", prompt_version, err.code, ms)
        raise
    usage = _usage(result, prompt_version, started)
    output: BaseModel | None = None
    problem = "output cut at the token cap" if result.truncated else ""
    if not result.truncated:
        try:
            output = model.model_validate_json(result.text)
        # ValueError covers bad JSON; RecursionError absurdly nested JSON. The error's text can
        # quote the model's output, so only its type is kept.
        except (ValidationError, ValueError, RecursionError) as err:
            problem = type(err).__name__
    if output is None:
        log.warning("qa model output rejected step=%s: %s", prompt_version, problem)
    else:
        log.info(
            "qa model ok step=%s model=%s in=%d out=%d ms=%d",
            prompt_version,
            usage["model"],
            usage["inputTokens"],
            usage["outputTokens"],
            usage["latencyMs"],
        )
    return StepResult(output=output, usage=usage)


def classify_question(provider: LLMProvider, question: str, today: str) -> StepResult:
    """`today` (YYYY-MM-DD) comes from the API, so "tháng 9" means the same month on both sides."""
    return _run(
        provider,
        system=ROUTE_SYSTEM_PROMPT,
        payload={"today": today, "question": question},
        model=QaRoute,
        prompt_version=ROUTE_PROMPT_VERSION,
    )


def answer_question(provider: LLMProvider, question: str, sources: list[Source]) -> StepResult:
    return _run(
        provider,
        system=ANSWER_SYSTEM_PROMPT,
        payload={
            "question": question,
            "sources": [{"n": s.n, "content": s.content} for s in sources],
        },
        model=QaAnswer,
        prompt_version=ANSWER_PROMPT_VERSION,
    )
