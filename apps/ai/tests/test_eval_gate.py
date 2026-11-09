"""T4.5: the regression gate on `smoke` (ADR 0020). Fake provider only; no real model is called."""

import copy
import fnmatch
import json
import math
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
import yaml  # MIT; installed through datamodel-code-generator (dev). Missing => ImportError
from runner import __main__ as cli
from runner import gate, report
from runner.dataset import Dataset, load
from runner.matching import CRITICAL_FIELDS
from runner.run import read_records

from app.config import Settings
from app.providers.base import LLMError, LLMUnavailable
from app.providers.fake import FakeProvider
from tests.test_eval_runner import FAST, PDF_DOC, PNG_DOC, make_dataset, model_answer, run

COMMITTED = gate.read_baseline()
REPORT = gate.REPO / COMMITTED["source"]


def split_with(
    correct: dict[str, int] | None = None, f1: float = 1.0, micro: float = 1.0
) -> dict[str, Any]:
    """A `smoke` split of one run of 20 documents: every field right unless `correct` says not."""
    counts = {f: 20 for f in CRITICAL_FIELDS} | (correct or {})
    return {
        "complete": True,
        "documentsPerRepeat": 20,
        "overall": {
            "fields": {
                f: {"correct": n, "total": 20, "accuracy": round(n / 20, 4)}
                for f, n in counts.items()
            },
            "lines": {"f1": micro, "macroF1": f1},
        },
        "failures": {},
        "wrong": [],
    }


def verdict(split: dict[str, Any], baseline: dict[str, Any] = COMMITTED) -> int:
    code, _rows = gate.judge(split, baseline["config"], baseline)
    return code


# ------------------------------------------------------------- the committed baseline


def test_the_committed_baseline_is_what_its_report_gives() -> None:
    built = json.loads(REPORT.read_text(encoding="utf-8"))
    fresh = gate.build_baseline(built, COMMITTED["source"])
    # Pipeline hashes describe the code at the time the baseline was written, not today's code.
    assert {k: v for k, v in fresh.items() if k != "pipeline"} == {
        k: v for k, v in COMMITTED.items() if k != "pipeline"
    }
    assert set(COMMITTED["pipeline"]) == set(gate.PIPELINE_FILES)


def test_the_baseline_is_measured_on_the_frozen_set() -> None:
    assert COMMITTED["config"]["manifestSha256"] == load().manifest_sha256
    assert COMMITTED["documents"] == len(load().splits["smoke"])


def test_an_incomplete_or_single_run_report_cannot_be_a_baseline() -> None:
    built = json.loads(REPORT.read_text(encoding="utf-8"))
    one_run = copy.deepcopy(built)
    one_run["splits"]["smoke"]["noise"] = None
    with pytest.raises(gate.GateError):
        gate.build_baseline(one_run, "x")
    stopped = copy.deepcopy(built)
    stopped["splits"]["smoke"]["complete"] = False
    with pytest.raises(gate.GateError):
        gate.build_baseline(stopped, "x")


def test_the_line_noise_is_measured_on_macro_f1() -> None:
    built = json.loads(REPORT.read_text(encoding="utf-8"))
    repeats = built["splits"]["smoke"]["perRepeat"]
    for value, repeat in zip((1.0, 0.9, 0.95), repeats, strict=True):
        repeat["lines"]["macroF1"] = value
    baseline = gate.build_baseline(built, "x")
    assert baseline["metrics"]["lines.macroF1"]["noisePoints"] == 10.0


# ------------------------------------------------------------- tolerance (ADR 0020)


def test_the_same_level_passes() -> None:
    assert verdict(split_with({"seller.taxCode": 19})) == gate.PASS


def test_one_document_down_is_within_the_tolerance() -> None:
    # 100% -> 95%: exactly one document (5 points), not "more than" it.
    assert verdict(split_with({"invoiceNo": 19})) == gate.PASS


def test_two_documents_down_fail() -> None:
    assert verdict(split_with({"invoiceNo": 18})) == gate.DROPPED


def test_the_weakest_field_is_judged_from_its_own_baseline() -> None:
    # Read from the committed baseline, so an intended re-baseline does not break this test:
    # 2026-11-08 56/60 with noise 5; 2026-11-09 (T4.5b) 54/60 with noise 0. Tolerance is
    # max(noise, one document = 5 points); "drops by more than" means the boundary passes.
    field = COMMITTED["metrics"]["seller.taxCode"]
    assert field["correct"] < field["total"]  # below 100%: the other fields' baseline would not do
    floor = Fraction(field["correct"], field["total"]) - Fraction(
        max(Fraction(field["noisePoints"]), Fraction(5)), 100
    )
    lowest = math.ceil(floor * 20)  # fewest right of 20 that is still within the tolerance
    assert verdict(split_with({"seller.taxCode": lowest})) == gate.PASS
    assert verdict(split_with({"seller.taxCode": lowest - 1})) == gate.DROPPED


def test_a_larger_noise_widens_the_tolerance() -> None:
    noisy = copy.deepcopy(COMMITTED)
    noisy["metrics"]["invoiceNo"]["noisePoints"] = 10.0
    assert verdict(split_with({"invoiceNo": 18}), noisy) == gate.PASS
    assert verdict(split_with({"invoiceNo": 17}), noisy) == gate.DROPPED


def test_line_f1_is_gated_too() -> None:
    assert verdict(split_with(f1=0.95)) == gate.PASS
    assert verdict(split_with(f1=0.9499)) == gate.DROPPED


def test_one_failed_long_invoice_is_one_document_not_a_third_of_the_lines() -> None:
    # Eval run 42595431218: invoice-0004 (54 of 161 lines) was cut at the output-token cap.
    # Micro F1 fell to 0.798, macro F1 to 0.95: one document, within the tolerance.
    assert verdict(split_with({"invoiceNo": 19}, f1=0.95, micro=0.798)) == gate.PASS


def test_a_better_run_passes() -> None:
    lower = copy.deepcopy(COMMITTED)
    lower["metrics"]["total"] |= {"correct": 30, "accuracy": 0.5}
    assert verdict(split_with(), lower) == gate.PASS


def test_an_incomplete_run_is_not_judged_even_if_its_scores_look_fine() -> None:
    split = split_with() | {"complete": False}
    assert verdict(split) == gate.NOT_JUDGED


def test_another_dataset_is_refused() -> None:
    other = copy.deepcopy(COMMITTED)
    other["config"]["manifestSha256"] = "0" * 64
    with pytest.raises(gate.GateError):
        gate.judge(split_with(), COMMITTED["config"], other)


def test_the_summary_names_the_metric_that_dropped_and_holds_no_value() -> None:
    split = split_with({"total": 17})
    split["wrong"] = [{"doc": "invoice-0001", "fields": ["total"]}]
    code, rows = gate.judge(split, COMMITTED["config"], COMMITTED)
    text = gate.to_markdown(code, rows, COMMITTED["config"], COMMITTED, split)
    assert text.startswith("## Eval gate, `smoke`: FAIL")
    assert "| total | 100.0% | 85.0% | -15.0 | 5.0 | DROPPED |" in text
    assert "- invoice-0001: total" in text


# ------------------------------------------------------------- the whole gate, fake provider


@pytest.fixture
def small(tmp_path: Path) -> Dataset:
    root, pin = make_dataset(tmp_path / "v1", [PDF_DOC, PNG_DOC])
    return load(root, pin)


def small_baseline(small: Dataset, tmp_path: Path) -> dict[str, Any]:
    """A baseline measured on the small set: two perfect repeats."""
    script = [model_answer(small.expected(i)) for i in small.splits["smoke"]] * 2
    results = tmp_path / "baseline.jsonl"
    assert run(small, FakeProvider(script=script, model="gemini-3.5-flash-lite"), results, 2)
    return gate.build_baseline(report.build(read_records(results), small), "test")


def run_small(small: Dataset, script: list[str | LLMError], results: Path, base: dict[str, Any]):
    return gate.run_gate(
        small,
        FakeProvider(script=script, model="gemini-3.5-flash-lite"),
        results,
        base,
        rpm=FAST,
        max_calls=20,
        retry_wait_s=0,
        say=lambda _line: None,
    )


def wrong_series(expected: dict[str, Any]) -> str:
    """What a bad prompt gives: a valid invoice whose series is not the printed one."""
    return model_answer(expected | {"series": expected["series"] + "X"})


def test_the_gate_passes_a_run_as_good_as_its_baseline(small: Dataset, tmp_path: Path) -> None:
    base = small_baseline(small, tmp_path)
    script = [model_answer(small.expected(i)) for i in small.splits["smoke"]]
    code, text = run_small(small, script, tmp_path / "gate.jsonl", base)
    assert code == gate.PASS, text


def test_the_gate_fails_a_worse_prompt(small: Dataset, tmp_path: Path) -> None:
    base = small_baseline(small, tmp_path)
    script = [wrong_series(small.expected(i)) for i in small.splits["smoke"]]
    code, text = run_small(small, script, tmp_path / "gate.jsonl", base)
    assert code == gate.DROPPED
    assert "| series | 100.0% | 0.0% | -100.0 | 50.0 | DROPPED |" in text


def test_the_gate_measures_afresh_instead_of_resuming(small: Dataset, tmp_path: Path) -> None:
    base = small_baseline(small, tmp_path)
    results = tmp_path / "gate.jsonl"
    good = [model_answer(small.expected(i)) for i in small.splits["smoke"]]
    assert run_small(small, good, results, base)[0] == gate.PASS
    bad = [wrong_series(small.expected(i)) for i in small.splits["smoke"]]
    assert run_small(small, bad, results, base)[0] == gate.DROPPED


def test_a_provider_that_stays_down_is_not_judged(small: Dataset, tmp_path: Path) -> None:
    base = small_baseline(small, tmp_path)
    code, text = run_small(small, [LLMUnavailable()], tmp_path / "gate.jsonl", base)
    assert code == gate.NOT_JUDGED
    assert "NOT JUDGED" in text


def test_a_quota_stop_before_the_first_answer_is_not_judged(small: Dataset, tmp_path: Path) -> None:
    base = small_baseline(small, tmp_path)
    code, text = run_small(small, [LLMUnavailable("LLM_RATE_LIMITED")], tmp_path / "g.jsonl", base)
    assert code == gate.NOT_JUDGED
    assert "NOT JUDGED" in text


def test_a_call_cap_reached_halfway_is_not_judged(small: Dataset, tmp_path: Path) -> None:
    base = small_baseline(small, tmp_path)
    good = [model_answer(small.expected(i)) for i in small.splits["smoke"]]
    code, _text = gate.run_gate(
        small,
        FakeProvider(script=good, model="gemini-3.5-flash-lite"),
        tmp_path / "g.jsonl",
        base,
        rpm=FAST,
        max_calls=1,  # one document answered, the second never asked
        retry_wait_s=0,
        say=lambda _line: None,
    )
    assert code == gate.NOT_JUDGED


def test_a_baseline_from_another_dataset_is_not_judged_end_to_end(
    small: Dataset, tmp_path: Path
) -> None:
    base = small_baseline(small, tmp_path)
    base["config"]["manifestSha256"] = "0" * 64
    good = [model_answer(small.expected(i)) for i in small.splits["smoke"]]
    code, text = run_small(small, good, tmp_path / "g.jsonl", base)
    assert code == gate.NOT_JUDGED
    assert "| Metric |" not in text  # nothing compared


def test_the_summary_warns_about_another_model_and_changed_pipeline_files() -> None:
    other = copy.deepcopy(COMMITTED)
    other["pipeline"]["apps/ai/app/services/extract.py"] = "0" * 64
    now = COMMITTED["config"] | {"model": "gemini-3.1-flash-lite"}
    code, rows = gate.judge(split_with(), now, other)
    text = gate.to_markdown(code, rows, now, other, split_with())
    assert "Model differs from the baseline" in text
    assert "changed since the baseline: apps/ai/app/services/extract.py" in text
    same = gate.to_markdown(code, rows, COMMITTED["config"], COMMITTED, split_with())
    assert "Model differs" not in same
    assert "changed since the baseline: none" in same


@pytest.mark.parametrize(("script_of", "expected"), [("good", 0), ("bad", 1), ("down", 2)])
def test_the_cli_exit_code_is_the_verdict(
    small: Dataset,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    script_of: str,
    expected: int,
) -> None:
    base = small_baseline(small, tmp_path)
    scripts: dict[str, list[str | LLMError]] = {
        "good": [model_answer(small.expected(i)) for i in small.splits["smoke"]],
        "bad": [wrong_series(small.expected(i)) for i in small.splits["smoke"]],
        "down": [LLMUnavailable("LLM_RATE_LIMITED")],
    }
    fake = FakeProvider(script=scripts[script_of], model="gemini-3.5-flash-lite")
    monkeypatch.setattr(
        cli,
        "settings",
        lambda: Settings(
            ai_service_token="t" * 16, llm_provider="gemini", llm_model="gemini-3.5-flash-lite"
        ),
    )
    monkeypatch.setattr(cli, "build_provider", lambda _config: fake)
    monkeypatch.setattr(cli, "load", lambda: small)
    monkeypatch.setattr(cli, "GATE_DIR", tmp_path / "gate")
    monkeypatch.setattr(gate, "read_baseline", lambda: base)
    assert cli.main(["gate", "--rpm", "30"]) == expected
    assert (tmp_path / "gate" / "summary.md").is_file()


def test_an_unsafe_model_id_is_refused_before_it_is_printed(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        cli,
        "settings",
        lambda: Settings(
            ai_service_token="t" * 16, llm_provider="gemini", llm_model="x\n::error::forged"
        ),
    )
    with pytest.raises(SystemExit):
        cli.main(["gate"])
    assert "forged" not in capsys.readouterr().out


def test_the_workflow_starts_on_every_pipeline_file() -> None:
    """eval.yml `paths` and PIPELINE_FILES are kept in step by hand: a pipeline file the workflow
    does not watch would change scores without starting the gate."""
    workflow = yaml.safe_load((gate.REPO / ".github/workflows/eval.yml").read_text("utf-8"))
    # PyYAML reads the key `on` as the boolean True (YAML 1.1).
    patterns = workflow[True]["pull_request"]["paths"]
    for name in gate.PIPELINE_FILES:
        assert any(fnmatch.fnmatch(name, p) for p in patterns), name
    for watched in ("eval/baselines/smoke.json", "eval/runner/gate.py", "apps/ai/app/config.py"):
        assert any(fnmatch.fnmatch(watched, p) for p in patterns), watched
