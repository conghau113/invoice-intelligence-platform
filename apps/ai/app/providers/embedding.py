"""Embedding providers (Strategy, ADR 0009): Gemini over REST and a deterministic fake for tests/CI.

`services/embed.py` depends only on `EmbeddingProvider`. Errors reuse the LLM taxonomy of
`providers/base.py` (same codes, same HTTP statuses), so the worker classifies them the same way.
No exception message ever contains a provider response body or the text that was embedded.
"""

import hashlib
import math
import re
from typing import Any, Literal, Protocol

import httpx

from app.config import Settings
from app.providers.base import LLMUnavailable, post_json
from app.providers.gemini import BASE_URL

# pgvector's HNSW index takes at most 2,000 dimensions for `vector` (ADR 0011); Gemini embeddings
# support Matryoshka truncation, so 768 keeps the index small on the demo VM.
EMBEDDING_DIMENSIONS = 768
EMBEDDING_MODEL = "gemini-embedding-001"

# What the text is for. Gemini embeds a stored passage and a question differently on purpose.
EmbedTask = Literal["document", "query"]
_GEMINI_TASK = {"document": "RETRIEVAL_DOCUMENT", "query": "RETRIEVAL_QUERY"}


class EmbeddingProvider(Protocol):
    model: str

    def embed(self, texts: list[str], task: EmbedTask) -> list[list[float]]:
        """One vector of EMBEDDING_DIMENSIONS floats per text, in order. Not normalised."""
        ...


def _vector(values: Any) -> list[float]:
    """A provider vector, checked: right length, finite numbers. Anything else is a bad answer."""
    if not isinstance(values, list) or len(values) != EMBEDDING_DIMENSIONS:
        raise LLMUnavailable("LLM_BAD_RESPONSE")
    try:
        out = [float(v) for v in values]
    except (TypeError, ValueError):
        raise LLMUnavailable("LLM_BAD_RESPONSE") from None
    if not all(math.isfinite(v) for v in out):
        raise LLMUnavailable("LLM_BAD_RESPONSE")
    return out


class GeminiEmbedder:
    """`models/{model}:batchEmbedContents`: one HTTP call for a batch of texts."""

    def __init__(
        self,
        *,
        api_key: str,
        timeout_s: float,
        model: str = EMBEDDING_MODEL,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.model = model
        self._api_key = api_key
        self._client = httpx.Client(timeout=timeout_s, transport=transport)

    def embed(self, texts: list[str], task: EmbedTask) -> list[list[float]]:
        body = {
            "requests": [
                {
                    "model": f"models/{self.model}",
                    "content": {"parts": [{"text": t}]},
                    "taskType": _GEMINI_TASK[task],
                    "outputDimensionality": EMBEDDING_DIMENSIONS,
                }
                for t in texts
            ]
        }
        # The key goes in a header: a URL with the key would end up in proxies' and our own logs.
        data = post_json(
            self._client,
            f"{BASE_URL}/models/{self.model}:batchEmbedContents",
            {"x-goog-api-key": self._api_key},
            body,
        )
        embeddings = data.get("embeddings")
        if not isinstance(embeddings, list) or len(embeddings) != len(texts):
            raise LLMUnavailable("LLM_BAD_RESPONSE")
        return [_vector(e.get("values") if isinstance(e, dict) else None) for e in embeddings]


_WORD = re.compile(r"\w+")


class FakeEmbedder:
    """Feature hashing over words: no network, no key, and texts that share words get close
    vectors, so retrieval can be tested offline (T5.3). Never allowed in production (config)."""

    model = "fake-embedding"

    def __init__(self) -> None:
        self.calls: list[tuple[list[str], EmbedTask]] = []

    def embed(self, texts: list[str], task: EmbedTask) -> list[list[float]]:
        self.calls.append((list(texts), task))
        return [self._one(t) for t in texts]

    @staticmethod
    def _one(text: str) -> list[float]:
        v = [0.0] * EMBEDDING_DIMENSIONS
        for word in _WORD.findall(text.lower()):
            digest = hashlib.blake2b(word.encode(), digest_size=8).digest()
            index = int.from_bytes(digest[:4], "big") % EMBEDDING_DIMENSIONS
            v[index] += 1.0 if digest[4] % 2 == 0 else -1.0
        if not any(v):  # no word at all: a fixed direction, so the vector can still be normalised
            v[0] = 1.0
        return v


def build_embedder(settings: Settings) -> EmbeddingProvider:
    """Embeddings always come from Gemini (ADR 0009), whichever provider extracts; the fake one
    goes with LLM_PROVIDER=fake, so tests and CI need no second switch. A missing key is a 503.
    Kept out of `providers/__init__.py`: the eval gate hashes that file as part of extraction."""
    if settings.llm_provider == "fake":
        return FakeEmbedder()
    if settings.gemini_api_key is None:
        raise LLMUnavailable("LLM_NOT_CONFIGURED")
    return GeminiEmbedder(
        api_key=settings.gemini_api_key.get_secret_value(), timeout_s=settings.llm_timeout_s
    )
