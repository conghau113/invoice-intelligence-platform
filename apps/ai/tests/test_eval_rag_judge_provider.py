"""The judge's own settings (T5.6): it never reuses the product's fallback slot, and refuses a
missing key or an unsafe URL before any call, without printing the key."""

import json

import httpx
import pytest
from rag.judge_provider import JUDGE_TIMEOUT_S, JudgeConfigError, JudgeSettings, build_judge

from app.providers.openai_compat import OpenAICompatProvider

KEY = "gsk_SAMPLE_not_a_real_key"


def settings(**over: object) -> JudgeSettings:
    values: dict[str, object] = {
        "base_url": "https://api.groq.com/openai/v1",
        "api_key": KEY,
        "model": "qwen/qwen3.8-27b",
    }
    values.update(over)
    return JudgeSettings(_env_file=None, **values)  # type: ignore[arg-type]


def test_builds_the_openai_compatible_adapter_and_names_the_host() -> None:
    provider, host = build_judge(settings())
    assert isinstance(provider, OpenAICompatProvider)
    assert (provider.model, host) == ("qwen/qwen3.8-27b", "api.groq.com")


def test_reads_its_own_variables_not_the_product_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_FALLBACK_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("RAG_JUDGE_BASE_URL", "https://api.groq.com/openai/v1")
    monkeypatch.setenv("RAG_JUDGE_API_KEY", KEY)
    _, host = build_judge(JudgeSettings(_env_file=None))  # type: ignore[call-arg]
    assert host == "api.groq.com"


@pytest.mark.parametrize(
    ("over", "variable"),
    [
        ({"base_url": None}, "RAG_JUDGE_BASE_URL"),
        ({"api_key": None}, "RAG_JUDGE_API_KEY"),
        ({"api_key": ""}, "RAG_JUDGE_API_KEY"),
        ({"base_url": "http://api.groq.com/openai/v1"}, "https"),
        ({"base_url": "https://user:pass@api.groq.com/v1"}, "credentials"),
        ({"base_url": "https://api.groq.com/v1?key=x"}, "credentials"),
    ],
)
def test_refuses_a_missing_or_unsafe_setting_without_the_key(over: dict, variable: str) -> None:
    with pytest.raises(JudgeConfigError) as err:
        build_judge(settings(**over))
    assert variable in str(err.value)
    assert KEY not in str(err.value)


def test_every_judge_request_asks_for_strict_decoding_and_keeps_the_rest() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "{}"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    provider, _ = build_judge(settings(), transport=httpx.MockTransport(handler))
    schema = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
    provider.generate(system="S", user_text="U", images=[], json_schema=schema)
    (request,) = seen
    body = json.loads(request.content)
    assert body["response_format"]["json_schema"] == {
        "name": "invoice",
        "schema": schema,
        "strict": True,
    }
    assert body["messages"][0] == {"role": "system", "content": "S"}
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert int(request.headers["content-length"]) == len(request.content)
    timeout = request.extensions["timeout"]
    assert timeout["read"] == timeout["connect"] == JUDGE_TIMEOUT_S
