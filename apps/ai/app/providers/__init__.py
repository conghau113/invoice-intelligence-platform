from app.config import Settings
from app.providers.base import LLMProvider, LLMUnavailable
from app.providers.fake import FakeProvider
from app.providers.gemini import GeminiProvider
from app.providers.openai_compat import OpenAICompatProvider


def build_provider(settings: Settings) -> LLMProvider:
    """Pick the adapter named in settings. A missing key is a 503, not a crash at startup:
    the XML path needs no key and must keep working without one."""
    if settings.llm_provider == "fake":
        return FakeProvider()
    if settings.llm_provider == "gemini":
        if settings.gemini_api_key is None:
            raise LLMUnavailable("LLM_NOT_CONFIGURED")
        return GeminiProvider(
            api_key=settings.gemini_api_key.get_secret_value(),
            model=settings.llm_model,
            timeout_s=settings.llm_timeout_s,
        )
    if settings.llm_fallback_api_key is None or settings.llm_fallback_base_url is None:
        raise LLMUnavailable("LLM_NOT_CONFIGURED")
    return OpenAICompatProvider(
        base_url=settings.llm_fallback_base_url,
        api_key=settings.llm_fallback_api_key.get_secret_value(),
        model=settings.llm_model,
        timeout_s=settings.llm_timeout_s,
    )
