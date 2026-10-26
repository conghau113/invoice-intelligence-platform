import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE = FIXTURES / "xml_invoices" / "invoice-00.xml"
client = TestClient(app)


def post(data: bytes, source_type: str, name: str = "f.xml"):
    return client.post("/extract", files={"file": (name, data)}, data={"sourceType": source_type})


def test_xml_returns_invoice_with_integer_money() -> None:
    res = post(SAMPLE.read_bytes(), "xml")
    assert res.status_code == 200
    body = res.json()
    assert body["warnings"] == []
    assert body["usage"] is None
    assert isinstance(body["invoice"]["total"], int)
    # The raw JSON must not carry "1100000.0": the TS side would accept it, Python would not.
    assert not re.search(r'"(total|subtotal|amount|base|unitPrice)":\s*\d+\.\d', res.text)


@pytest.mark.parametrize("source_type", ["pdf", "image"])
def test_other_sources_are_not_implemented_yet(source_type: str) -> None:
    res = post(b"%PDF-1.7 SAMPLE", source_type, "f.pdf")
    assert res.status_code == 501
    assert res.json()["code"] == "EXTRACTION_PATH_NOT_IMPLEMENTED"


def test_unknown_source_type_is_rejected() -> None:
    assert post(b"x", "docx").status_code == 422


def test_non_xml_bytes_declared_as_xml_get_a_code() -> None:
    res = post(b"%PDF-1.7 not xml", "xml")
    assert res.status_code == 422
    assert res.json()["code"] == "XML_MALFORMED"


def test_xxe_payload_is_refused_and_nothing_leaks() -> None:
    res = post((FIXTURES / "xml_attacks" / "xxe-file.xml").read_bytes(), "xml")
    assert res.status_code == 422
    assert res.json()["code"] == "XML_FORBIDDEN_CONSTRUCT"
    assert "root:" not in res.text


def test_oversized_upload_is_413() -> None:
    res = post(b"<a>" + b" " * (10 * 1024 * 1024), "xml")
    assert res.status_code == 413
    assert res.json()["code"] == "FILE_TOO_LARGE"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda t: t.replace("<SLuong>", "<SLuong>1E+999<x>", 1),
        lambda t: t.replace("<TgTTTBSo>", "<TgTTTBSo>1E+999999999<x>", 1),
        lambda t: t.replace("encoding='UTF-8'", "encoding='x-bogus'"),
    ],
)
def test_poison_files_are_4xx_never_500(mutate) -> None:
    text = mutate(SAMPLE.read_text(encoding="utf-8")).replace("<x>", "-")
    res = post(text.encode(), "xml")
    assert 400 <= res.status_code < 500
    assert res.json()["code"].startswith("XML_")
