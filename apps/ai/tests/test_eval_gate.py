"""T4.5: the regression gate on `smoke` (ADR 0020). Fake provider only; no real model is called."""

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from runner import gate, report
from runner.dataset import Dataset, load
from runner.matching import CRITICAL_FIELDS
from runner.run import read_records

from app.providers.base import LLMError, LLMUnavailable
from app.providers.fake import FakeProvider
from tests.test_eval_runner import FAST, PDF_DOC, PNG_DOC, make_dataset, model_answer, run

COMMITTED = gate.read_baseline()
REPORT = gate.REPO / COMMITTED["source"]


def split_with(correct: dict[str, int] | None = None, f1: float = 1.0) -> dict[str, Any]:
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
            "lines": {"f1": f1},
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


# ------------------------------------------------------------- tolerance (ADR 0020)


def test_the_same_level_passes() -> None:
    assert verdict(split_with({"seller.taxCode": 19})) == gate.PASS


def test_one_document_down_is_within_the_tolerance() -> None:
    # 100% -> 95%: exactly one document (5 points), not "more than" it.
    assert verdict(split_with({"invoiceNo": 19})) == gate.PASS


def test_two_documents_down_fail() -> None:
    assert verdict(split_with({"invoiceNo": 18})) == gate.DROPPED


def test_the_noisy_field_is_judged_from_its_own_baseline() -> None:
    # seller.taxCode baseline 56/60 = 93.3%, tolerance max(noise 5, one document 5) = 5 points.
    assert verdict(split_with({"seller.taxCode": 18})) == gate.PASS  # 90%: -3.3
    assert verdict(split_with({"seller.taxCode": 17})) == gate.DROPPED  # 85%: -8.3


def test_a_larger_noise_widens_the_tolerance() -> None:
    noisy = copy.deepcopy(COMMITTED)
    noisy["metrics"]["invoiceNo"]["noisePoints"] = 10.0
    assert verdict(split_with({"invoiceNo": 18}), noisy) == gate.PASS
    assert verdict(split_with({"invoiceNo": 17}), noisy) == gate.DROPPED


def test_line_f1_is_gated_too() -> None:
    assert verdict(split_with(f1=0.95)) == gate.PASS
    assert verdict(split_with(f1=0.9499)) == gate.DROPPED


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
