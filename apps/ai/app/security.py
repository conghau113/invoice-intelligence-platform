import hmac
import re
from typing import Annotated

from fastapi import Depends, Header, Request
from fastapi.responses import JSONResponse

# W3C Trace Context: version-traceid-spanid-flags, all-zero ids are invalid. Bounded: fixed length.
TRACEPARENT = re.compile(r"^[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$")

SERVICE_UNAUTHORIZED = "SERVICE_UNAUTHORIZED"


class ServiceAuthError(Exception):
    """Raised for a missing or wrong service token; rendered as 401 {code, message}."""


def service_auth_error_handler(_request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={"code": SERVICE_UNAUTHORIZED, "message": "Missing or invalid service token"},
        headers={"WWW-Authenticate": "Bearer"},
    )


def require_service_token(
    request: Request, authorization: Annotated[str | None, Header()] = None
) -> None:
    """Deny by default: only the caller that knows the shared token may use internal routes."""
    expected = request.app.state.settings.ai_service_token
    scheme, _, supplied = (authorization or "").partition(" ")
    # compare_digest on bytes: constant time, and tolerant of non-ASCII input.
    if scheme.lower() != "bearer" or not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise ServiceAuthError


ServiceAuth = Depends(require_service_token)
