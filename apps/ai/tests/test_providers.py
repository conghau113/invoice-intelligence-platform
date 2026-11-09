import json

import httpx
import pytest

from app.providers.base import MAX_OUTPUT_TOKENS, ImagePart, LLMError
from app.providers.gemini import GeminiProvider
from app.providers.openai_compat import OpenAICompatProvider
from app.providers.pricing import estimate_cost_usd

IMG = ImagePart(data=b"PNGDATA", mime="image/png")
SCHEMA = {"type": "object"}
SENTINEL = "zz-sentinel-0001"  # stands for a credential; deliberately not key-shaped


def gemini(handler: httpx.MockTransport | None, **kw) -> GeminiProvider:
    return GeminiProvider(
        api_key=SENTINEL, model="gemini-2.5-flash", timeout_s=5, transport=handler
    )


def call(provider):
    return provider.generate(system="SYS", user_text="USER", images=[IMG], json_schema=SCHEMA)


def ok_gemini(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "candidates": [{"content": {"parts": [{"text": '{"a":1}'}]}}],
            "usageMetadata": {
                "promptTokenCount": 1000,
                "candidatesTokenCount": 100,
                "thoughtsTokenCount": 50,
            },
        },
    )


def test_gemini_request_shape_and_usage() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok_gemini(request)

    result = call(gemini(httpx.MockTransport(handler)))
    (request,) = seen
    body = json.loads(request.content)
    assert request.headers["x-goog-api-key"] == SENTINEL
    assert SENTINEL not in str(request.url)  # a key in the URL would land in access logs
    assert body["systemInstruction"]["parts"] == [{"text": "SYS"}]
    # Document content is an image part, never part of the instruction text.
    assert body["contents"][0]["parts"][1]["inlineData"]["mimeType"] == "image/png"
    assert body["generationConfig"]["responseJsonSchema"] == SCHEMA
    assert result.text == '{"a":1}'
    assert (result.input_tokens, result.output_tokens) == (1000, 150)  # thinking is billed output


@pytest.mark.parametrize(
    ("status", "code", "http"),
    [
        (429, "LLM_RATE_LIMITED", 503),
        (500, "LLM_UNAVAILABLE", 503),
        (503, "LLM_UNAVAILABLE", 503),
        (401, "LLM_MISCONFIGURED", 503),
        (404, "LLM_MISCONFIGURED", 503),
        (400, "LLM_REQUEST_REJECTED", 422),
    ],
)
def test_http_status_taxonomy(status: int, code: str, http: int) -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(status, text="SECRET BODY"))
    with pytest.raises(LLMError) as err:
        call(gemini(transport))
    assert (err.value.code, err.value.status) == (code, http)
    assert "SECRET BODY" not in str(err.value)  # provider bodies may echo the document


def test_timeout_and_network_errors_are_transient() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(LLMError) as err:
        call(gemini(httpx.MockTransport(boom)))
    assert (err.value.code, err.value.status) == ("LLM_TIMEOUT_OR_NETWORK", 503)


@pytest.mark.parametrize(
    "payload",
    [{"candidates": [], "promptFeedback": {"blockReason": "SAFETY"}}],
)
def test_blocked_prompt_is_permanent(payload: dict) -> None:
    with pytest.raises(LLMError) as err:
        call(gemini(httpx.MockTransport(lambda r: httpx.Response(200, json=payload))))
    assert (err.value.code, err.value.status) == ("LLM_NO_CANDIDATE", 422)


@pytest.mark.parametrize(
    "response", [httpx.Response(200, text="<html>"), httpx.Response(200, json=[1])]
)
def test_unparseable_answer_is_transient(response: httpx.Response) -> None:
    with pytest.raises(LLMError) as err:
        call(gemini(httpx.MockTransport(lambda r: response)))
    assert err.value.status == 503


def test_openai_compat_request_and_usage() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"a":1}'}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            },
        )

    provider = OpenAICompatProvider(
        base_url="https://llm.example/v1/",
        api_key=SENTINEL,
        model="m",
        timeout_s=5,
        transport=httpx.MockTransport(handler),
    )
    result = call(provider)
    (request,) = seen
    assert str(request.url) == "https://llm.example/v1/chat/completions"
    assert request.headers["authorization"] == f"Bearer {SENTINEL}"
    body = json.loads(request.content)
    assert body["messages"][1]["content"][1]["image_url"]["url"].startswith(
        "data:image/png;base64,"
    )
    assert (result.text, result.input_tokens, result.output_tokens) == ('{"a":1}', 10, 5)


def test_openai_compat_rate_limit_is_transient() -> None:
    provider = OpenAICompatProvider(
        base_url="https://llm.example/v1",
        api_key=SENTINEL,
        model="m",
        timeout_s=5,
        transport=httpx.MockTransport(lambda r: httpx.Response(429)),
    )
    with pytest.raises(LLMError) as err:
        call(provider)
    assert err.value.status == 503


def test_cost_comes_from_the_price_table() -> None:
    # 1M input + 1M output of the fake model: 1.00 + 4.00 USD.
    assert estimate_cost_usd("fake-model", 1_000_000, 1_000_000) == 5.0
    assert estimate_cost_usd("gemini-2.5-flash", 1000, 150) == round(
        (1000 * 0.30 + 150 * 2.50) / 1e6, 6
    )
    assert estimate_cost_usd("model-we-never-priced", 1000, 1000) == 0.0


def test_invalid_api_key_reported_as_400_is_our_misconfiguration_not_a_bad_file() -> None:
    body = {"error": {"code": 400, "message": "SECRET", "details": [{"reason": "API_KEY_INVALID"}]}}
    with pytest.raises(LLMError) as err:
        call(gemini(httpx.MockTransport(lambda r: httpx.Response(400, json=body))))
    assert (err.value.code, err.value.status) == ("LLM_MISCONFIGURED", 503)


def test_output_size_is_capped_so_a_looping_model_cannot_run_up_the_quota() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return ok_gemini(request)

    call(gemini(httpx.MockTransport(handler)))
    assert MAX_OUTPUT_TOKENS == 12288
    assert seen[0]["generationConfig"]["maxOutputTokens"] == MAX_OUTPUT_TOKENS

    sent: list[dict] = []

    def compat(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "{}"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    provider = OpenAICompatProvider(
        base_url="https://llm.example/v1",
        api_key=SENTINEL,
        model="m",
        timeout_s=5,
        transport=httpx.MockTransport(compat),
    )
    call(provider)
    assert sent[0]["max_tokens"] == MAX_OUTPUT_TOKENS


@pytest.mark.parametrize(("reason", "cut"), [("MAX_TOKENS", True), ("STOP", False), (None, False)])
def test_gemini_says_when_the_answer_stopped_at_the_cap(reason: str | None, cut: bool) -> None:
    candidate: dict = {"content": {"parts": [{"text": '{"a":'}]}}
    if reason is not None:
        candidate["finishReason"] = reason
    body = {
        "candidates": [candidate],
        "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": MAX_OUTPUT_TOKENS},
    }
    result = call(gemini(httpx.MockTransport(lambda r: httpx.Response(200, json=body))))
    assert result.truncated is cut


@pytest.mark.parametrize(("reason", "cut"), [("length", True), ("stop", False), (None, False)])
def test_openai_compat_says_when_the_answer_stopped_at_the_cap(
    reason: str | None, cut: bool
) -> None:
    choice: dict = {"message": {"content": '{"a":'}}
    if reason is not None:
        choice["finish_reason"] = reason
    body = {"choices": [choice], "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
    provider = OpenAICompatProvider(
        base_url="https://llm.example/v1",
        api_key=SENTINEL,
        model="m",
        timeout_s=5,
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=body)),
    )
    assert call(provider).truncated is cut


def test_gemini_cut_while_thinking_is_a_cut_answer_not_a_bad_response() -> None:
    # Thinking counts against the cap; when it takes all of it the candidate has no parts. A
    # LLM_BAD_RESPONSE (503) would be retried by the worker, paying for the same cut answer again.
    body = {
        "candidates": [{"finishReason": "MAX_TOKENS", "content": {"role": "model"}}],
        "usageMetadata": {"promptTokenCount": 10, "thoughtsTokenCount": MAX_OUTPUT_TOKENS},
    }
    result = call(gemini(httpx.MockTransport(lambda r: httpx.Response(200, json=body))))
    assert result.truncated
    assert result.text == ""
    assert result.output_tokens == MAX_OUTPUT_TOKENS  # billed even though nothing came back


def test_gemini_without_parts_and_not_cut_is_still_a_bad_response() -> None:
    body = {
        "candidates": [{"finishReason": "STOP", "content": {"role": "model"}}],
        "usageMetadata": {"promptTokenCount": 10},
    }
    with pytest.raises(LLMError) as err:
        call(gemini(httpx.MockTransport(lambda r: httpx.Response(200, json=body))))
    assert (err.value.code, err.value.status) == ("LLM_BAD_RESPONSE", 503)


def test_openai_compat_null_content_cut_at_the_cap_is_an_empty_cut_answer() -> None:
    # Reasoning models answer `content: null` when reasoning used the whole cap.
    body = {
        "choices": [{"message": {"content": None}, "finish_reason": "length"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": MAX_OUTPUT_TOKENS},
    }
    provider = OpenAICompatProvider(
        base_url="https://llm.example/v1",
        api_key=SENTINEL,
        model="m",
        timeout_s=5,
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=body)),
    )
    result = call(provider)
    assert result.truncated
    assert result.text == ""
