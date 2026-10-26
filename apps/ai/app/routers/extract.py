from typing import Annotated, Any, Literal

from fastapi import APIRouter, Form, UploadFile
from fastapi.responses import JSONResponse

from app.services.xml_invoice import MAX_XML_BYTES, XmlInvoiceError, parse_xml_invoice

router = APIRouter()

SourceType = Literal["xml", "pdf", "image"]  # same vocabulary as documents.source_type


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"code": code, "message": message})


@router.post("/extract", response_model=None)
def extract(
    file: UploadFile,
    source_type: Annotated[SourceType, Form(alias="sourceType")],
    schema_version: Annotated[str | None, Form(alias="schemaVersion")] = None,
) -> dict[str, Any] | JSONResponse:
    if source_type != "xml":
        # The LLM path arrives in M3 (T3.1).
        return _error(501, "EXTRACTION_PATH_NOT_IMPLEMENTED", "Only xml is supported yet")
    # A sync handler runs in FastAPI's threadpool, so a slow parse cannot block the event loop.
    # Read one byte past the cap: Content-Length is the client's claim, not a limit.
    data = file.file.read(MAX_XML_BYTES + 1)
    try:
        invoice = parse_xml_invoice(data)
    except XmlInvoiceError as err:
        status = 413 if err.code == "FILE_TOO_LARGE" else 422
        return _error(status, err.code, err.message)
    return {"invoice": invoice, "warnings": [], "usage": None}
