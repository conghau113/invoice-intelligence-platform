"""The judge's own provider settings (`RAG_JUDGE_*`), apart from the product's.

The product has one fallback slot (`LLM_FALLBACK_*`, ADR 0009); the judge is an eval tool and must
not take that slot over, nor be switched by `LLM_PROVIDER`. It reads three variables, from the
environment or from apps/ai's env file (the environment wins), and uses the product's
OpenAI-compatible adapter with the same safety checks: https only, no credentials in the URL.

Strict decoding is switched on here, by a transport that adds `"strict": true` to the request,
not in the adapter: the adapter is a pipeline file of the extraction eval gate (eval/runner/gate.py,
.github/workflows/eval.yml), and the product fallback keeps the behaviour measured in T4.4.
"""

import json
from urllib.parse import urlsplit

import httpx
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.providers.openai_compat import OpenAICompatProvider

# Same per-call limit as the product's providers (config.py `llm_timeout_s` default).
JUDGE_TIMEOUT_S = 45.0


class StrictSchemaTransport(httpx.BaseTransport):
    """Asks the provider for constrained decoding (Groq: `strict: true` guarantees the schema).

    Best-effort output of the same judge broke the schema on 10 of 42 calls (zero-width spaces in
    keys, a bare list, an invented key; T5.6). Only the `json_schema` object of the request changes.
    """

    def __init__(self, inner: httpx.BaseTransport | None = None) -> None:
        self._inner = inner or httpx.HTTPTransport()

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.read())
        body["response_format"]["json_schema"]["strict"] = True
        content = json.dumps(body).encode()
        headers = {k: v for k, v in request.headers.items() if k.lower() != "content-length"}
        # `extensions` carries the client's timeout; a new request without it waits forever.
        strict = httpx.Request(
            request.method,
            request.url,
            headers=headers,
            content=content,
            extensions=request.extensions,
        )
        return self._inner.handle_request(strict)

    def close(self) -> None:
        self._inner.close()


class JudgeConfigError(Exception):
    """A judge variable is missing or unsafe. The message names the variable, never its value."""


class JudgeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RAG_JUDGE_", env_file=".env", extra="ignore")

    base_url: str | None = None
    api_key: SecretStr | None = None
    model: str = "qwen/qwen3.8-27b"


def build_judge(
    settings: JudgeSettings, transport: httpx.BaseTransport | None = None
) -> tuple[OpenAICompatProvider, str]:
    """The judge provider and the host it calls (printed, so a run shows which service judges)."""
    if not settings.base_url:
        raise JudgeConfigError("RAG_JUDGE_BASE_URL is not set (see eval/rag/README.md)")
    if settings.api_key is None or not settings.api_key.get_secret_value():
        raise JudgeConfigError("RAG_JUDGE_API_KEY is not set (see eval/rag/README.md)")
    url = urlsplit(settings.base_url)
    # The key and the answers go to this URL: never over plain http, and no key inside the URL,
    # where it would be copied to wherever the URL is printed.
    if url.scheme != "https" or not url.hostname:
        raise JudgeConfigError("RAG_JUDGE_BASE_URL must be an https:// URL")
    if url.username or url.password or url.query or url.fragment:
        raise JudgeConfigError("RAG_JUDGE_BASE_URL must not carry credentials or a query")
    provider = OpenAICompatProvider(
        base_url=settings.base_url,
        api_key=settings.api_key.get_secret_value(),
        model=settings.model,
        timeout_s=JUDGE_TIMEOUT_S,
        transport=StrictSchemaTransport(transport),
    )
    return provider, url.hostname
