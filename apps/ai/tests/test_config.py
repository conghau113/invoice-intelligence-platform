import pytest
from pydantic import ValidationError

from app.config import Settings


def test_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("ENV", "PORT", "LOG_LEVEL"):
        monkeypatch.delenv(name, raising=False)
    settings = Settings(_env_file=None)
    assert settings.port == 8000
    assert settings.env == "development"


def test_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PORT", "9000")
    monkeypatch.setenv("ENV", "test")
    settings = Settings(_env_file=None)
    assert settings.port == 9000
    assert settings.env == "test"


def test_invalid_value_fails_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENV", "staging")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_create_app_fails_fast_on_invalid_config(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings
    from app.main import create_app

    monkeypatch.setenv("ENV", "staging")
    get_settings.cache_clear()
    try:
        with pytest.raises(ValidationError):
            create_app()
    finally:
        get_settings.cache_clear()


def test_missing_or_short_service_token_fails_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AI_SERVICE_TOKEN", raising=False)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)
    monkeypatch.setenv("AI_SERVICE_TOKEN", "short")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_token_is_not_in_repr() -> None:
    assert "test-service-token" not in repr(Settings(_env_file=None))


def test_fake_llm_provider_is_refused_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_SERVICE_TOKEN", "x" * 20)
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("LLM_PROVIDER", "fake")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)
    monkeypatch.setenv("ENV", "test")
    assert Settings(_env_file=None).llm_provider == "fake"


@pytest.mark.parametrize("url", ["http://llm.example/v1", "ftp://x", "llm.example"])
def test_fallback_url_must_be_https(monkeypatch: pytest.MonkeyPatch, url: str) -> None:
    monkeypatch.setenv("AI_SERVICE_TOKEN", "x" * 20)
    monkeypatch.setenv("LLM_FALLBACK_BASE_URL", url)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)
    monkeypatch.setenv("LLM_FALLBACK_BASE_URL", "https://llm.example/v1")
    assert Settings(_env_file=None).llm_fallback_base_url == "https://llm.example/v1"
