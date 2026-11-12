"""RAG routes (T5.2): `/index` turns an approved invoice into chunks with vectors, `/embed` turns
texts (a question, T5.3) into vectors. Internal only, behind the service token like `/extract`."""

from collections.abc import Callable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.error_codes import registered
from app.providers.base import LLMError
from app.providers.embedding import EmbeddingProvider, EmbedTask, build_embedder
from app.security import require_service_token
from app.services.chunking import ApprovedInvoiceRow
from app.services.embed import MAX_TEXTS, embed_texts, index_invoice

router = APIRouter(dependencies=[Depends(require_service_token)])

# A question or a chunk; anything longer is not a retrieval query (and is cut before embedding).
MAX_TEXT_CHARS = 8000


def get_embedder(request: Request) -> Callable[[], EmbeddingProvider]:
    """Dependency handing out a getter: the provider is built on first use and kept, like the LLM
    provider of /extract, and building it (missing key) fails inside the handler with a code."""

    def build() -> EmbeddingProvider:
        state = request.app.state
        if getattr(state, "embedder", None) is None:
            state.embedder = build_embedder(state.settings)
        return state.embedder

    return build


Embedder = Annotated[Callable[[], EmbeddingProvider], Depends(get_embedder)]


def _provider_error(err: LLMError) -> JSONResponse:
    return JSONResponse(
        status_code=err.status,
        content={"code": registered(err.code), "message": "The embedding provider failed"},
    )


class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    texts: list[Annotated[str, StringConstraints(min_length=1, max_length=MAX_TEXT_CHARS)]] = Field(
        min_length=1, max_length=MAX_TEXTS
    )
    task: EmbedTask


# Sync handlers run in FastAPI's threadpool, so a slow provider cannot block the event loop.
@router.post("/index", response_model=None)
def index_endpoint(embedder: Embedder, row: ApprovedInvoiceRow) -> dict[str, Any] | JSONResponse:
    try:
        return index_invoice(embedder(), row).model_dump(mode="json")
    except LLMError as err:
        return _provider_error(err)


@router.post("/embed", response_model=None)
def embed_endpoint(embedder: Embedder, body: EmbedRequest) -> dict[str, Any] | JSONResponse:
    try:
        provider = embedder()
        vectors = embed_texts(provider, body.texts, body.task)
    except LLMError as err:
        return _provider_error(err)
    return {"vectors": vectors, "usage": {"model": provider.model, "texts": len(body.texts)}}
