"""Every error code this service can answer with.

The worker stores the code in `documents.failure_code` and the web translates it. Both only accept
the list in `packages/contracts/src/error-codes.ts`, so `tests/test_error_codes.py` checks this set
against that list. To add a code, add it here and there, then add its messages in the web.
"""

AI_ERROR_CODES = frozenset(
    {
        "EXTRACTION_SCHEMA_INVALID",
        "FILE_TOO_LARGE",
        "IMAGE_UNSUPPORTED",
        "LLM_BAD_RESPONSE",
        "LLM_MISCONFIGURED",
        "LLM_NOT_CONFIGURED",
        "LLM_NO_CANDIDATE",
        "LLM_RATE_LIMITED",
        "LLM_REQUEST_REJECTED",
        "LLM_TIMEOUT_OR_NETWORK",
        "LLM_UNAVAILABLE",
        "PDF_INVALID",
        "PDF_TOO_LARGE",
        "PDF_TOO_MANY_PAGES",
        "XML_FORBIDDEN_CONSTRUCT",
        "XML_INVALID_VALUE",
        "XML_MALFORMED",
        "XML_MISSING_FIELD",
        "XML_TOO_COMPLEX",
        "XML_UNSUPPORTED_CURRENCY",
        "XML_UNSUPPORTED_STRUCTURE",
        "XML_UNSUPPORTED_VAT_RATE",
    }
)


def registered(code: str) -> str:
    """Returns `code`, or raises: an unknown code must fail in tests, not reach a user."""
    if code not in AI_ERROR_CODES:
        raise ValueError("Unregistered error code")
    return code
