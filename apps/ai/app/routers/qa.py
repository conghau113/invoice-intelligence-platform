"""Q&A routes (T5.4): `/classify` routes a question, `/answer` writes a cited answer from sources.
Internal only, behind the service token like `/extract`. Both answer 200 with `output` null when the
model's text did not match the schema: that is the model's answer, not a failure of this service,
and the API turns it into a refusal. A provider failure keeps its code and status (503/422)."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.error_codes import registered
from app.providers.base import LLMError
from app.routers.extract import get_llm_provider
from app.security import require_service_token
from app.services.answer import Source, StepResult, answer_question, classify_question

router = APIRouter(dependencies=[Depends(require_service_token)])

MAX_QUESTION_CHARS = 1000  # QA_MAX_QUESTION_CHARS in packages/contracts/src/qa.ts
MAX_SOURCES = 20  # MAX_TOP_K of the API's retrieval
# A chunk is at most 2,000 characters of lines (T5.1), but a header has no fixed limit (long names
# and addresses); 20,000 is far above any chunk of the dataset and still bounds the prompt.
MAX_SOURCE_CHARS = 20_000

Question = Annotated[str, StringConstraints(min_length=1, max_length=MAX_QUESTION_CHARS)]
IsoDate = Annotated[str, StringConstraints(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")]


class ClassifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: Question
    today: IsoDate


class SourceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    n: int = Field(ge=1, le=MAX_SOURCES)
    content: Annotated[str, StringConstraints(min_length=1, max_length=MAX_SOURCE_CHARS)]


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: Question
    sources: list[SourceIn] = Field(min_length=1, max_length=MAX_SOURCES)

    @model_validator(mode="after")
    def _numbered_in_order(self) -> "AnswerRequest":
        # The API maps `[n]` back to the n-th chunk it retrieved: numbers must be exactly 1..len.
        if [s.n for s in self.sources] != list(range(1, len(self.sources) + 1)):
            raise ValueError("sources must be numbered 1..len in order")
        return self


def _provider_error(err: LLMError) -> JSONResponse:
    return JSONResponse(
        status_code=err.status,
        content={"code": registered(err.code), "message": "The model provider failed"},
    )


def _body(step: StepResult) -> dict[str, Any]:
    output = step.output.model_dump(mode="json") if step.output is not None else None
    return {"output": output, "usage": step.usage}


# Sync handlers run in FastAPI's threadpool, so a slow provider cannot block the event loop.
@router.post("/classify", response_model=None)
def classify_endpoint(request: Request, body: ClassifyRequest) -> dict[str, Any] | JSONResponse:
    try:
        return _body(classify_question(get_llm_provider(request), body.question, body.today))
    except LLMError as err:  # includes a provider that cannot be built (missing key)
        return _provider_error(err)


@router.post("/answer", response_model=None)
def answer_endpoint(request: Request, body: AnswerRequest) -> dict[str, Any] | JSONResponse:
    sources = [Source(n=s.n, content=s.content) for s in body.sources]
    try:
        return _body(answer_question(get_llm_provider(request), body.question, sources))
    except LLMError as err:
        return _provider_error(err)
