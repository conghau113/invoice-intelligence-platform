from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Validated at startup: a bad value fails fast instead of surfacing mid-request."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: Literal["development", "test", "production"] = "development"
    port: int = 8000
    log_level: Literal["debug", "info", "warning", "error"] = "info"


@lru_cache
def get_settings() -> Settings:
    return Settings()
