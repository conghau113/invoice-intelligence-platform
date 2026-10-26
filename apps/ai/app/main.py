from fastapi import FastAPI

from app.config import get_settings
from app.routers import extract, health


def create_app() -> FastAPI:
    settings = get_settings()  # raises on invalid config, so the process fails at startup
    app = FastAPI(title="Invoice Intelligence AI", version="0.1.0")
    app.state.settings = settings
    app.include_router(health.router)
    app.include_router(extract.router)
    return app


app = create_app()
