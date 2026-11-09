import json
import logging
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app
from app.providers import build_provider
from app.providers.base import MAX_OUTPUT_TOKENS, LLMError, LLMResult, LLMUnavailable
from app.providers.fake import CANNED_LLM_OUTPUT, FakeProvider
from app.services import extract as extract_module
from app.services.extract import PROMPT_VERSION, SYSTEM_PROMPT, ExtractError, extract
from app.services.pdf_pages import encode_png

SAMPLE_PDF = Path(__file__).parent / "fixtures" / "pdf_invoices" / "invoice-00.pdf"
VALID = json.dumps(CANNED_LLM_OUTPUT)
PNG = encode_png(1, 1, b"\x00\x00\x00", 3)
PII = "TEN-BI-MAT-ABC"  # stands for document text the model might echo


def run(provider: FakeProvider, data: bytes = PNG, source: str = "image"):
    return extract(data, source, lambda: provider)  # type: ignore[arg-type]


def bad_invoice(**patch) -> str:
    return json.dumps({**CANNED_LLM_OUTPUT, **patch})


def test_valid_answer_returns_invoice_and_usage() -> None:
    provider = FakeProvider([VALID])
    out = run(provider)
    assert out["invoice"].total == 1100000
    assert out["warnings"] == []
    usage = out["usage"]
    assert usage["model"] == "fake-model" and usage["promptVersion"] == PROMPT_VERSION
    assert (usage["inputTokens"], usage["outputTokens"]) == (1000, 200)
    assert usage["costUsd"] == round((1000 * 1.0 + 200 * 4.0) / 1e6, 6)
    assert usage["latencyMs"] >= 0
    assert len(provider.calls) == 1


def test_document_is_sent_as_image_parts_never_inside_the_instructions() -> None:
    provider = FakeProvider([VALID])
    run(provider, SAMPLE_PDF.read_bytes(), "pdf")
    (call,) = provider.calls
    assert call["system"] == SYSTEM_PROMPT
    assert len(call["images"]) == 1 and call["images"][0].mime == "image/png"
    assert call["images"][0].data.startswith(b"\x89PNG")
    assert "properties" in call["schema"] or "$defs" in call["schema"]


def test_wrong_schema_is_retried_with_the_error_then_succeeds() -> None:
    provider = FakeProvider([bad_invoice(total="1100000"), VALID])
    out = run(provider)
    assert out["invoice"].total == 1100000
    assert len(provider.calls) == 2
    retry_text = provider.calls[1]["user_text"]
    assert "total" in retry_text and "rejected" in retry_text
    # Tokens of the failed attempt are billed too.
    assert out["usage"]["inputTokens"] == 2000


def test_gives_up_after_two_retries_with_a_code() -> None:
    provider = FakeProvider([bad_invoice(total="x")])
    with pytest.raises(ExtractError) as err:
        run(provider)
    assert err.value.code == "EXTRACTION_SCHEMA_INVALID" and err.value.status == 422
    assert len(provider.calls) == 3  # first try + 2 retries, not more


def cut_answer() -> LLMResult:
    """What a long invoice gave at the old cap (invoice-0004, T4.4): JSON stopped mid-value."""
    return LLMResult(
        text=VALID[: len(VALID) // 2],
        model="fake-model",
        input_tokens=2660,
        output_tokens=MAX_OUTPUT_TOKENS,
        truncated=True,
    )


def test_an_answer_cut_at_the_token_cap_fails_at_once_without_a_retry(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # A retry would send the same pages and be cut again: billed for nothing (T4.5b).
    provider = FakeProvider([cut_answer(), VALID])
    with caplog.at_level(logging.DEBUG), pytest.raises(ExtractError) as err:
        run(provider)
    assert (err.value.code, err.value.status) == ("EXTRACTION_SCHEMA_INVALID", 422)
    assert len(provider.calls) == 1
    assert "cut at the token cap" in caplog.text and "after 1 attempts" in caplog.text
    assert VALID[:40] not in caplog.text  # the cut answer itself is never logged


def test_an_unfinished_answer_that_is_not_cut_is_still_retried() -> None:
    not_cut = LLMResult(
        text=VALID[: len(VALID) // 2], model="fake-model", input_tokens=1, output_tokens=1
    )
    assert run(FakeProvider([not_cut, VALID]))["invoice"].total == 1100000


def test_non_json_answer_counts_as_schema_failure() -> None:
    provider = FakeProvider(["Sure! Here is the invoice:", VALID])
    assert run(provider)["invoice"].invoiceNo == "0000001"


def test_validation_feedback_and_logs_never_contain_document_values(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bad = bad_invoice(seller={"name": PII, "taxCode": PII, "address": PII})
    provider = FakeProvider([bad])
    with caplog.at_level(logging.DEBUG), pytest.raises(ExtractError) as err:
        run(provider)
    assert PII not in provider.calls[1]["user_text"]
    assert "seller.taxCode" in provider.calls[1]["user_text"]
    assert PII not in caplog.text and PII not in str(err.value) and PII not in err.value.message


def test_model_answers_fieldmeta_as_a_list_and_the_contract_gets_a_map() -> None:
    from app.services.extract import invoice_json_schema

    fm = invoice_json_schema()["properties"]["fieldMeta"]
    assert fm["type"] == "array" and fm["minItems"] == 1  # `{}` must not be a valid answer
    meta = run(FakeProvider([VALID]))["invoice"].fieldMeta
    assert meta["total"].confidence == 0.95 and meta["invoiceNo"].evidence is None


def test_bad_fieldmeta_entries_are_schema_failures() -> None:
    for bad in (
        [{"confidence": 0.5, "evidence": None}],  # no path
        [{"path": "not.a.field", "confidence": 0.5, "evidence": None}],  # outside the grammar
        [{"path": "total", "confidence": 2, "evidence": None}],
        "total",
        [{"path": "total", "confidence": 0.5, "evidence": None}] * 201,  # runaway list
    ):
        with pytest.raises(ExtractError) as err:
            run(FakeProvider([bad_invoice(fieldMeta=bad)]))
        assert err.value.code == "EXTRACTION_SCHEMA_INVALID"


def test_retry_prompt_never_echoes_words_the_model_chose() -> None:
    word = "TranscribedWord"
    provider = FakeProvider(
        [bad_invoice(fieldMeta=[{"path": word, "confidence": 5, "evidence": None}])]
    )
    with pytest.raises(ExtractError):
        run(provider)
    assert word not in provider.calls[1]["user_text"]
    assert "fieldMeta" in provider.calls[1]["user_text"]  # contract field names are fine


def test_slow_provider_gets_no_retry_that_would_exceed_the_total_budget() -> None:
    slow = FakeProvider([bad_invoice(total="x")])
    slow.timeout_s = extract_module.TOTAL_BUDGET_S + 1  # one more attempt cannot fit
    with pytest.raises(ExtractError) as err:
        run(slow)
    assert err.value.code == "EXTRACTION_SCHEMA_INVALID" and len(slow.calls) == 1
    quick = FakeProvider([bad_invoice(total="x")])
    quick.timeout_s = 5.0  # fits: all 3 attempts happen
    with pytest.raises(ExtractError):
        run(quick)
    assert len(quick.calls) == 3


def test_rendered_pages_over_the_size_cap_are_refused_before_any_provider_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(extract_module, "MAX_TOTAL_IMAGE_BYTES", 100)

    def forbidden():
        raise AssertionError("provider must not be built")

    with pytest.raises(ExtractError) as err:
        extract(SAMPLE_PDF.read_bytes(), "pdf", forbidden)
    assert (err.value.status, err.value.code) == (422, "PDF_TOO_LARGE")


def test_extra_fields_from_the_model_are_rejected() -> None:
    provider = FakeProvider([bad_invoice(isAdmin=True)])
    with pytest.raises(ExtractError) as err:
        run(provider)
    assert err.value.code == "EXTRACTION_SCHEMA_INVALID"


@pytest.mark.parametrize("code", ["LLM_RATE_LIMITED", "LLM_UNAVAILABLE"])
def test_transient_provider_error_surfaces_as_503_without_retrying_here(code: str) -> None:
    provider = FakeProvider([LLMUnavailable(code)])
    with pytest.raises(ExtractError) as err:
        run(provider)
    assert (err.value.status, err.value.code) == (503, code)
    assert len(provider.calls) == 1  # BullMQ retries the whole job, not this loop


def test_provider_that_fails_twice_then_answers_works_through_the_worker_contract() -> None:
    # The service itself does not retry transport errors: the caller sees 503, then 200.
    provider = FakeProvider([LLMUnavailable(), LLMUnavailable(), VALID])
    for _ in range(2):
        with pytest.raises(ExtractError) as err:
            run(provider)
        assert err.value.status == 503
    assert run(provider)["invoice"].total == 1100000


def test_xml_still_uses_the_parser_and_never_builds_a_provider() -> None:
    sample = Path(__file__).parent / "fixtures" / "xml_invoices" / "invoice-00.xml"

    def forbidden():
        raise AssertionError("provider must not be built for xml")

    out = extract(sample.read_bytes(), "xml", forbidden)
    assert out["usage"] is None


def test_bad_files_are_answered_without_building_a_provider() -> None:
    def forbidden():
        raise AssertionError("provider must not be built for a bad file")

    for data, source, code in [
        (b"%PDF-1.4\nbroken", "pdf", "PDF_INVALID"),
        (b"GIF89a", "image", "IMAGE_UNSUPPORTED"),
    ]:
        with pytest.raises(ExtractError) as err:
            extract(data, source, forbidden)
        assert (err.value.status, err.value.code) == (422, code)


def test_missing_key_is_a_503_not_a_crash() -> None:
    settings = Settings(_env_file=None, ai_service_token="x" * 20, llm_provider="gemini")
    with pytest.raises(LLMError) as err:
        build_provider(settings)
    assert (err.value.code, err.value.status) == ("LLM_NOT_CONFIGURED", 503)


# --- HTTP level -------------------------------------------------------------------------------

client = TestClient(app, headers={"Authorization": f"Bearer {os.environ['AI_SERVICE_TOKEN']}"})


@pytest.fixture
def use_provider(monkeypatch: pytest.MonkeyPatch):
    def install(provider: FakeProvider | None) -> None:
        monkeypatch.setattr(app.state, "llm_provider", provider, raising=False)

    return install


def post(data: bytes, source_type: str):
    return client.post("/extract", files={"file": ("f", data)}, data={"sourceType": source_type})


def test_endpoint_pdf_roundtrip(use_provider) -> None:
    use_provider(FakeProvider([VALID]))
    res = post(SAMPLE_PDF.read_bytes(), "pdf")
    assert res.status_code == 200
    body = res.json()
    assert body["invoice"]["total"] == 1100000
    assert set(body["usage"]) == {
        "model",
        "promptVersion",
        "inputTokens",
        "outputTokens",
        "latencyMs",
        "costUsd",
    }


def test_endpoint_maps_errors_to_status_and_code(use_provider) -> None:
    use_provider(FakeProvider([LLMUnavailable("LLM_RATE_LIMITED")]))
    res = post(PNG, "image")
    assert (res.status_code, res.json()["code"]) == (503, "LLM_RATE_LIMITED")
    use_provider(FakeProvider([bad_invoice(total="x")]))
    res = post(PNG, "image")
    assert (res.status_code, res.json()["code"]) == (422, "EXTRACTION_SCHEMA_INVALID")


def test_endpoint_caps_the_upload_size(use_provider) -> None:
    use_provider(FakeProvider([VALID]))
    res = post(b"\x89PNG\r\n\x1a\n" + b"0" * (10 * 1024 * 1024), "image")
    assert (res.status_code, res.json()["code"]) == (413, "FILE_TOO_LARGE")


def test_endpoint_without_provider_config_is_503(monkeypatch: pytest.MonkeyPatch) -> None:
    token = os.environ["AI_SERVICE_TOKEN"]  # the route still checks the real service token
    settings = Settings(_env_file=None, ai_service_token=token, llm_provider="gemini")
    monkeypatch.setattr(app.state, "settings", settings)
    monkeypatch.setattr(app.state, "llm_provider", None, raising=False)
    res = post(PNG, "image")
    assert (res.status_code, res.json()["code"]) == (503, "LLM_NOT_CONFIGURED")
