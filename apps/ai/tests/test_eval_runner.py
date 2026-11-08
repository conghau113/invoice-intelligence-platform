"""Eval runner (T4.3) end to end with a scripted provider: the real pipeline (PDF render, image
cleaning, schema validation), the real hash check and the real report. No network."""

import hashlib
import json
import shutil
import time
from pathlib import Path
from typing import Any

import pytest
from runner import report
from runner.__main__ import main, slug
from runner.dataset import Dataset, DatasetError, load
from runner.provider import Pacer
from runner.run import read_records, run_split

from app.providers.base import LLMError, LLMRejected, LLMUnavailable
from app.providers.fake import FakeProvider

REAL = load()
PDF_DOC = next(i for i in REAL.splits["smoke"] if REAL.documents[i]["variant"] == "pdf-clean")
PNG_DOC = next(i for i in REAL.splits["smoke"] if REAL.documents[i]["variant"] == "png-clean")
FAST = 600_000  # calls a minute: no pacing in tests


def model_answer(expected: dict[str, Any], meta_entries: int | None = None) -> str:
    """What a perfect model would answer: fieldMeta as the list the model schema asks for."""
    entries = [{"path": "total", "confidence": 0.9, "evidence": None}]
    if meta_entries is not None:
        entries = [{"path": "total", "confidence": 0.9, "evidence": None}] * meta_entries
    return json.dumps({**expected, "fieldMeta": entries}, ensure_ascii=False)


def make_dataset(root: Path, ids: list[str]) -> tuple[Path, str]:
    """A small copy of the frozen set with its own manifest; returns (root, manifest hash)."""
    docs = root / "documents"
    docs.mkdir(parents=True)
    entries = []
    for doc_id in ids:
        entry = REAL.documents[doc_id]
        for name in entry["files"]:
            shutil.copyfile(REAL.root / "documents" / name, docs / name)
        entries.append(entry)
    manifest = {"name": "v1", "splits": {"smoke": ids}, "documents": entries}
    raw = json.dumps(manifest).encode()
    (root / "manifest.json").write_bytes(raw)
    return root, hashlib.sha256(raw).hexdigest()


@pytest.fixture
def small(tmp_path: Path) -> Dataset:
    root, pin = make_dataset(tmp_path / "v1", [PDF_DOC, PNG_DOC])
    return load(root, pin)


def answers(dataset: Dataset) -> list[str | LLMError]:
    return [model_answer(dataset.expected(i)) for i in dataset.splits["smoke"]]


def run(dataset: Dataset, provider: FakeProvider, results: Path, repeats: int = 1) -> bool:
    return run_split(
        dataset,
        "smoke",
        repeats,
        provider,
        results,
        rpm=FAST,
        max_calls=100,
        retry_wait_s=0,
        say=lambda _line: None,
    )


def test_the_real_frozen_set_passes_the_hash_check() -> None:
    assert len(REAL.documents) == 125
    assert (
        REAL.manifest_sha256
        == hashlib.sha256((REAL.root / "manifest.json").read_bytes()).hexdigest()
    )


def test_a_changed_byte_fails_the_dataset_check(tmp_path: Path) -> None:
    root, pin = make_dataset(tmp_path / "v1", [PDF_DOC, PNG_DOC])
    with (root / "documents" / REAL.documents[PNG_DOC]["primary"]).open("ab") as f:
        f.write(b"x")
    with pytest.raises(DatasetError) as err:
        load(root, pin)
    assert err.value.code == "HASH_MISMATCH"


def test_a_changed_manifest_is_refused(tmp_path: Path) -> None:
    root, _ = make_dataset(tmp_path / "v1", [PDF_DOC])
    with pytest.raises(DatasetError) as err:
        load(root)  # pinned to the real manifest
    assert err.value.code == "MANIFEST_CHANGED"


def test_a_missing_file_is_refused(tmp_path: Path) -> None:
    root, pin = make_dataset(tmp_path / "v1", [PDF_DOC])
    (root / "documents" / f"{PDF_DOC}.expected.json").unlink()
    with pytest.raises(DatasetError) as err:
        load(root, pin)
    assert err.value.code == "FILE_MISSING"


def test_perfect_answers_give_a_perfect_complete_report(small: Dataset, tmp_path: Path) -> None:
    provider = FakeProvider(script=answers(small) * 2, model="gemini-3.1-flash-lite")
    results = tmp_path / "runs.jsonl"
    assert run(small, provider, results, repeats=2)
    assert len(provider.calls) == 4
    # The picture went through the cleaner, the PDF through the renderer: both arrive as images.
    assert all(c["images"] for c in provider.calls)
    built = report.build(read_records(results), small)
    smoke = built["splits"]["smoke"]
    assert smoke["complete"]
    assert smoke["overall"]["documentExact"] == {"correct": 4, "total": 4, "accuracy": 1.0}
    assert smoke["overall"]["lines"]["f1"] == 1.0
    assert smoke["noise"] == dict.fromkeys(smoke["noise"], 0.0)
    assert smoke["wrong"] == []
    assert smoke["usage"]["inputTokens"] == 4000  # FakeProvider bills 1000 a call


def test_a_rate_limit_stops_the_run_and_the_next_run_finishes_it(
    small: Dataset, tmp_path: Path
) -> None:
    first, second = answers(small)
    results = tmp_path / "runs.jsonl"
    limited = FakeProvider(script=[first, LLMUnavailable("LLM_RATE_LIMITED")])
    assert not run(small, limited, results)
    assert [r["doc"] for r in read_records(results)] == [PDF_DOC]
    again = FakeProvider(script=[second])
    assert run(small, again, results)
    assert len(again.calls) == 1  # the finished document is not called again
    assert [r["doc"] for r in read_records(results)] == [PDF_DOC, PNG_DOC]


def test_temporary_errors_are_retried_then_recorded(small: Dataset, tmp_path: Path) -> None:
    first, second = answers(small)
    flaky = FakeProvider(script=[LLMUnavailable(), LLMUnavailable(), first, second])
    results = tmp_path / "runs.jsonl"
    assert run(small, flaky, results)
    record = read_records(results)[0]
    assert record["status"] == "ok" and record["attempts"] == 3 and record["calls"] == 3


def test_tokens_of_an_attempt_that_later_failed_are_still_counted(
    small: Dataset, tmp_path: Path
) -> None:
    first, second = answers(small)
    # Attempt 1: an answer the schema rejects (billed), then a 503 on its retry. Attempt 2: right.
    provider = FakeProvider(script=["not json", LLMUnavailable(), first, second])
    results = tmp_path / "runs.jsonl"
    assert run(small, provider, results)
    record = read_records(results)[0]
    assert record["status"] == "ok" and record["attempts"] == 2
    assert record["calls"] == 3 and record["inputTokens"] == 2000


def test_a_document_that_never_answers_is_an_error_and_the_run_is_incomplete(
    small: Dataset, tmp_path: Path
) -> None:
    results = tmp_path / "runs.jsonl"
    assert not run(small, FakeProvider(script=[LLMUnavailable()]), results)
    records = read_records(results)
    assert [r["status"] for r in records] == ["error", "error"]
    smoke = report.build(records, small)["splits"]["smoke"]
    assert not smoke["complete"]
    assert smoke["overall"]["fields"]["total"]["accuracy"] == 0.0  # counted, not skipped
    # An error is not final: the next run tries it again.
    assert run(small, FakeProvider(script=answers(small)), results)


def test_too_many_field_meta_entries_is_told_apart_and_its_tokens_are_counted(
    small: Dataset, tmp_path: Path
) -> None:
    too_long = model_answer(small.expected(PDF_DOC), meta_entries=201)
    provider = FakeProvider(script=[too_long, too_long, too_long, answers(small)[1]])
    results = tmp_path / "runs.jsonl"
    assert run(small, provider, results)
    record = read_records(results)[0]
    assert record["status"] == "rejected"
    assert record["code"] == "EXTRACTION_SCHEMA_INVALID"
    assert record["reason"] == "FIELD_META_TOO_MANY"
    assert record["maxFieldMeta"] == 201
    assert record["calls"] == 3 and record["inputTokens"] == 3000  # extract drops these
    failures = report.build(read_records(results), small)["splits"]["smoke"]["failures"]
    assert failures == {"rejected:FIELD_META_TOO_MANY": 1}


def test_runs_of_another_prompt_are_not_mixed_into_the_same_file(
    small: Dataset, tmp_path: Path
) -> None:
    results = tmp_path / "runs.jsonl"
    assert run(small, FakeProvider(script=answers(small)), results)
    lines = [json.loads(line) for line in results.read_text().splitlines()]
    lines[0]["promptSha256"] = "f" * 64
    results.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
    with pytest.raises(SystemExit):
        run(small, FakeProvider(script=answers(small)), results)


def test_pacing_waits_for_the_gap_and_counts_it() -> None:
    now = [0.0]
    slept: list[float] = []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        now[0] += seconds

    pacer = Pacer(10, clock=lambda: now[0], sleep=sleep)
    pacer.wait()
    pacer.started()
    now[0] += 2.0
    pacer.wait()
    assert slept == [4.0] and pacer.slept_s == 4.0
    pacer.started()
    now[0] += 7.0
    pacer.wait()
    assert slept == [4.0]


def test_the_cli_refuses_the_fake_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "fake")
    with pytest.raises(SystemExit) as err:
        main(["report"])
    assert "fake" in str(err.value)


def test_the_cli_takes_no_path_and_the_file_name_is_checked() -> None:
    with pytest.raises(SystemExit):
        main(["run", "../../etc"])
    assert slug("v1", "gemini-3.1-flash-lite") == "v1-gemini-3.1-flash-lite-invoice_extraction-v1"
    with pytest.raises(SystemExit):
        slug("v1", "../escape")


@pytest.mark.parametrize("bad", ["../x", "a//b", "a/b/c", "a:b:c", "/abs", "a/../b", "A/b"])
def test_an_owner_and_a_variant_are_allowed_in_a_model_id_but_nothing_else(bad: str) -> None:
    """OpenRouter ids carry both (T4.4); every other slash or colon is still refused."""
    name = slug("v1", "nvidia/nemotron-3.5-super-vl:free")
    assert name == "v1-nvidia-nemotron-3.5-super-vl-free-invoice_extraction-v1"
    with pytest.raises(SystemExit):
        slug("v1", bad)


def test_a_provider_refusal_is_not_recorded_as_a_final_wrong_document(
    small: Dataset, tmp_path: Path
) -> None:
    """A 400 from Gemini says nothing about the file; it may pass. It must not enter the baseline
    as a document that is wrong on every field and is never tried again."""
    results = tmp_path / "runs.jsonl"
    refused = FakeProvider(script=[LLMRejected("LLM_REQUEST_REJECTED")])
    assert not run(small, refused, results)
    assert {r["status"] for r in read_records(results)} == {"error"}
    assert report.build(read_records(results), small)["splits"]["smoke"]["complete"] is False
    assert run(small, FakeProvider(script=answers(small)), results)  # tried again


def test_pacing_inside_a_document_is_taken_out_of_its_latency(tmp_path: Path) -> None:
    """A schema retry inside extract waits for the pacer (here 3 s at 20 a minute). That wait is
    quota, not reading time, so it must not show up in latencyMs."""
    root, pin = make_dataset(tmp_path / "v1", [PNG_DOC])
    dataset = load(root, pin)
    provider = FakeProvider(script=["not json", answers(dataset)[0]])
    results = tmp_path / "runs.jsonl"
    started = time.monotonic()
    assert run_split(
        dataset, "smoke", 1, provider, results, rpm=20, max_calls=10, say=lambda _l: None
    )
    total_ms = (time.monotonic() - started) * 1000
    record = read_records(results)[0]
    assert record["calls"] == 2
    assert record["pacingMs"] >= 2500
    assert record["latencyMs"] <= total_ms - 2500


def test_a_line_cut_by_a_killed_process_is_dropped_and_the_document_runs_again(
    small: Dataset, tmp_path: Path
) -> None:
    results = tmp_path / "runs.jsonl"
    first, second = answers(small)
    assert run(small, FakeProvider(script=[first, second]), results)
    text = results.read_text().splitlines()
    results.write_text(text[0] + "\n" + text[1][:40])  # half of the last line
    assert [r["doc"] for r in read_records(results)] == [PDF_DOC]
    again = FakeProvider(script=[second])
    assert run(small, again, results)
    assert len(again.calls) == 1


def test_calls_replaced_by_a_later_run_are_still_billed(small: Dataset, tmp_path: Path) -> None:
    results = tmp_path / "runs.jsonl"
    # First run: the PDF fails for good after a billed answer the schema rejected each time.
    assert not run(
        small,
        FakeProvider(script=["not json", LLMUnavailable()] * 3 + [answers(small)[1]]),
        results,
    )
    assert run(small, FakeProvider(script=answers(small)), results)
    records = read_records(results)
    usage = report.build(records, small)["splits"]["smoke"]["usage"]
    assert usage["inputTokens"] == sum(r["inputTokens"] for r in records)
    assert usage["inputTokens"] > sum(r["inputTokens"] for r in report.latest(records).values())


def test_the_dataset_is_checked_before_a_provider_is_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import runner.__main__ as cli

    def broken() -> None:
        raise DatasetError("HASH_MISMATCH", "x")

    def no_provider(_settings: object) -> None:
        raise AssertionError("a provider was built before the dataset check")

    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setattr(cli, "load", broken)
    monkeypatch.setattr(cli, "build_provider", no_provider)
    assert cli.main(["run", "smoke"]) == 1
