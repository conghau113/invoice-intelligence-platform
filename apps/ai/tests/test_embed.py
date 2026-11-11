"""T5.2: embedding providers and the embed/index service."""

import json
import math
from pathlib import Path

import httpx
import pytest

from app.config import Settings
from app.providers.base import LLMError
from app.providers.embedding import (
    EMBEDDING_DIMENSIONS,
    FakeEmbedder,
    GeminiEmbedder,
    build_embedder,
)
from app.services.chunking import ApprovedInvoiceRow, chunk_invoice
from app.services.embed import EMBED_BATCH_SIZE, EMBED_MAX_CHARS, embed_texts, index_invoice

FIXTURES = Path(__file__).parent / "fixtures" / "chunking"
SENTINEL = "zz-sentinel-0002"  # stands for a credential; deliberately not key-shaped
TOKEN = "test-service-token-0123456789"


def row(name: str) -> ApprovedInvoiceRow:
    return ApprovedInvoiceRow.model_validate_json((FIXTURES / f"{name}.json").read_text("utf-8"))


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))  # unit vectors


def gemini(handler) -> GeminiEmbedder:
    return GeminiEmbedder(api_key=SENTINEL, timeout_s=5, transport=httpx.MockTransport(handler))


def answer(n: int, values: list[float] | None = None) -> httpx.Response:
    v = values if values is not None else [0.5] * EMBEDDING_DIMENSIONS
    return httpx.Response(200, json={"embeddings": [{"values": v} for _ in range(n)]})


# --- Gemini adapter ---------------------------------------------------------------------------


def test_gemini_request_shape() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer(2)

    vectors = gemini(handler).embed(["a SAMPLE", "b SAMPLE"], "query")
    (request,) = seen
    body = json.loads(request.content)
    assert str(request.url).endswith("/models/gemini-embedding-001:batchEmbedContents")
    assert request.headers["x-goog-api-key"] == SENTINEL
    assert SENTINEL not in str(request.url)
    assert [r["content"]["parts"][0]["text"] for r in body["requests"]] == ["a SAMPLE", "b SAMPLE"]
    assert {r["taskType"] for r in body["requests"]} == {"RETRIEVAL_QUERY"}
    assert {r["outputDimensionality"] for r in body["requests"]} == {768}
    assert {r["model"] for r in body["requests"]} == {"models/gemini-embedding-001"}
    assert len(vectors) == 2


def test_gemini_document_task() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return answer(1)

    gemini(handler).embed(["x"], "document")
    assert seen[0]["requests"][0]["taskType"] == "RETRIEVAL_DOCUMENT"


@pytest.mark.parametrize(
    "body",
    [
        {"embeddings": [{"values": [0.1] * 767}]},  # wrong length
        {"embeddings": [{"values": [0.1] * 767 + ["x"]}]},  # not a number
        {"embeddings": []},  # fewer vectors than texts
        {"embeddings": [{}]},
        {"embeddings": ["nope"]},
        {"something": "else"},
    ],
)
def test_gemini_bad_answer_is_a_coded_error(body: dict) -> None:
    with pytest.raises(LLMError) as err:
        gemini(lambda _r: httpx.Response(200, json=body)).embed(["x"], "document")
    assert (err.value.code, err.value.status) == ("LLM_BAD_RESPONSE", 503)


def test_gemini_infinite_value_is_a_bad_answer() -> None:
    """1e400 is valid JSON but parses to inf; a vector holding it would poison every distance."""
    raw = '{"embeddings": [{"values": [' + "0.1, " * 767 + "1e400]}]}"

    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=raw, headers={"content-type": "application/json"})

    with pytest.raises(LLMError) as err:
        gemini(handler).embed(["x"], "document")
    assert err.value.code == "LLM_BAD_RESPONSE"


@pytest.mark.parametrize(
    ("status", "code", "http"),
    [
        (429, "LLM_RATE_LIMITED", 503),
        (500, "LLM_UNAVAILABLE", 503),
        (403, "LLM_MISCONFIGURED", 503),
        (400, "LLM_REQUEST_REJECTED", 422),
    ],
)
def test_gemini_http_errors_use_the_llm_taxonomy(status: int, code: str, http: int) -> None:
    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": {"message": "echo SAMPLE text"}})

    with pytest.raises(LLMError) as err:
        gemini(handler).embed(["SAMPLE text"], "document")
    assert (err.value.code, err.value.status) == (code, http)
    assert "SAMPLE" not in str(err.value)


# --- service -------------------------------------------------------------------------------------


def test_vectors_are_unit_length_and_in_order() -> None:
    provider = FakeEmbedder()
    texts = ["cà phê SAMPLE", "giấy in SAMPLE", "cà phê SAMPLE"]
    vectors = embed_texts(provider, texts, "document")
    assert [len(v) for v in vectors] == [768] * 3
    assert all(math.isclose(sum(x * x for x in v), 1.0) for v in vectors)
    assert vectors[0] == vectors[2]
    assert vectors[0] != vectors[1]


def test_gemini_vectors_are_normalised() -> None:
    """Gemini's docs: dimensions below 3,072 are not unit length and must be normalised."""
    vectors = embed_texts(gemini(lambda _r: answer(1, [3.0] * 768)), ["x"], "query")
    assert math.isclose(sum(x * x for x in vectors[0]), 1.0)


def test_a_zero_vector_is_a_bad_answer() -> None:
    with pytest.raises(LLMError) as err:
        embed_texts(gemini(lambda _r: answer(1, [0.0] * 768)), ["x"], "query")
    assert err.value.code == "LLM_BAD_RESPONSE"


def test_texts_go_out_in_batches() -> None:
    provider = FakeEmbedder()
    vectors = embed_texts(provider, [f"t{i}" for i in range(EMBED_BATCH_SIZE * 2 + 1)], "document")
    assert [len(batch) for batch, _ in provider.calls] == [EMBED_BATCH_SIZE, EMBED_BATCH_SIZE, 1]
    assert len(vectors) == EMBED_BATCH_SIZE * 2 + 1


def test_only_the_text_sent_to_the_model_is_cut() -> None:
    provider = FakeEmbedder()
    long = "x" * (EMBED_MAX_CHARS + 500)
    embed_texts(provider, [long, "short"], "document")
    sent, _ = provider.calls[0]
    assert sent == ["x" * EMBED_MAX_CHARS, "short"]


def test_exactly_the_cap_is_sent_whole() -> None:
    provider = FakeEmbedder()
    embed_texts(provider, ["y" * EMBED_MAX_CHARS], "document")
    assert provider.calls[0][0] == ["y" * EMBED_MAX_CHARS]


def test_a_provider_that_drops_a_vector_is_caught() -> None:
    class Short(FakeEmbedder):
        def embed(self, texts, task):  # type: ignore[no-untyped-def]
            return super().embed(texts, task)[:-1]

    with pytest.raises(LLMError) as err:
        embed_texts(Short(), ["a", "b"], "document")
    assert err.value.code == "LLM_BAD_RESPONSE"


def test_shared_words_bring_vectors_closer() -> None:
    """What makes the fake useful for retrieval tests (T5.3)."""
    a, b, c = embed_texts(
        FakeEmbedder(),
        ["cà phê hạt SAMPLE 1kg", "cà phê hạt SAMPLE 500g", "thuê văn phòng tháng 9"],
        "document",
    )
    assert cosine(a, b) > cosine(a, c)


def test_index_keeps_the_whole_chunk_and_embeds_every_one() -> None:
    r = row("many-lines")
    provider = FakeEmbedder()
    result = index_invoice(provider, r)
    assert [i.chunk for i in result.chunks] == chunk_invoice(r)
    assert {task for _, task in provider.calls} == {"document"}
    assert all(len(i.embedding) == 768 for i in result.chunks)
    assert result.model == "fake-embedding"


def test_index_is_deterministic() -> None:
    """Same row, same chunks and vectors: re-indexing a version changes nothing (idempotent)."""
    r = row("pdf-two-pages")
    assert index_invoice(FakeEmbedder(), r) == index_invoice(FakeEmbedder(), r)


# --- configuration -------------------------------------------------------------------------------


def test_fake_llm_means_fake_embeddings() -> None:
    settings = Settings(_env_file=None, ai_service_token=TOKEN, llm_provider="fake")
    assert isinstance(build_embedder(settings), FakeEmbedder)


def test_gemini_without_a_key_is_not_configured() -> None:
    settings = Settings(
        _env_file=None, ai_service_token=TOKEN, llm_provider="gemini", gemini_api_key=None
    )
    with pytest.raises(LLMError) as err:
        build_embedder(settings)
    assert err.value.code == "LLM_NOT_CONFIGURED"


def test_another_extraction_provider_still_embeds_with_gemini() -> None:
    settings = Settings(
        _env_file=None,
        ai_service_token=TOKEN,
        llm_provider="openai_compat",
        gemini_api_key=SENTINEL,
        llm_fallback_base_url="https://example.invalid/v1",
        llm_fallback_api_key=SENTINEL,
    )
    assert isinstance(build_embedder(settings), GeminiEmbedder)
