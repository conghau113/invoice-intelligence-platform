"""The codes this service answers with must be on the list the worker keeps and the web shows."""

import json
from collections.abc import Callable
from pathlib import Path

import pytest

from app.error_codes import AI_ERROR_CODES
from app.providers.base import LLMError, LLMRejected, LLMUnavailable
from app.routers.extract import _error
from app.services.extract import ExtractError
from app.services.pdf_pages import PdfError
from app.services.xml_invoice import XmlInvoiceError

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "contracts"
    / "fixtures"
    / "failure-codes.json"
)


def test_every_code_is_on_the_list_in_contracts() -> None:
    listed = set(json.loads(FIXTURE.read_text(encoding="utf-8")))
    assert AI_ERROR_CODES - listed == set()


@pytest.mark.parametrize(
    "make",
    [
        lambda code: LLMError(code, 503),
        LLMUnavailable,
        LLMRejected,
        lambda code: ExtractError(422, code, "x"),
        PdfError,
        lambda code: XmlInvoiceError(code, "x"),
        lambda code: _error(422, code, "x"),
    ],
    ids=["LLMError", "LLMUnavailable", "LLMRejected", "ExtractError", "PdfError", "Xml", "router"],
)
def test_no_way_out_of_the_service_accepts_an_unregistered_code(
    make: Callable[[str], object],
) -> None:
    with pytest.raises(ValueError, match="Unregistered"):
        make("SOMETHING_NEW")
    make("LLM_UNAVAILABLE")  # a registered code is fine: the refusal above is about the code
