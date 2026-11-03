from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
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

    # LLM path (PDF/image). Only synthetic data may ever reach a provider (ADR 0009, docs/LEGAL.md).
    llm_provider: Literal["gemini", "openai_compat", "fake"] = "gemini"
    llm_model: str = "gemini-3.1-flash-lite"  # 2.5-flash is closed to new keys (404)
    llm_timeout_s: float = Field(default=45.0, gt=0, le=120)  # API worker allows 60 s (T3.2)
    gemini_api_key: SecretStr | None = Field(default=None, repr=False)
    # Fallback provider through its official OpenAI-compatible API (chosen in T4.4).
    llm_fallback_base_url: str | None = None
    llm_fallback_api_key: SecretStr | None = Field(default=None, repr=False)

    @model_validator(mode="after")
    def _check_llm(self) -> "Settings":
        # The fake provider returns canned data: in production that would be silent corruption.
        if self.llm_provider == "fake" and self.env == "production":
            raise ValueError("LLM_PROVIDER=fake is not allowed when ENV=production")
        # The fallback receives the API key and the invoice: never over plain http.
        if self.llm_fallback_base_url and not self.llm_fallback_base_url.startswith("https://"):
            raise ValueError("LLM_FALLBACK_BASE_URL must start with https://")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
