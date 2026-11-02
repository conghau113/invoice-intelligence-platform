"""Fallback adapter for any official OpenAI-compatible chat API (provider picked in T4.4)."""

import base64
from typing import Any

import httpx

from app.providers.base import ImagePart, LLMResult, LLMUnavailable, post_json

MAX_OUTPUT_TOKENS = 8192


class OpenAICompatProvider:
    name = "openai_compat"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_s: float,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.model = model
        self.timeout_s = timeout_s
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._api_key = api_key
        self._client = httpx.Client(timeout=timeout_s, transport=transport)

    def generate(
        self,
        *,
        system: str,
        user_text: str,
        images: list[ImagePart],
        json_schema: dict[str, Any],
    ) -> LLMResult:
        content: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
        content += [
            {
                "type": "image_url",
                "image_url": {"url": f"data:{i.mime};base64,{base64.b64encode(i.data).decode()}"},
            }
            for i in images
        ]
        body = {
            "model": self.model,
            "temperature": 0,
            "max_tokens": MAX_OUTPUT_TOKENS,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "invoice", "schema": json_schema},
            },
        }
        data = post_json(
            self._client, self._url, {"authorization": f"Bearer {self._api_key}"}, body
        )
        try:
            return LLMResult(
                text=data["choices"][0]["message"]["content"],
                model=self.model,
                input_tokens=int(data["usage"]["prompt_tokens"]),
                output_tokens=int(data["usage"]["completion_tokens"]),
            )
        except (KeyError, IndexError, TypeError, ValueError):
            raise LLMUnavailable("LLM_BAD_RESPONSE") from None
