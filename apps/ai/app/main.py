from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response

from app.config import get_settings
from app.routers import extract, health
from app.security import TRACEPARENT, ServiceAuthError, service_auth_error_handler


def create_app() -> FastAPI:
    settings = get_settings()  # raises on invalid config, so the process fails at startup
    app = FastAPI(title="Invoice Intelligence AI", version="0.1.0")
    app.state.settings = settings
    app.add_exception_handler(ServiceAuthError, service_auth_error_handler)

    @app.middleware("http")
    async def echo_traceparent(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        # A request header is user input: echo it only when it is a well-formed traceparent.
        incoming = request.headers.get("traceparent")
        if incoming is not None and TRACEPARENT.match(incoming):
            response.headers["traceparent"] = incoming
        return response

    app.include_router(health.router)
    app.include_router(extract.router)
    return app


app = create_app()
