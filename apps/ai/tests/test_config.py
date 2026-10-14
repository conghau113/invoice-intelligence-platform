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
