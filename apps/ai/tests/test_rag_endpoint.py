"""T5.2: /index and /embed over HTTP (fake embedder, no network)."""

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app
from app.providers.base import LLMUnavailable
from app.providers.embedding import FakeEmbedder
from app.routers.rag import get_embedder

FIXTURES = Path(__file__).parent / "fixtures" / "chunking"
AUTH = {"Authorization": f"Bearer {os.environ['AI_SERVICE_TOKEN']}"}
client = TestClient(app)


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text("utf-8"))


@pytest.fixture(autouse=True)
def fake_embedder():
    provider = FakeEmbedder()
    app.dependency_overrides[get_embedder] = lambda: lambda: provider
    yield provider
    app.dependency_overrides.clear()


def test_index_returns_chunks_with_vectors() -> None:
    row = fixture("pdf-two-pages")
    res = client.post("/index", json=row, headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body["model"] == "fake-embedding"
    first = body["chunks"][0]
    assert first["chunk"]["kind"] == "header"
    assert first["chunk"]["document_id"] == row["document_id"]
    assert first["chunk"]["tenant_id"] == row["tenant_id"]
    assert len(first["embedding"]) == 768


def test_index_refuses_a_column_the_view_does_not_have() -> None:
    """The worker must send a `current_invoices` row as is; an extra column is a 422."""
    row = {**fixture("xml-vnd-one-line"), "status": "approved"}
    assert client.post("/index", json=row, headers=AUTH).status_code == 422


def test_index_refuses_data_that_breaks_the_schema() -> None:
    row = fixture("xml-vnd-one-line")
    row["data"]["total"] = "a lot"
    assert client.post("/index", json=row, headers=AUTH).status_code == 422


def test_embed_query() -> None:
    res = client.post("/embed", json={"texts": ["cà phê SAMPLE"], "task": "query"}, headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert len(body["vectors"]) == 1
    assert len(body["vectors"][0]) == 768
    assert body["usage"] == {"model": "fake-embedding", "texts": 1}


@pytest.mark.parametrize(
    "body",
    [
        {"texts": [], "task": "query"},
        {"texts": [""], "task": "query"},
        {"texts": ["x" * 8001], "task": "query"},
        {"texts": ["x"] * 513, "task": "document"},
        {"texts": ["x"], "task": "classify"},
        {"texts": ["x"], "task": "query", "extra": 1},
    ],
)
def test_embed_rejects_bad_requests(body: dict) -> None:
    assert client.post("/embed", json=body, headers=AUTH).status_code == 422


@pytest.mark.parametrize("path", ["/index", "/embed"])
def test_routes_need_the_service_token(path: str) -> None:
    res = client.post(path, json={})
    assert res.status_code == 401
    assert res.json()["code"] == "SERVICE_UNAUTHORIZED"


def test_provider_failure_keeps_its_code(fake_embedder: FakeEmbedder) -> None:
    class Down(FakeEmbedder):
        def embed(self, texts, task):  # type: ignore[no-untyped-def]
            raise LLMUnavailable("LLM_RATE_LIMITED")

    app.dependency_overrides[get_embedder] = lambda: Down
    res = client.post("/index", json=fixture("xml-vnd-one-line"), headers=AUTH)
    assert res.status_code == 503
    assert res.json()["code"] == "LLM_RATE_LIMITED"
    assert "SAMPLE" not in res.text


def test_a_missing_key_is_a_coded_503(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without an override the real getter builds Gemini. The settings are built here without
    the developer's env file, so this test can never reach the real provider."""
    app.dependency_overrides.clear()
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        ai_service_token=os.environ["AI_SERVICE_TOKEN"],
        llm_provider="gemini",
        gemini_api_key=None,
    )
    monkeypatch.setattr(app.state, "settings", settings)
    monkeypatch.setattr(app.state, "embedder", None, raising=False)
    res = client.post("/embed", json={"texts": ["x"], "task": "query"}, headers=AUTH)
    assert res.status_code == 503
    assert res.json()["code"] == "LLM_NOT_CONFIGURED"
