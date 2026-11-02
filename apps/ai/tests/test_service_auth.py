import os
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app

SAMPLE = Path(__file__).parent / "fixtures" / "xml_invoices" / "invoice-00.xml"
TOKEN = os.environ["AI_SERVICE_TOKEN"]
TRACE = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
client = TestClient(app)


def extract(headers: dict[str, str | bytes]):
    return client.post(
        "/extract",
        files={"file": ("f.xml", SAMPLE.read_bytes())},
        data={"sourceType": "xml"},
        headers=headers,
    )


def test_missing_token_is_refused() -> None:
    res = extract({})
    assert res.status_code == 401
    assert res.json()["code"] == "SERVICE_UNAUTHORIZED"


def test_wrong_token_is_refused_without_echoing_it() -> None:
    res = extract({"Authorization": "Bearer not-the-right-token-at-all"})
    assert res.status_code == 401
    assert "not-the-right-token" not in res.text and TOKEN not in res.text


def test_wrong_scheme_and_non_ascii_token_are_refused() -> None:
    assert extract({"Authorization": f"Basic {TOKEN}"}).status_code == 401
    assert extract({"Authorization": "Bearer tökén".encode()}).status_code == 401


def test_correct_token_is_accepted() -> None:
    assert extract({"Authorization": f"Bearer {TOKEN}"}).status_code == 200


def test_health_stays_open() -> None:
    assert client.get("/health").status_code == 200


def test_valid_traceparent_is_echoed_and_invalid_is_dropped() -> None:
    assert client.get("/health", headers={"traceparent": TRACE}).headers["traceparent"] == TRACE
    bad = client.get("/health", headers={"traceparent": "garbage"})
    assert "traceparent" not in bad.headers
