"""Gemini adapter over the public REST API (httpx; no SDK, so tests can fake HTTP statuses)."""

import base64
from typing import Any

import httpx

from app.providers.base import (
    MAX_OUTPUT_TOKENS,
    ImagePart,
    LLMRejected,
    LLMResult,
    LLMUnavailable,
    post_json,
)

BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


class GeminiProvider:
    name = "gemini"

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        timeout_s: float,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.model = model
        self.timeout_s = timeout_s
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
        parts: list[dict[str, Any]] = [{"text": user_text}]
        parts += [
            {"inlineData": {"mimeType": i.mime, "data": base64.b64encode(i.data).decode()}}
            for i in images
        ]
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "temperature": 0,
                "maxOutputTokens": MAX_OUTPUT_TOKENS,
                "responseMimeType": "application/json",
                "responseJsonSchema": json_schema,
            },
        }
        # The key goes in a header: a URL with the key would end up in proxies' and our own logs.
        data = post_json(
            self._client,
            f"{BASE_URL}/models/{self.model}:generateContent",
            {"x-goog-api-key": self._api_key},
            body,
        )
        try:
            candidate = data["candidates"][0]
            truncated = candidate.get("finishReason") == "MAX_TOKENS"
            # Thinking counts against the cap: when it uses all of it, the candidate has no parts.
            # That is a cut answer (422 in extract, not retried), not a bad response (503, retried).
            parts = (candidate.get("content") or {}).get("parts")
            if parts is None and not truncated:
                raise KeyError("parts")
            text = "".join(p.get("text", "") for p in parts or [])
            usage = data["usageMetadata"]
            output = int(usage.get("candidatesTokenCount", 0)) + int(
                usage.get("thoughtsTokenCount", 0)
            )
            return LLMResult(
                text=text,
                model=self.model,
                input_tokens=int(usage["promptTokenCount"]),
                output_tokens=output,
                truncated=truncated,
            )
        except (KeyError, IndexError, TypeError, ValueError):
            # No candidate usually means the prompt was blocked; the same input is blocked again.
            if not data.get("candidates"):
                raise LLMRejected("LLM_NO_CANDIDATE") from None
            raise LLMUnavailable("LLM_BAD_RESPONSE") from None
