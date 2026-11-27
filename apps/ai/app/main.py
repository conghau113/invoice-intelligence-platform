from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response

from app.config import get_settings
from app.logging import TENANT_HEADER, configure_logging, tenant_from_header, tenant_id_var
from app.otel import setup_tracing
from app.routers import extract, health, qa, rag
from app.security import TRACEPARENT, ServiceAuthError, service_auth_error_handler


def create_app() -> FastAPI:
    settings = get_settings()  # raises on invalid config, so the process fails at startup
    # JSON lines with trace and tenant ids, PII redacted, for our loggers and the libraries' (T7.2).
    configure_logging(settings.log_level)
    app = FastAPI(title="Invoice Intelligence AI", version="0.1.0")
    app.state.settings = settings
    app.add_exception_handler(ServiceAuthError, service_auth_error_handler)

    @app.middleware("http")
    async def tenant_for_logs(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # The API names the tenant it calls for (X-Tenant-Id), so these log lines match its own.
        token = tenant_id_var.set(tenant_from_header(request.headers.get(TENANT_HEADER)))
        try:
            return await call_next(request)
        finally:
            tenant_id_var.reset(token)

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
    app.include_router(rag.router)
    app.include_router(qa.router)
    # Last: the instrumentation wraps the app as built. A no-op without an OTLP endpoint (T7.1).
    setup_tracing(app)
    return app


app = create_app()
