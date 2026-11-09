"""compare-v1: the configurations of T4.4 side by side on `core`, with an error analysis.

Numbers come from the same scoring as each configuration's own report (`report.build`), read
again from `eval/runs/`, so nothing here is copied by hand. The verdict follows a rule written
before the `core` runs (ADR 0020: a threshold "cannot be adjusted after seeing the result it
judges"), see `choose_primary`.

Values: the JSON has none (T4.6 may read it). The Markdown shows the right and the given value for
the five examples only. They are synthetic, and the picture shows the value anyway (Hậu's decision,
2026-11-08, an exception to AI_PIPELINE.md §6 for this file).
"""

import json
import math
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from runner import report
from runner.dataset import Dataset
from runner.errors import CLASSES, classify
from runner.figures import render_band
from runner.matching import CRITICAL_FIELDS, FIELD_KINDS
from runner.names import REPORTS_DIR, RUNS_DIR, slug
from runner.run import read_records
from runner.scoring import score_document, value_at
from runner.textlayer import Printed, format_amount, pdf_of, read_printed

NAME = "compare-v1"
FIGURES_DIR = REPORTS_DIR / NAME
EXAMPLES = 5
# Two documents on `core`: a smaller difference in critical exact is not a reason to pay more.
TIE_DOCUMENTS = 2
# Error locations and table cells written in several places (SonarCloud S1192).
LINES_AT = "lines["
EXTRA_AT = "extra["
LINE_AT = (LINES_AT, EXTRA_AT)
TABLE_RULE = "|---|"
NOT_RUN = "not run"
# Fields a whole-token check against the PDF text layer could test. Dates are printed in several
# ways (textlayer.py), names and addresses wrap over lines.
CHECKABLE = (
    "invoiceNo",
    "series",
    "currency",
    "seller.taxCode",
    "buyer.taxCode",
    "subtotal",
    "total",
)
# Order in which error classes get an example, so the five cover as many classes as there are.
EXAMPLE_SLOTS = (
    ("misread", "truncated"),
    ("missing", None),
    ("wrong_field", "other_line"),
    ("wrong_field", None),
    ("hallucination", None),
    ("missing_line", None),
    ("misread", "digits"),
    ("misread", "text"),
    ("misread", "diacritics"),
)


@dataclass(frozen=True)
class Config:
    key: str
    provider: str
    model: str
    role: str  # "candidate": may become the primary; "fallback": the other provider (ADR 0009)
    # Why `injection` is not run on this configuration, when it is not.
    no_injection: str | None = None
    # Why the runs stop short of the whole set, when they do (shown next to the configuration).
    note: str | None = None
    # What was paid. A declaration, not a measurement: checked by hand on the provider's billing
    # page or API before and after the runs (no billing account; OpenRouter credits 0 and key
    # limit 0, 2026-11-08). Change it if a run is ever made on a paid tier.
    paid: str = "$0 (free tier)"


CONFIGS = (
    Config("A", "Gemini API, free tier", "gemini-3.1-flash-lite", "candidate"),
    Config("B", "Gemini API, free tier", "gemini-3.5-flash-lite", "candidate"),
    Config(
        "C",
        "OpenRouter, free route (NVIDIA endpoint)",
        "nvidia/nemotron-3.5-super-vl:free",
        "fallback",
        no_injection="NVIDIA API Trial Terms §4.10 forbid security testing of the service",
        note=(
            "stopped by decision at 49 of 100 `core` documents (all 9 variants), no `regression`: "
            "50 free requests a day, and its terms rule it out of production whatever it scores, "
            "so more documents would not change a decision (2026-11-08)"
        ),
    ),
)


def runs_path(dataset: Dataset, config: Config) -> Path:
    return RUNS_DIR / f"{slug(dataset.name, config.model)}.jsonl"


def _core_rows(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Latest record per core document (one repeat on core)."""
    rows = report.latest(r for r in records if r["split"] == "core" and r["repeat"] == 0)
    return {doc: r for (_, doc, _), r in rows.items()}


def _summary(config: Config, built: dict[str, Any]) -> dict[str, Any]:
    splits = built["splits"]
    core = splits.get("core")
    out: dict[str, Any] = {
        "key": config.key,
        "provider": config.provider,
        "model": config.model,
        "role": config.role,
        "report": slug(built["config"]["dataset"], config.model),
        "core": None,
        "noInjection": config.no_injection,
        "note": config.note,
        "paid": config.paid,
    }
    if core:
        overall = core["overall"]
        out["core"] = {
            "complete": core["complete"],
            "documents": core["distinctDocuments"],
            "critical": {f: overall["fields"][f] for f in CRITICAL_FIELDS},
            "fields": overall["fields"],
            "lines": {
                k: overall["lines"][k] for k in ("f1", "precision", "recall", "missing", "extra")
            },
            "criticalExact": overall["criticalExact"],
            "documentExact": overall["documentExact"],
            "failures": core["failures"],
            "costUsdPerDocument": core["usage"]["costUsdPerDocument"],
            "latency": core["usage"]["latency"]["all"],
            "latencySinglePage": core["usage"]["latency"]["singlePage"],
            "medianInputTokens": core["usage"]["medianInputTokens"],
            "calls": core["usage"]["calls"],
            "sellerBranchSuffixCut": core["sellerBranchSuffixCut"],
            "confidentWrong": core["confidentWrong"],
            "byVariant": {
                v: {
                    "documents": s["documents"],
                    "linesF1": s["linesF1"],
                    "critical": {f: c["accuracy"] for f, c in s["critical"].items()},
                }
                for v, s in core["byVariant"].items()
            },
        }
    smoke = splits.get("smoke")
    out["smokeNoise"] = smoke["noise"] if smoke else None
    injection = splits.get("injection")
    out["injection"] = injection["outcomes"] if injection else None
    regression = splits.get("regression")
    out["regression"] = (
        {
            "cases": len(regression["cases"]),
            "sellerSuffixCut": sum(
                "seller.taxCode" in c["branchSuffixCut"] for c in regression["cases"]
            ),
        }
        if regression
        else None
    )
    return out


def choose_primary(summaries: list[dict[str, Any]]) -> dict[str, Any]:
    """The rule fixed on 2026-11-08 before any `core` run (T4.4 plan, approved by Hậu):

    1. Candidates only (Gemini); the fallback is reported, never chosen here.
    2. A candidate needs a complete `core` run and no successful attack on `injection`.
    3. Most documents with all 8 critical fields right wins.
    4. Within TIE_DOCUMENTS documents of the best, the lowest cost per document wins.
    """
    eligible = []
    for s in summaries:
        if s["role"] != "candidate" or not s["core"] or not s["core"]["complete"]:
            continue
        if not s["injection"] or s["injection"].get("attacked", 0):
            continue
        eligible.append(s)
    if not eligible:
        return {
            "key": None,
            "reason": "no candidate has a complete core run and a clean injection run",
        }
    best = max(s["core"]["criticalExact"]["correct"] for s in eligible)
    close = [s for s in eligible if best - s["core"]["criticalExact"]["correct"] <= TIE_DOCUMENTS]
    if len(close) == 1:
        return {"key": close[0]["key"], "reason": "most documents with every critical field right"}
    priced = [s for s in close if s["core"]["costUsdPerDocument"] is not None]
    pick = min(priced, key=lambda s: s["core"]["costUsdPerDocument"]) if priced else close[0]
    return {
        "key": pick["key"],
        "reason": (
            f"within {TIE_DOCUMENTS} documents of the best on critical exact, "
            "lowest cost per document"
        ),
    }


def floors(summary: dict[str, Any]) -> dict[str, Any] | None:
    """ADR 0020: floor = measured - max(noise, one document = 1 point on core), rounded down."""
    noise = summary["smokeNoise"]
    core = summary["core"]
    if not noise or not core:
        return None

    def floor(share: float, noise_points: float) -> int:
        # round first: 0.58 * 100 is 57.99999999999999 in binary floating point, and a bare
        # floor would put the floor one point under the ADR 0020 value.
        return math.floor(round(share * 100 - max(noise_points, 1.0), 6))

    out = {f: floor(core["critical"][f]["accuracy"], noise[f]) for f in CRITICAL_FIELDS}
    out[report.LINE_F1] = floor(core["lines"]["f1"], noise[report.LINE_F1])
    return out


def paired(a: dict[str, dict[str, Any]], b: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Per document, right in one configuration and wrong in the other (scores from `score`)."""
    docs = sorted(set(a) & set(b))
    out: dict[str, Any] = {"documents": len(docs)}
    for name in ("criticalExact", *CRITICAL_FIELDS):

        def right(s: dict[str, Any], n: str = name) -> bool:
            return s["criticalExact"] if n == "criticalExact" else s["fields"][n]

        out[name] = {
            "onlyFirst": sum(right(a[d]) and not right(b[d]) for d in docs),
            "onlySecond": sum(right(b[d]) and not right(a[d]) for d in docs),
        }
    return out


def _bucket(where: str) -> str:
    """lines[3].amount -> lines.amount, extra[0] -> extra line; header paths unchanged."""
    if where.startswith(LINES_AT):
        return "lines" + (where[where.index("]") + 1 :] or "")
    if where.startswith(EXTRA_AT):
        return "extra line"
    return where


def _text_check(
    got: dict[str, Any] | None, scores: dict[str, Any], printed: Printed, counts: Counter[str]
) -> None:
    """What a whole-token check of each value against the text layer would have said."""
    if got is None:
        return
    for path in CHECKABLE:
        value = value_at(got, path)
        if value is None:
            continue
        kind = FIELD_KINDS[path]
        if kind == "number":
            on_page = isinstance(value, int) and printed.has_amount(value)
        else:
            on_page = isinstance(value, str) and printed.has_text(value)
        right = scores["fields"][path]
        counts[f"{'right' if right else 'wrong'}_{'printed' if on_page else 'not_printed'}"] += 1


def _needles(doc: dict[str, Any], want: dict[str, Any], where: str) -> list[str]:
    """What to look for on the page for an example: the right value, else its neighbourhood."""
    locale, currency = doc["locale"], doc["currency"]
    if where.startswith(LINE_AT):
        index = int(where[where.index("[") + 1 : where.index("]")])
        lines = want["lines"]
        line = lines[index] if where.startswith(LINES_AT) and index < len(lines) else None
        return [line["description"]] if line else []
    value = value_at(want, where)
    party = where.split(".")[0] if "." in where else None
    needles: list[str] = []
    if where == "issueDate" and isinstance(value, str):
        needles += date_needles(value)
    if isinstance(value, int) and FIELD_KINDS.get(where) == "number":
        needles.append(format_amount(value, locale, currency))
    elif isinstance(value, str):
        needles += [value, " ".join(value.split()[:3])]
    if party in ("seller", "buyer"):
        needles.append(value_at(want, f"{party}.name") or "")
    return needles


MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


def date_needles(iso: str) -> list[str]:
    """The ways the generator's layouts print one date, to find it on the page."""
    y, m, d = (int(p) for p in iso.split("-"))
    return [
        f"{d:02d}/{m:02d}/{y}",
        f"Ngày {d:02d} tháng {m:02d} năm {y}",
        f"{MONTHS[m - 1]} {d}, {y}",
        f"{d:02d}-{m:02d}-{y}",
        f"{d:02d}.{m:02d}.{y}",
        iso,
        f"{d}/{m}/{y}",
    ]


def _display(value: Any) -> str:
    if value is None:
        return "(none)"
    return f"`{value}`"


def pick_examples(errors: list[dict[str, Any]], limit: int = EXAMPLES) -> list[dict[str, Any]]:
    """One example per class in EXAMPLE_SLOTS order, a new document each time when possible."""
    ordered = sorted(errors, key=lambda e: (e["config"], e["doc"], e["where"]))
    chosen: list[dict[str, Any]] = []
    used_docs: set[str] = set()
    for cls, kind in EXAMPLE_SLOTS:
        if len(chosen) == limit:
            break
        if kind is None and any(e["class"] == cls for e in chosen):
            continue  # a class-wide slot is for a class that has no example yet
        matches = [e for e in ordered if e["class"] == cls and (kind is None or e["kind"] == kind)]
        fresh = [e for e in matches if e["doc"] not in used_docs] or matches
        if fresh:
            chosen.append(fresh[0])
            used_docs.add(fresh[0]["doc"])
    rest = [e for e in ordered if e not in chosen and e["doc"] not in used_docs]
    chosen += rest[: limit - len(chosen)]
    return chosen


def _line_values(
    e: dict[str, Any], got_lines: list[dict[str, Any]], want: dict[str, Any]
) -> tuple[str, str]:
    """`lines[i]`, `lines[i].column` or `extra[i]`: the invoice's value and the answer's."""
    where = e["where"]
    index = int(where[where.index("[") + 1 : where.index("]")])
    if where.startswith(EXTRA_AT):
        line = got_lines[index] if index < len(got_lines) else {}
        return ("(no such line)", _display(line.get("description")))
    want_line = want["lines"][index]
    if "." not in where:
        return (_display(want_line["description"]), "(no line)")
    column = where.split(".", 1)[1]
    at = e.get("gotLine")
    got_line = got_lines[at] if at is not None and at < len(got_lines) else {}
    return (_display(want_line[column]), _display(got_line.get(column)))


def _example_values(
    e: dict[str, Any], got: dict[str, Any] | None, want: dict[str, Any]
) -> tuple[str, str]:
    where = e["where"]
    if where == "document":
        return ("the whole invoice", "no answer")
    if where.startswith(LINE_AT):
        return _line_values(e, (got or {}).get("lines") or [], want)
    return (_display(value_at(want, where)), _display(value_at(got or {}, where)))


def _empty_summary(config: Config) -> dict[str, Any]:
    """A configuration with no runs recorded yet."""
    return {
        "key": config.key,
        "provider": config.provider,
        "model": config.model,
        "role": config.role,
        "core": None,
        "smokeNoise": None,
        "injection": None,
        "regression": None,
        "report": None,
        "noInjection": config.no_injection,
        "note": config.note,
        "paid": config.paid,
    }


@dataclass
class _Scored:
    """One configuration on `core`: scores, answers, text-layer check, classified errors."""

    scores: dict[str, dict[str, Any]]
    answers: dict[str, dict[str, Any] | None]
    text_check: Counter[str]
    errors: list[dict[str, Any]]


def _score_config(
    key: str, records: list[dict[str, Any]], dataset: Dataset, printed: dict[str, Printed]
) -> _Scored:
    """`printed` caches the text layer per document across configurations."""
    out = _Scored({}, {}, Counter(), [])
    for doc_id, row in sorted(_core_rows(records).items()):
        doc = dataset.documents[doc_id]
        want = dataset.expected(doc_id)
        got = row.get("got") if row["status"] == "ok" else None
        if doc_id not in printed:
            path = pdf_of(dataset.root / "documents", doc)
            printed[doc_id] = read_printed(path, doc["locale"], doc["currency"])
        score = score_document(got, want)
        out.scores[doc_id] = score
        out.answers[doc_id] = got
        _text_check(got, score, printed[doc_id], out.text_check)
        out.errors += [
            {"config": key, "doc": doc_id, **e} for e in classify(got, want, printed[doc_id])
        ]
    return out


def _classes(errors: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "byClass": dict(Counter(e["class"] for e in errors)),
        "byKind": dict(Counter(f"{e['class']}:{e['kind']}" for e in errors if e["kind"])),
        "byPlace": dict(Counter(f"{_bucket(e['where'])}|{e['class']}" for e in errors)),
    }


def build(dataset: Dataset, configs: tuple[Config, ...] = CONFIGS) -> dict[str, Any]:
    summaries: list[dict[str, Any]] = []
    scored: dict[str, _Scored] = {}
    printed: dict[str, Printed] = {}
    for config in configs:
        records = read_records(runs_path(dataset, config))
        if not records:
            summaries.append(_empty_summary(config))
            continue
        summaries.append(_summary(config, report.build(records, dataset)))
        scored[config.key] = _score_config(config.key, records, dataset, printed)
    errors = [e for k in scored for e in scored[k].errors]
    classes = {k: _classes(scored[k].errors) for k in scored}
    answers = {k: scored[k].answers for k in scored}
    text_check = {k: scored[k].text_check for k in scored}
    keys = sorted(scored)
    pairs = {
        f"{a}-{b}": paired(scored[a].scores, scored[b].scores)
        for i, a in enumerate(keys)
        for b in keys[i + 1 :]
    }
    primary = choose_primary(summaries)
    chosen = next((s for s in summaries if s["key"] == primary["key"]), None)
    examples = pick_examples(errors)
    return {
        "schemaVersion": 1,
        "name": NAME,
        "dataset": dataset.name,
        "manifestSha256": dataset.manifest_sha256,
        "configs": summaries,
        "primary": {**primary, "report": chosen["report"] if chosen else None},
        "floors": floors(chosen) if chosen else None,
        "paired": pairs,
        "errors": classes,
        "textLayerCheck": {k: dict(v) for k, v in text_check.items()},
        # Ids and paths only; the values are in the Markdown (examples) and eval/runs.
        "examples": [
            {k: e.get(k) for k in ("config", "doc", "where", "class", "kind", "gotLine")}
            for e in examples
        ],
        "_answers": answers,  # dropped before writing: needed for the Markdown examples only
    }


def write_figures(
    dataset: Dataset, built: dict[str, Any], out_dir: Path = FIGURES_DIR
) -> list[str | None]:
    """One PNG per example; the file name is made of manifest ids and a fixed suffix."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("example-*.png"):  # pictures of a previous choice of examples
        old.unlink()
    names: list[str | None] = []
    for number, e in enumerate(built["examples"], start=1):
        doc = dataset.documents[e["doc"]]
        png = render_band(
            pdf_of(dataset.root / "documents", doc),
            _needles(doc, dataset.expected(e["doc"]), e["where"]),
        )
        if png is None:
            names.append(None)
            continue
        name = f"example-{number}-{e['doc']}.png"
        (out_dir / name).write_bytes(png)
        names.append(name)
    return names


# ---------------------------------------------------------------- Markdown

ANALYSIS = REPORTS_DIR / f"{NAME}.analysis.md"  # hand-written judgement, spliced in as is
COMPARE_LIMITS = [
    "The primary is chosen on the same 100 documents it is scored on. The rule was fixed before "
    "the runs, but picking the best of two on one set still flatters the winner a little.",
    "Error classes come from rules (eval/runner/errors.py), not from a person: each class has a "
    "test, and the five examples below were checked by eye.",
    "The text-layer check reads the invoice PDF. For a picture variant the model saw a photo of "
    "the same invoice, so the check says what is printed, not what was legible in the photo.",
]


def _cell(rate_: dict[str, Any] | None) -> str:
    if not rate_ or rate_.get("accuracy") is None:
        return "–"
    return f"{rate_['accuracy'] * 100:.1f}% ({rate_['correct']}/{rate_['total']})"


def _latency(cell: dict[str, Any]) -> str:
    if not cell["p50Ms"]:
        return "–"
    return f"{cell['p50Ms'] / 1000:.1f} s / {cell['p95Ms'] / 1000:.1f} s"


def _money(value: float | None) -> str:
    return "not priced" if value is None else f"${value:.5f}"


def _row(name: str, values: list[str]) -> str:
    return f"| {name} | " + " | ".join(values) + " |"


def _core_table(configs: list[dict[str, Any]]) -> list[str]:
    cores = [c["core"] for c in configs]
    head = [
        "| | " + " | ".join(f"{c['key']}: `{c['model']}`" for c in configs) + " |",
        TABLE_RULE + "---|" * len(configs),
    ]
    rows = [
        _row(f"**{f}**", [_cell(c["critical"][f]) if c else NOT_RUN for c in cores])
        for f in CRITICAL_FIELDS
    ]

    def get(fn: Any) -> list[str]:
        return [fn(c) if c else "–" for c in cores]

    rows += [
        _row("line F1 (micro)", get(lambda c: f"{c['lines']['f1']:.3f}")),
        _row(
            "line precision / recall",
            get(lambda c: f"{c['lines']['precision']:.3f} / {c['lines']['recall']:.3f}"),
        ),
        _row(
            "lines missing / extra",
            get(lambda c: f"{c['lines']['missing']} / {c['lines']['extra']}"),
        ),
        _row("all 8 critical fields right", get(lambda c: _cell(c["criticalExact"]))),
        _row("document exact", get(lambda c: _cell(c["documentExact"]))),
        _row(
            "seller tax code suffix cut",
            get(
                lambda c: (
                    f"{c['sellerBranchSuffixCut']['count']} of {c['sellerBranchSuffixCut']['of']}"
                )
            ),
        ),
        _row(
            "failed or rejected",
            get(
                lambda c: (
                    str(sum(c["failures"].values()))
                    + (f" {c['failures']}" if c["failures"] else "")
                )
            ),
        ),
        _row("complete", get(lambda c: "yes" if c["complete"] else "**no**")),
        _row("**amount actually paid**", [c["paid"] for c in configs]),
        _row(
            "list price per document, if it were paid",
            get(lambda c: _money(c["costUsdPerDocument"])),
        ),
        _row("median input tokens", get(lambda c: str(c["medianInputTokens"]))),
        _row("latency p50 / p95, all pages", get(lambda c: _latency(c["latency"]))),
        _row("latency p50 / p95, single page", get(lambda c: _latency(c["latencySinglePage"]))),
    ]
    rows.append(
        _row(
            "injection: attacks that worked",
            [
                f"{c['injection'].get('attacked', 0)} of {c['injection']['of']}"
                if c["injection"]
                else f"not run: {c['noInjection']}"
                if c.get("noInjection")
                else NOT_RUN
                for c in configs
            ],
        )
    )
    rows.append(
        _row(
            "regression-00: suffix cut",
            [
                f"{c['regression']['sellerSuffixCut']} of {c['regression']['cases']}"
                if c["regression"]
                else NOT_RUN
                for c in configs
            ],
        )
    )
    return head + rows


def _variant_table(configs: list[dict[str, Any]]) -> list[str]:
    """One row per variant; each cell carries its own document count, because a configuration
    that stopped short has fewer documents of some variants."""
    ran = [c for c in configs if c["core"]]
    if not ran:
        return []
    variants = sorted({v for c in ran for v in c["core"]["byVariant"]})
    out = [
        "| Variant | "
        + " | ".join(f"{c['key']}: critical values right / line F1 (docs)" for c in ran)
        + " |",
        TABLE_RULE + "---|" * len(ran),
    ]
    for v in variants:
        cells = []
        for c in ran:
            s = c["core"]["byVariant"].get(v)
            if not s:
                cells.append("–")
                continue
            mean = sum(s["critical"].values()) / len(s["critical"])
            cells.append(f"{mean * 100:.1f}% / {s['linesF1']:.3f} ({s['documents']})")
        out.append(f"| {v} | " + " | ".join(cells) + " |")
    return out


def _error_tables(built: dict[str, Any]) -> list[str]:
    keys = sorted(built["errors"])
    out = ["| Class | " + " | ".join(keys) + " |", TABLE_RULE + "---|" * len(keys)]
    for cls in CLASSES:
        out.append(
            f"| {cls} | "
            + " | ".join(str(built["errors"][k]["byClass"].get(cls, 0)) for k in keys)
            + " |"
        )
    for k in keys:
        kinds = built["errors"][k]["byKind"]
        places = Counter(built["errors"][k]["byPlace"]).most_common(6)
        out += [
            "",
            f"**{k}**: kinds {dict(sorted(kinds.items())) or '{}'}. Most frequent places: "
            + (
                ", ".join(f"`{p.split('|')[0]}` {p.split('|')[1]} ×{n}" for p, n in places)
                or "none"
            )
            + ".",
        ]
    return out


def _text_table(built: dict[str, Any]) -> list[str]:
    out = [
        "| | Wrong, not printed (caught) | Wrong but printed (missed) "
        "| Right but not printed (false alarm) | Right and printed |",
        "|---|---|---|---|---|",
    ]
    for k, c in sorted(built["textLayerCheck"].items()):
        out.append(
            f"| {k} | {c.get('wrong_not_printed', 0)} | {c.get('wrong_printed', 0)} | "
            f"{c.get('right_not_printed', 0)} | {c.get('right_printed', 0)} |"
        )
    return out


def _paired_lines(built: dict[str, Any]) -> list[str]:
    out = [
        "| Pair | All critical right only in first | only in second | Fields where they differ |",
        "|---|---|---|---|",
    ]
    for pair, p in built["paired"].items():
        first, second = pair.split("-")
        diffs = [
            f"`{f}` {p[f]['onlyFirst']}/{p[f]['onlySecond']}"
            for f in CRITICAL_FIELDS
            if p[f]["onlyFirst"] or p[f]["onlySecond"]
        ]
        out.append(
            f"| {first} vs {second} ({p['documents']} docs) | {p['criticalExact']['onlyFirst']} | "
            f"{p['criticalExact']['onlySecond']} | {', '.join(diffs) or 'none'} |"
        )
    return out


def _examples(built: dict[str, Any], dataset: Dataset, figures: list[str | None]) -> list[str]:
    model = {c["key"]: c["model"] for c in built["configs"]}
    out: list[str] = []
    for number, (e, figure) in enumerate(zip(built["examples"], figures, strict=True), start=1):
        doc = dataset.documents[e["doc"]]
        want = dataset.expected(e["doc"])
        got = built["_answers"][e["config"]].get(e["doc"])
        right, given = _example_values(e, got, want)
        kind = f" ({e['kind']})" if e["kind"] else ""
        out += [
            f"### {number}. {e['class']}{kind}: `{e['where']}`",
            "",
            f"{e['config']} (`{model[e['config']]}`), `{e['doc']}`, "
            f"variant `{doc['variant']}`, layout `{doc['layout']}`.",
            "",
            f"- On the invoice: {right}",
            f"- In the answer: {given}",
            "",
        ]
        box = (
            "the description of that line (the wrong value is in the same row)"
            if e["where"].startswith(LINE_AT)
            else "where the right value is printed"
        )
        if figure:
            note = (
                ""
                if doc["primary"].endswith(".pdf")
                else (
                    f" The model was given the picture [`{doc['primary']}`]"
                    f"(../datasets/v1/documents/{doc['primary']}); "
                    "this band is cut from the PDF of the same invoice."
                )
            )
            out += [
                f"![Example {number}: {e['class']} in {e['doc']}]({NAME}/{figure})",
                "",
                f"*Red box: {box}.{note}*",
                "",
            ]
        else:
            out += ["*No picture: the value could not be located in the text layer.*", ""]
    return out


def to_markdown(
    built: dict[str, Any], dataset: Dataset, figures: list[str | None], analysis: str
) -> str:
    configs = built["configs"]
    primary = built["primary"]
    lines = [
        f"# Model comparison on `{built['dataset']}`: {len(configs)} configurations, "
        "prompt `invoice_extraction/v1`",
        "",
        f"Dataset `{built['dataset']}` (manifest `{built['manifestSha256'][:12]}`). "
        "Written by `pnpm eval:compare` "
        "from `eval/runs/`; the **Analysis** section comes from "
        f"[`{ANALYSIS.name}`]({ANALYSIS.name}), written by hand. Do not edit this file by hand.",
        "",
        "## Configurations",
        "",
        "| Key | Provider | Model | Role | Full report | Note |",
        "|---|---|---|---|---|---|",
    ]
    for c in configs:
        link = f"[`{c['report']}.md`]({c['report']}.md)" if c["report"] else NOT_RUN
        note = c.get("note") or ""
        lines.append(
            f"| {c['key']} | {c['provider']} | `{c['model']}` | {c['role']} | {link} | {note} |"
        )
    lines += [
        "",
        "## Verdict",
        "",
        f"**Primary: {primary['key'] or 'none yet'}**"
        + (
            f" (`{next(c['model'] for c in configs if c['key'] == primary['key'])}`)"
            if primary["key"]
            else ""
        )
        + f". {primary['reason']}.",
        "",
        "Rule, fixed on 2026-11-08 before the `core` runs: candidates are the Gemini "
        "configurations; "
        "a candidate needs a complete `core` run and no successful attack on `injection`; most "
        "documents with all 8 critical fields right wins; within "
        f"{TIE_DOCUMENTS} documents of the best, the lowest cost per document wins. The fallback "
        "is measured, not chosen.",
        "",
        "## `core`: one run each",
        "",
        "A configuration that stopped short shows its own denominator; compare it with the "
        "others in **Paired differences**, which counts only the documents both have.",
        "",
        *_core_table(configs),
        "",
        "Critical fields (ADR 0020) in bold. A failed document counts as wrong on every field. "
        "**Nothing was paid**: every call ran on a free tier with no billing account (Gemini: "
        "no billing set up; OpenRouter: key spending limit 0, credits 0). The list price is what "
        "the same tokens would cost on the paid tier (`apps/ai/app/providers/pricing.py`), kept "
        "only to compare configurations.",
        "",
        "## Paired differences",
        "",
        "One document is one point on `core`, so a difference of 2 points can be 2 documents. "
        "These "
        "count the documents themselves (first/second).",
        "",
        *_paired_lines(built),
        "",
        "## By variant",
        "",
        "Critical values right: the 8 critical fields averaged over the documents of the variant.",
        "",
        *_variant_table(configs),
        "",
        "## Error classes",
        "",
        "Every wrong value on `core`, classified by `eval/runner/errors.py`: `misread` (close to "
        "the "
        "printed value), `wrong_field` (printed on the invoice, in another place), `missing` "
        "(printed, not in the answer), `missing_line`, `hallucination` (printed nowhere, or a "
        "value "
        "for an empty field), `failed` (no answer).",
        "",
        *_error_tables(built),
        "",
        "## Checking values against the PDF text layer",
        "",
        'What a check "is this value printed on the invoice, as whole tokens" would say about each '
        f"answer, for {', '.join(f'`{f}`' for f in CHECKABLE)} (Phát sinh T3.6, T3.7). A substring "
        "check would miss the cut tax code, which is a substring of the printed one.",
        "",
        *_text_table(built),
        "",
        "## Acceptance floors (ADR 0020)",
        "",
    ]
    if built["floors"]:
        lines += [
            "| " + " | ".join(built["floors"]) + " |",
            "|" + "---|" * len(built["floors"]),
            "| " + " | ".join(f"{v}%" for v in built["floors"].values()) + " |",
            "",
            "floor = measured on `core` − max(noise on `smoke`, 1 point), rounded down.",
        ]
    else:
        lines.append(
            "Not computed: the primary needs a complete `core` run and three `smoke` runs for "
            "its noise."
        )
    lines += [
        "",
        "## Five error examples",
        "",
        "Values are synthetic (wrong check digits, `SAMPLE` names). Chosen by rule, one per "
        "error class where the class occurred, a different document each time.",
        "",
        *_examples(built, dataset, figures),
        "## Analysis",
        "",
        analysis.strip(),
        "",
        "## Limits",
        "",
        *[f"- {item}" for item in report.LIMITS + COMPARE_LIMITS],
        "",
    ]
    return "\n".join(lines)


def write(dataset: Dataset, reports_dir: Path = REPORTS_DIR) -> list[str]:
    built = build(dataset)
    figures = write_figures(dataset, built, reports_dir / NAME)
    analysis_file = reports_dir / ANALYSIS.name
    analysis = (
        analysis_file.read_text(encoding="utf-8")
        if analysis_file.exists()
        else "_Not written yet._"
    )
    (reports_dir / f"{NAME}.md").write_text(
        to_markdown(built, dataset, figures, analysis), encoding="utf-8"
    )
    public = {k: v for k, v in built.items() if not k.startswith("_")}
    (reports_dir / f"{NAME}.json").write_text(
        json.dumps(public, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return [f"eval/reports/{NAME}.md", f"eval/reports/{NAME}.json"]
