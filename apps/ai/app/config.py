from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Validated at startup: a bad value fails fast instead of surfacing mid-request."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: Literal["development", "test", "production"] = "development"
    port: int = 8000
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    # Shared secret the API worker sends as a bearer token. Required (no default) so a forgotten
    # variable stops the process at startup instead of leaving /extract open.
    ai_service_token: str = Field(min_length=16, repr=False)


@lru_cache
def get_settings() -> Settings:
    return Settings()
