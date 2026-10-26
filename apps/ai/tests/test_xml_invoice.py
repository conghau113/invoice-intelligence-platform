import importlib.util
import json
import random
import time
from pathlib import Path
from typing import Any

import pytest

from app.services.xml_invoice import MAX_XML_BYTES, XmlInvoiceError, leaf_paths, parse_xml_invoice

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLES = sorted((FIXTURES / "xml_invoices").glob("invoice-*.xml"))
ATTACKS = sorted((FIXTURES / "xml_attacks").glob("*.xml"))
GENERATOR = Path(__file__).resolve().parents[3] / "tools" / "invoice-gen" / "min_xml.py"


def expected(sample: Path) -> dict[str, Any]:
    return json.loads(sample.with_suffix(".expected.json").read_text(encoding="utf-8"))


def parse_error(data: bytes) -> XmlInvoiceError:
    with pytest.raises(XmlInvoiceError) as info:
        parse_xml_invoice(data)
    return info.value


def test_there_are_ten_samples() -> None:
    assert len(SAMPLES) == 10


@pytest.mark.parametrize("sample", SAMPLES, ids=lambda p: p.name)
def test_sample_parses_to_the_ground_truth(sample: Path) -> None:
    invoice = parse_xml_invoice(sample.read_bytes())
    assert {k: v for k, v in invoice.items() if k != "fieldMeta"} == expected(sample)


@pytest.mark.parametrize("sample", SAMPLES, ids=lambda p: p.name)
def test_every_field_has_certain_meta_without_evidence(sample: Path) -> None:
    invoice = parse_xml_invoice(sample.read_bytes())
    assert set(invoice["fieldMeta"]) == set(leaf_paths(invoice))
    assert all(m == {"confidence": 1.0, "evidence": None} for m in invoice["fieldMeta"].values())


def test_samples_cover_usd_and_buyer_without_tax_code() -> None:
    parsed = [parse_xml_invoice(s.read_bytes()) for s in SAMPLES]
    assert any(i["currency"] == "USD" for i in parsed)
    assert any(i["buyer"]["taxCode"] is None for i in parsed)
    assert any(len(i["vatBreakdown"]) > 1 for i in parsed)


def test_committed_samples_are_what_the_generator_produces() -> None:
    spec = importlib.util.spec_from_file_location("min_xml", GENERATOR)
    assert spec is not None
    assert spec.loader is not None
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    rng = random.Random(42)
    for i in range(10):
        inv = gen.make_invoice(rng, i)
        assert (FIXTURES / "xml_invoices" / f"invoice-{i:02d}.xml").read_bytes() == gen.render_xml(
            inv
        )


@pytest.mark.parametrize("attack", ATTACKS, ids=lambda p: p.name)
def test_xxe_and_entity_bombs_are_refused_quickly(attack: Path) -> None:
    started = time.monotonic()
    err = parse_error(attack.read_bytes())
    assert err.code == "XML_FORBIDDEN_CONSTRUCT"
    assert time.monotonic() - started < 1


def sample_text() -> str:
    return SAMPLES[0].read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("code", "mutate"),
    [
        ("XML_MALFORMED", lambda s: s.replace("</HDon>", "")),
        ("XML_MALFORMED", lambda s: ""),
        ("XML_UNSUPPORTED_STRUCTURE", lambda s: s.replace("HDon", "Other")),
        ("XML_UNSUPPORTED_STRUCTURE", lambda s: s.replace("<HDon>", '<HDon xmlns="urn:x">')),
        ("XML_MISSING_FIELD", lambda s: s.replace("SHDon", "Missing")),
        ("XML_UNSUPPORTED_CURRENCY", lambda s: s.replace("<DVTTe>VND", "<DVTTe>EUR")),
        ("XML_UNSUPPORTED_VAT_RATE", lambda s: s.replace("<TSuat>", "<TSuat>KCT<x>", 1)),
        ("XML_INVALID_VALUE", lambda s: s.replace("<TgTTTBSo>", "<TgTTTBSo>1.5", 1)),
        ("XML_INVALID_VALUE", lambda s: s.replace("<TgTTTBSo>", "<TgTTTBSo>abc", 1)),
        ("XML_INVALID_VALUE", lambda s: s.replace("<TgTTTBSo>", "<TgTTTBSo>NaN<x>", 1)),
        ("XML_INVALID_VALUE", lambda s: s.replace("<SLuong>", "<SLuong>1E+999<x>", 1)),
        ("XML_INVALID_VALUE", lambda s: s.replace("<TgTTTBSo>", "<TgTTTBSo>1E+999999999<x>", 1)),
        ("XML_INVALID_VALUE", lambda s: s.replace("<TgTTTBSo>", "<TgTTTBSo>１２３<x>", 1)),
        ("XML_INVALID_VALUE", lambda s: s.replace("<TgTTTBSo>", "<TgTTTBSo>1_000<x>", 1)),
        ("XML_MALFORMED", lambda s: s.replace("encoding='UTF-8'", "encoding='x-bogus'")),
        ("XML_INVALID_VALUE", lambda s: s.replace("<NLap>", "<NLap>2026-02-30<x>", 1)),
    ],
)
def test_bad_documents_get_a_stable_code(code: str, mutate: Any) -> None:
    text = mutate(sample_text())
    if "<x>" in text:  # make the injected prefix a complete value instead of a nested element
        text = text.replace("<x>", "-")
    assert parse_error(text.encode()).code == code


def test_element_flood_is_refused_fast() -> None:
    started = time.monotonic()
    assert parse_error(b"<HDon>" + b"<a/>" * 250_000).code == "XML_TOO_COMPLEX"
    assert time.monotonic() - started < 1


def test_oversized_xml_is_refused() -> None:
    assert parse_error(b"<a>" + b" " * MAX_XML_BYTES).code == "FILE_TOO_LARGE"


def test_error_messages_never_echo_document_content() -> None:
    marker = "ZZ-SECRET-MARKER"
    text = sample_text().replace("<NLap>", f"<NLap>{marker}", 1).replace("</NLap>", "-x</NLap>")
    err = parse_error(text.encode())
    assert marker not in err.message
    err = parse_error(f"<{marker}>".encode())
    assert marker not in err.message
