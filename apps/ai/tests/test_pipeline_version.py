"""T6.3: GET /extract/version, what the API's extraction result cache is keyed by."""

import os
import shutil
from pathlib import Path

from fastapi.testclient import TestClient
from runner import gate

from app.config import Settings
from app.main import create_app
from app.services import pipeline_version as pv
from app.services.extract import PROMPT_VERSION

AUTH = {"Authorization": f"Bearer {os.environ['AI_SERVICE_TOKEN']}"}


def copy_pipeline(to: Path) -> None:
    for name in pv.PIPELINE_FILES:
        (to / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(pv.APP_DIR / name, to / name)


def test_the_list_is_the_eval_gate_list() -> None:
    # Whatever the eval gate counts as changing accuracy must also miss the result cache.
    assert tuple(f"apps/ai/app/{name}" for name in pv.PIPELINE_FILES) == gate.PIPELINE_FILES


def test_changing_any_pipeline_file_changes_the_version(tmp_path: Path) -> None:
    copy_pipeline(tmp_path)
    before = pv.pipeline_hash(tmp_path)
    assert before == pv.pipeline_hash(pv.APP_DIR)
    for name in pv.PIPELINE_FILES:
        path = tmp_path / name
        original = path.read_bytes()
        path.write_bytes(original + b"\n# changed\n")
        assert pv.pipeline_hash(tmp_path) != before, name
        path.write_bytes(original)
    assert pv.pipeline_hash(tmp_path) == before


def test_the_model_is_the_one_usage_will_report() -> None:
    fake = Settings(_env_file=None, llm_provider="fake", llm_model="ignored-by-fake")
    assert pv.configured_model(fake) == "fake-model"
    gemini = Settings(_env_file=None, llm_provider="gemini", llm_model="gemini-x")
    assert pv.configured_model(gemini) == "gemini-x"


def test_the_endpoint_answers_the_three_parts() -> None:
    res = TestClient(create_app()).get("/extract/version", headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"model", "promptVersion", "pipelineVersion"}
    assert body["promptVersion"] == PROMPT_VERSION
    assert body["pipelineVersion"] == pv.pipeline_hash()


def test_the_endpoint_needs_the_service_token() -> None:
    res = TestClient(create_app()).get("/extract/version")
    assert res.status_code == 401
    assert res.json()["code"] == "SERVICE_UNAUTHORIZED"


def test_a_new_render_library_version_changes_the_version(tmp_path: Path) -> None:
    copy_pipeline(tmp_path)
    one = pv.pipeline_hash(tmp_path, {"pypdfium2": "5.14.0"})
    assert one == pv.pipeline_hash(tmp_path, {"pypdfium2": "5.14.0"})
    assert one != pv.pipeline_hash(tmp_path, {"pypdfium2": "5.15.0"})
    assert pv.RENDER_LIBRARIES == ("pypdfium2",)
