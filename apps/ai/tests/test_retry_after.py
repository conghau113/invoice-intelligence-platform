"""T6.2: a provider's 429 wait reaches the API worker as a Retry-After header (fake transports)."""

import json
import os

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app
from app.providers import build_provider
from app.providers.base import MAX_RETRY_AFTER_S, LLMError, LLMUnavailable, retry_after_s
from app.providers.embedding import FakeEmbedder
from app.providers.fake import FakeProvider
from app.providers.gemini import GeminiProvider
from app.providers.openai_compat import OpenAICompatProvider
from app.routers.rag import get_embedder
from app.services.pdf_pages import encode_png

PNG = encode_png(1, 1, b"\x00\x00\x00", 3)
AUTH = {"Authorization": f"Bearer {os.environ['AI_SERVICE_TOKEN']}"}
client = TestClient(app, headers=AUTH)


def google_429(delay: object, message: str = "SECRET quota text") -> httpx.Response:
    """The shape of a Google API error: status, message, details with a RetryInfo."""
    return httpx.Response(
        429,
        json={
            "error": {
                "code": 429,
                "message": message,
                "status": "RESOURCE_EXHAUSTED",
                "details": [
                    {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": []},
                    {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": delay},
                ],
            }
        },
    )


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (httpx.Response(429, headers={"Retry-After": "7"}), 7),
        (httpx.Response(429, headers={"Retry-After": "0"}), 1),  # at least one second
        (httpx.Response(429, headers={"Retry-After": "86400"}), MAX_RETRY_AFTER_S),
        (google_429("37s"), 37),
        (google_429("1.5s"), 2),  # rounded up: waiting less than asked is refused again
        (google_429("0.2s"), 1),
        (google_429("90000s"), MAX_RETRY_AFTER_S),
    ],
)
def test_reads_the_wait_from_the_header_or_google_retry_info(
    response: httpx.Response, expected: int
) -> None:
    assert retry_after_s(response) == expected


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(429),
        httpx.Response(429, text="not json"),
        httpx.Response(429, headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}),
        httpx.Response(429, headers={"Retry-After": "-5"}),
        httpx.Response(429, headers={"Retry-After": "1234567"}),  # too many digits to trust
        httpx.Response(
            429, headers={"Retry-After": "\u00b2".encode()}
        ),  # a digit to str.isdigit, not to int()
        httpx.Response(429, headers={"Retry-After": "\u0663".encode()}),  # Arabic-Indic three
        google_429("37s\n"),  # $ would match before a trailing newline
        google_429("37"),  # no unit
        google_429("abc s"),
        google_429(37),
        httpx.Response(429, json={"error": {"details": "not a list"}}),
        httpx.Response(429, json={"error": {"details": [{"@type": "x.RetryInfo"}]}}),
    ],
)
def test_says_nothing_when_the_provider_gives_no_usable_wait(response: httpx.Response) -> None:
    assert retry_after_s(response) is None


def call(provider) -> None:  # type: ignore[no-untyped-def]
    provider.generate(system="s", user_text="u", images=[], json_schema={"type": "object"})


def test_a_gemini_429_carries_its_retry_delay_and_never_its_message() -> None:
    provider = GeminiProvider(
        api_key="k",
        model="m",
        timeout_s=5,
        transport=httpx.MockTransport(lambda r: google_429("12s")),
    )
    with pytest.raises(LLMError) as err:
        call(provider)
    assert (err.value.code, err.value.status, err.value.retry_after_s) == (
        "LLM_RATE_LIMITED",
        503,
        12,
    )
    assert "SECRET" not in str(err.value)


def test_an_openai_compatible_429_carries_its_retry_after_header() -> None:
    provider = OpenAICompatProvider(
        base_url="https://llm.example/v1",
        api_key="k",
        model="m",
        timeout_s=5,
        transport=httpx.MockTransport(lambda r: httpx.Response(429, headers={"retry-after": "20"})),
    )
    with pytest.raises(LLMError) as err:
        call(provider)
    assert err.value.retry_after_s == 20


def test_other_failures_carry_no_wait() -> None:
    provider = GeminiProvider(
        api_key="k",
        model="m",
        timeout_s=5,
        transport=httpx.MockTransport(lambda r: httpx.Response(503, headers={"Retry-After": "9"})),
    )
    with pytest.raises(LLMError) as err:
        call(provider)
    assert (err.value.code, err.value.retry_after_s) == ("LLM_UNAVAILABLE", None)


# --- over HTTP ---------------------------------------------------------------------------------


@pytest.fixture
def use_provider(monkeypatch: pytest.MonkeyPatch):
    def install(provider: FakeProvider) -> None:
        monkeypatch.setattr(app.state, "llm_provider", provider, raising=False)

    return install


def extract(data: bytes = PNG):  # type: ignore[no-untyped-def]
    return client.post("/extract", files={"file": ("f", data)}, data={"sourceType": "image"})


def test_extract_answers_503_with_the_provider_wait_as_retry_after(use_provider) -> None:
    use_provider(FakeProvider([LLMUnavailable("LLM_RATE_LIMITED", 9)]))
    res = extract()
    assert res.status_code == 503
    assert res.headers["retry-after"] == "9"
    assert res.json()["code"] == "LLM_RATE_LIMITED"


def test_extract_sends_no_retry_after_when_the_provider_gave_none(use_provider) -> None:
    use_provider(FakeProvider([LLMUnavailable("LLM_UNAVAILABLE")]))
    res = extract()
    assert res.status_code == 503
    assert "retry-after" not in res.headers


def test_index_answers_503_with_retry_after() -> None:
    class Limited(FakeEmbedder):
        def embed(self, texts, task):  # type: ignore[no-untyped-def]
            raise LLMUnavailable("LLM_RATE_LIMITED", 30)

    app.dependency_overrides[get_embedder] = lambda: Limited
    try:
        res = client.post("/embed", json={"texts": ["SAMPLE"], "task": "query"})
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 503
    assert res.headers["retry-after"] == "30"


# --- the fake provider's rate limit, for watching the API slow down (dev and drills) ------------


def test_fake_provider_refuses_every_nth_call_with_a_wait() -> None:
    provider = FakeProvider(rate_limit_every=3, retry_after_s=4)
    outcomes = []
    for _ in range(7):
        try:
            call(provider)
            outcomes.append("ok")
        except LLMUnavailable as err:
            outcomes.append(f"{err.code}:{err.retry_after_s}")
    limited = "LLM_RATE_LIMITED:4"
    assert outcomes == ["ok", "ok", limited, "ok", "ok", limited, "ok"]


def test_fake_provider_is_never_limited_by_default() -> None:
    provider = FakeProvider()
    for _ in range(10):
        call(provider)


def test_settings_build_the_fake_with_its_rate_limit() -> None:
    settings = Settings(
        _env_file=None,
        ai_service_token="x" * 20,
        llm_provider="fake",
        fake_llm_rate_limit_every=2,
        fake_llm_retry_after_s=5,
    )
    provider = build_provider(settings)
    call(provider)
    with pytest.raises(LLMUnavailable) as err:
        call(provider)
    assert err.value.retry_after_s == 5


@pytest.mark.parametrize(
    "bad",
    [
        {"fake_llm_rate_limit_every": -1},
        {"fake_llm_retry_after_s": 0},
        {"fake_llm_retry_after_s": 301},
    ],
)
def test_settings_refuse_nonsense_rate_limit_values(bad: dict) -> None:
    with pytest.raises(ValueError):
        Settings(_env_file=None, ai_service_token="x" * 20, llm_provider="fake", **bad)


def test_the_extract_body_never_echoes_the_provider_message(use_provider) -> None:
    use_provider(FakeProvider([LLMUnavailable("LLM_RATE_LIMITED", 3)]))
    body = json.dumps(extract().json())
    assert "SECRET" not in body
