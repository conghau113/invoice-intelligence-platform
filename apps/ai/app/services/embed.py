"""Text -> unit vectors for RAG (T5.2), and an approved invoice -> chunks with their vectors.

Stateless like the rest of this service: the API worker reads the row of `current_invoices`,
sends it here and writes the result to `chunks` itself (ADR 0002). Nothing is logged: chunk text
is document content.

Input limit: `gemini-embedding-001` takes at most 2,048 tokens per text. Only the text sent to the
model is cut, at EMBED_MAX_CHARS characters; the stored `content` stays whole for full-text search
and citations. The cap equals the chunk budget of T5.1, so only a chunk that is already oversized
(one very long line, a header with long names) is cut. Characters, not tokens: counting tokens
needs a call to the provider. Should a text still exceed the token limit, the provider cuts it too.
"""

import math

from pydantic import BaseModel, ConfigDict

from app.providers.base import LLMUnavailable
from app.providers.embedding import EmbeddingProvider, EmbedTask
from app.services.chunking import MAX_CHUNK_CHARS, ApprovedInvoiceRow, Chunk, chunk_invoice

EMBED_MAX_CHARS = MAX_CHUNK_CHARS
# Texts per provider call. Gemini's current docs state no batch limit for batchEmbedContents; 100
# is the limit earlier API references gave. Not measured (that would cost a request on purpose).
EMBED_BATCH_SIZE = 100
# Texts per request to /embed. A query is one text; an invoice of 2,000 lines is ~200 chunks.
MAX_TEXTS = 512
# Below this length a vector has no usable direction (an all-zero or underflowed answer).
MIN_NORM = 1e-12


def _unit(v: list[float]) -> list[float]:
    """L2-normalised. Gemini vectors cut below 3,072 dims are not unit length (its docs say to
    normalise them); cosine distance would not care, but a unit vector keeps scores comparable."""
    norm = math.sqrt(sum(x * x for x in v))
    # (Nearly) zero: no direction to keep, and dividing would only blow up noise.
    if norm < MIN_NORM:
        raise LLMUnavailable("LLM_BAD_RESPONSE")
    return [x / norm for x in v]


def embed_texts(
    provider: EmbeddingProvider, texts: list[str], task: EmbedTask
) -> list[list[float]]:
    """One unit vector per text, in order, in batches of EMBED_BATCH_SIZE."""
    vectors: list[list[float]] = []
    for start in range(0, len(texts), EMBED_BATCH_SIZE):
        batch = [t[:EMBED_MAX_CHARS] for t in texts[start : start + EMBED_BATCH_SIZE]]
        got = provider.embed(batch, task)
        if len(got) != len(batch):
            raise LLMUnavailable("LLM_BAD_RESPONSE")
        vectors.extend(_unit(v) for v in got)
    return vectors


class IndexedChunk(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    chunk: Chunk
    embedding: list[float]


class IndexResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    model: str
    chunks: list[IndexedChunk]


def index_invoice(provider: EmbeddingProvider, row: ApprovedInvoiceRow) -> IndexResult:
    chunks = chunk_invoice(row)
    vectors = embed_texts(provider, [c.content for c in chunks], "document")
    return IndexResult(
        model=provider.model,
        chunks=[IndexedChunk(chunk=c, embedding=v) for c, v in zip(chunks, vectors, strict=True)],
    )
