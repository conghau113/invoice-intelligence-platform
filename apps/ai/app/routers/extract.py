from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Form, Request, UploadFile
from fastapi.responses import JSONResponse

from app.error_codes import registered
from app.providers import build_provider
from app.providers.base import LLMError, LLMProvider
from app.security import require_service_token
from app.services.extract import ExtractError, extract
from app.services.xml_invoice import MAX_XML_BYTES

router = APIRouter(dependencies=[Depends(require_service_token)])

SourceType = Literal["xml", "pdf", "image"]  # same vocabulary as documents.source_type
MAX_FILE_BYTES = MAX_XML_BYTES  # 10 MiB, same cap as the API upload


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"code": registered(code), "message": message})


def get_llm_provider(request: Request) -> LLMProvider:
    """Built on first use and kept: building needs a key the XML path does not."""
    state = request.app.state
    if getattr(state, "llm_provider", None) is None:
        state.llm_provider = build_provider(state.settings)
    return state.llm_provider


@router.post("/extract", response_model=None)
def extract_endpoint(
    request: Request,
    file: UploadFile,
    source_type: Annotated[SourceType, Form(alias="sourceType")],
    schema_version: Annotated[str | None, Form(alias="schemaVersion")] = None,
) -> dict[str, Any] | JSONResponse:
    # A sync handler runs in FastAPI's threadpool, so slow parsing or a slow provider cannot block
    # the event loop. Read one byte past the cap: Content-Length is the client's claim, not a limit.
    data = file.file.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        return _error(413, "FILE_TOO_LARGE", "File is larger than the 10 MiB limit")
    try:
        return extract(data, source_type, lambda: get_llm_provider(request))
    except LLMError as err:  # provider could not even be built (missing key)
        return _error(err.status, err.code, "The model provider is not available")
    except ExtractError as err:
        return _error(err.status, err.code, err.message)
