"""Regression gate on `smoke` against a committed baseline (T4.5, ADR 0020).

ADR 0020: fail when a critical field or line F1 drops by more than the larger of the measured
noise and one document. On 20 documents one document is 5 points. Rates compare as exact
fractions: 0.95 - 0.9 in floating point is not 0.05, and a gate must not turn on a rounding error.
Line F1 arrives rounded to 4 decimals on both sides (report.py), so it is exact to about 1e-4:
far below one document (0.05) on `smoke`.

The baseline is a file of its own (`eval/baselines/smoke.json`), written by `pnpm eval:baseline`
from a committed report. It is not the report itself: `pnpm eval:report` rewrites a report from the
local runs, so the baseline would move after any local run without anyone deciding it.

Exit codes: 0 pass, 1 a drop beyond the tolerance, 2 nothing can be judged (the run stopped early,
a document only failed temporarily, or the baseline was measured on another dataset). 2 is red
too: a gate that cannot measure must not look green.
"""

import hashlib
import json
from collections.abc import Callable
from fractions import Fraction
from pathlib import Path
from typing import Any

from app.providers.base import LLMProvider
from app.services.extract import PROMPT_VERSION, extract
from runner import report
from runner.dataset import REPO, Dataset
from runner.matching import CRITICAL_FIELDS
from runner.run import PROMPT_SHA256, RETRY_WAIT_S, Extract, read_records, run_split

SPLIT = "smoke"
BASELINE_PATH = REPO / "eval" / "baselines" / f"{SPLIT}.json"
LINE_F1 = report.LINE_F1
PASS, DROPPED, NOT_JUDGED = 0, 1, 2
# What turns a model answer into the scored invoice. Their hashes say whether the gate measured the
# same pipeline as the baseline; a change to any of them also starts the workflow (eval.yml).
PIPELINE_FILES = (
    "apps/ai/app/prompts/invoice_extraction/v1.md",
    "apps/ai/app/services/extract.py",
    "apps/ai/app/services/pdf_pages.py",
    "apps/ai/app/services/image_normalize.py",
    "apps/ai/app/providers/__init__.py",
    "apps/ai/app/providers/base.py",
    "apps/ai/app/providers/gemini.py",
    "apps/ai/app/providers/openai_compat.py",
    # The model answer is validated against this schema: a stricter one rejects more documents.
    # It is generated from packages/contracts, and CI's schema-drift job keeps the two in step.
    "apps/ai/app/schemas/generated.py",
    "apps/ai/app/error_codes.py",
)
# Keys of the report and the baseline, each used in several places (SonarCloud S1192).
OVERALL = "overall"
NOISE = "noisePoints"
CORRECT = "correct"
TOTAL = "total"


class GateError(Exception):
    """The baseline cannot be built or does not apply to this run."""


def pipeline_hashes(root: Path = REPO) -> dict[str, str]:
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in PIPELINE_FILES}


def build_baseline(built: dict[str, Any], source: str) -> dict[str, Any]:
    """From a report (`report.build`) whose `smoke` split has every repeat complete."""
    split = built["splits"].get(SPLIT)
    if split is None or not split["complete"] or split["noise"] is None:
        raise GateError(f"the report needs a complete `{SPLIT}` run with at least 2 repeats")
    fields = split[OVERALL]["fields"]
    metrics: dict[str, dict[str, Any]] = {
        f: {
            CORRECT: fields[f][CORRECT],
            TOTAL: fields[f][TOTAL],
            "accuracy": fields[f]["accuracy"],
            NOISE: split["noise"][f],
        }
        for f in CRITICAL_FIELDS
    }
    metrics[LINE_F1] = {
        "value": split[OVERALL]["lines"]["f1"],
        NOISE: split["noise"][LINE_F1],
    }
    return {
        "schemaVersion": 1,
        "source": source,
        "config": built["config"],
        "runDates": built["runDates"],
        "split": SPLIT,
        "documents": split["documentsPerRepeat"],
        "repeats": split["repeats"],
        "metrics": metrics,
        # Hashed when the baseline is written: say it in the commit if the runs are older.
        "pipeline": pipeline_hashes(),
    }


def _points(value: Fraction) -> str:
    return f"{float(value * 100):+.1f}"


def _pct(value: Fraction) -> str:
    return f"{float(value * 100):.1f}%"


def judge(
    split: dict[str, Any], config: dict[str, str], baseline: dict[str, Any]
) -> tuple[int, list[dict[str, Any]]]:
    """Compare one gate run (a `smoke` split of `report.build`) with the baseline."""
    if config["manifestSha256"] != baseline["config"]["manifestSha256"]:
        raise GateError("the baseline was measured on another dataset: write a new baseline")
    if split["documentsPerRepeat"] != baseline["documents"]:
        raise GateError("the split has a different number of documents than the baseline")
    one_document = Fraction(1, baseline["documents"])
    rows = []
    for name, base in baseline["metrics"].items():
        if name == LINE_F1:
            before = Fraction(str(base["value"]))
            now = Fraction(str(split[OVERALL]["lines"]["f1"]))
        else:
            cell = split[OVERALL]["fields"][name]
            before = Fraction(base[CORRECT], base[TOTAL])
            now = Fraction(cell[CORRECT], cell[TOTAL])
        tolerance = max(Fraction(str(base[NOISE])) / 100, one_document)
        rows.append(
            {
                "metric": name,
                "baseline": before,
                "now": now,
                "tolerance": tolerance,
                "dropped": before - now > tolerance,  # "more than" the tolerance (ADR 0020)
            }
        )
    if not split["complete"]:
        return NOT_JUDGED, rows
    return (DROPPED if any(r["dropped"] for r in rows) else PASS), rows


def to_markdown(
    code: int,
    rows: list[dict[str, Any]],
    config: dict[str, str],
    baseline: dict[str, Any],
    split: dict[str, Any] | None,
) -> str:
    """Rates, field paths and document ids only: never a value read from a document."""
    verdict = {
        PASS: "PASS: no metric dropped by more than its tolerance",
        DROPPED: "FAIL: accuracy dropped by more than the tolerance (ADR 0020)",
        NOT_JUDGED: "NOT JUDGED: the run is incomplete or the baseline does not apply. Run again",
    }[code]
    b = baseline["config"]
    changed = [
        name
        for name, digest in pipeline_hashes().items()
        if baseline["pipeline"].get(name) != digest
    ]
    out = [
        f"## Eval gate, `{SPLIT}`: {verdict}",
        "",
        f"- Now: `{config['model']}`, `{config['promptVersion']}` (prompt "
        f"`{config['promptSha256'][:12]}`)",
        f"- Baseline: `{b['model']}`, `{b['promptVersion']}` (prompt `{b['promptSha256'][:12]}`),"
        f" {baseline['documents']} documents x {baseline['repeats']} repeats, "
        f"{baseline['runDates'][0]}",
        f"- Pipeline files changed since the baseline: {', '.join(changed) or 'none'}",
    ]
    if config["model"] != b["model"]:
        # Not a failure: comparing a new model with the old baseline is what the gate is for. But if
        # the default model changed on purpose, its own baseline belongs in the same PR.
        out.append(
            "- **Model differs from the baseline.** If the new model is meant to stay, measure it "
            "(`pnpm eval:run smoke --repeats 3`, `pnpm eval:report`) and commit "
            "`pnpm eval:baseline` in this PR."
        )
    out.append("")
    if rows:
        out += [
            "| Metric | Baseline | Now | Change (points) | Tolerance | Result |",
            "|---|---|---|---|---|---|",
            *[
                f"| {r['metric']} | {_pct(r['baseline'])} | {_pct(r['now'])} | "
                f"{_points(r['now'] - r['baseline'])} | {float(r['tolerance'] * 100):.1f} | "
                f"{'DROPPED' if r['dropped'] else 'ok'} |"
                for r in rows
            ],
            "",
        ]
    if split is not None:
        out.append(f"Complete: {split['complete']}. Failures: {split['failures'] or 'none'}.")
        out += [f"- {w['doc']}: {', '.join(w['fields']) or 'lines'}" for w in split["wrong"]]
    return "\n".join(out).rstrip() + "\n"


def run_gate(
    dataset: Dataset,
    provider: LLMProvider,
    results: Path,
    baseline: dict[str, Any],
    *,
    rpm: int,
    max_calls: int,
    extract_fn: Extract = extract,
    retry_wait_s: float = RETRY_WAIT_S,
    say: Callable[[str], None] = print,
) -> tuple[int, str]:
    """One fresh run of `smoke`, scored and compared with the baseline: (exit code, Markdown)."""
    results.unlink(missing_ok=True)  # a gate measures now, it never resumes an older run
    run_split(
        dataset,
        SPLIT,
        1,
        provider,
        results,
        rpm=rpm,
        max_calls=max_calls,
        extract_fn=extract_fn,
        retry_wait_s=retry_wait_s,
        say=say,
    )
    records = read_records(results)
    if not records:
        config = {
            "model": provider.model,
            "promptVersion": PROMPT_VERSION,
            "promptSha256": PROMPT_SHA256,
        }
        return NOT_JUDGED, to_markdown(NOT_JUDGED, [], config, baseline, None)
    built = report.build(records, dataset)
    split = built["splits"][SPLIT]
    try:
        code, rows = judge(split, built["config"], baseline)
    except GateError as err:
        say(f"NOT JUDGED: {err}")
        return NOT_JUDGED, to_markdown(NOT_JUDGED, [], built["config"], baseline, split)
    return code, to_markdown(code, rows, built["config"], baseline, split)


def read_baseline(path: Path = BASELINE_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_baseline(baseline: dict[str, Any], path: Path = BASELINE_PATH) -> None:
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(baseline, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
