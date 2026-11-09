"""JSON + Markdown report from the recorded runs. Scores are computed here, not at run time.

What the committed report holds: counts, rates, ids and field paths. Never a value read from a
document, so it can be shown on the public demo (T4.6, T4.7). Values stay in `eval/runs/`.
"""

import math
from collections import Counter, defaultdict
from collections.abc import Iterable
from statistics import median
from typing import Any

from app.providers.pricing import PRICES, PRICES_VERSION, estimate_cost_usd
from runner.dataset import SPLITS, Dataset
from runner.matching import CRITICAL_FIELDS, HEADER_FIELDS, LINE_COLUMNS
from runner.run import check_same_config
from runner.scoring import VAT_FIELD, score_attack, score_document

ACCURACY_SPLITS = ("smoke", "core")
# Runs written before T4.5b carry no `maxOutputTokens`: every one of them used 8,192.
CAP_BEFORE_T45B = 8192
FINAL = ("ok", "rejected")
LINE_F1 = "lines.f1"
LIMITS = [
    "Synthetic invoices from tools/invoice-gen: a score here says how the model reads this "
    "generator's documents, not the real invoices a business receives.",
    "Cleaner than real scans (no creases, shadows, stamps, handwriting): picture scores are an "
    "upper bound. The human correction rate (T4.6) is the online counterpart.",
    "The required SAMPLE watermark crosses some numbers and can lower a score.",
    "Latency is measured on the free tier, one call at a time, with pacing taken out.",
    "Cost uses list prices (apps/ai/app/providers/pricing.py); the free tier is billed 0.",
    "Free text compares with punctuation read as a space, so '12/3' and '12 3' agree in an "
    "address or description. Identifiers and amounts are compared strictly.",
    "Rates over several repeats count each document once per repeat: on 20 documents x 3 repeats "
    "the denominator is 60 but it is still 20 documents, so one document is 5 points on smoke.",
]


def latest(records: Iterable[dict[str, Any]]) -> dict[tuple[str, str, int], dict[str, Any]]:
    """A later line for the same (split, document, repeat) replaces an earlier one."""
    out: dict[tuple[str, str, int], dict[str, Any]] = {}
    for r in records:
        out[(r["split"], r["doc"], r["repeat"])] = r
    return out


def percentile(values: list[int], q: float) -> int | None:
    """Nearest rank: the smallest value with at least a share q of the sample at or below it."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(1, math.ceil(q * len(ordered))) - 1]


def rate(right: int, total: int) -> dict[str, Any]:
    return {
        "correct": right,
        "total": total,
        "accuracy": round(right / total, 4) if total else None,
    }


def f1(correct: int, predicted: int, expected: int) -> dict[str, float]:
    precision = correct / predicted if predicted else 0.0
    recall = correct / expected if expected else 0.0
    score = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(score, 4)}


def _field_rates(scores: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    names = [*HEADER_FIELDS, VAT_FIELD]
    return {n: rate(sum(s["fields"][n] for s in scores), len(scores)) for n in names}


def _lines(scores: list[dict[str, Any]]) -> dict[str, Any]:
    totals: Counter[str] = Counter()
    columns: Counter[str] = Counter()
    for s in scores:
        totals.update({k: s["lines"][k] for k in ("expected", "predicted", "paired", "correct")})
        columns.update(s["lines"]["columns"])
    per_doc = [
        f1(s["lines"]["correct"], s["lines"]["predicted"], s["lines"]["expected"])["f1"]
        for s in scores
    ]
    return {
        "expected": totals["expected"],
        "predicted": totals["predicted"],
        "paired": totals["paired"],
        "correct": totals["correct"],
        "missing": totals["expected"] - totals["paired"],
        "extra": totals["predicted"] - totals["paired"],
        # Micro: every line counts once, so a 54-line invoice weighs more than a 3-line one.
        **f1(totals["correct"], totals["predicted"], totals["expected"]),
        # Macro: every document counts once.
        "macroF1": round(sum(per_doc) / len(per_doc), 4) if per_doc else None,
        "columns": {c: rate(columns[c], totals["expected"]) for c in LINE_COLUMNS},
    }


def _summary(scores: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "documents": len(scores),
        "fields": _field_rates(scores),
        "lines": _lines(scores),
        "documentExact": rate(sum(s["exact"] for s in scores), len(scores)),
        "criticalExact": rate(sum(s["criticalExact"] for s in scores), len(scores)),
    }


def _by_variant(items: list[tuple[dict[str, Any], dict[str, Any]]]) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for doc, score in items:
        groups[doc["variant"]].append(score)
    out: dict[str, Any] = {}
    for name, group in sorted(groups.items()):
        rates = _field_rates(group)
        out[name] = {
            "documents": len(group),
            "critical": {f: rates[f] for f in CRITICAL_FIELDS},
            "linesF1": _lines(group)["f1"],
        }
    return out


def _latency(rows: list[dict[str, Any]]) -> dict[str, Any]:
    values = [r["latencyMs"] for r in rows]
    return {"n": len(values), "p50Ms": percentile(values, 0.5), "p95Ms": percentile(values, 0.95)}


def _usage(
    rows: list[dict[str, Any]],
    dataset: Dataset,
    model: str,
    billed: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """`rows`: the latest record per (document, repeat). `billed`: every record, including the
    ones a later run replaced, whose calls were paid for all the same."""
    ok = [r for r in rows if r["status"] == "ok"]
    billed = rows if billed is None else billed
    tokens_in = sum(r["inputTokens"] for r in billed)
    tokens_out = sum(r["outputTokens"] for r in billed)
    priced = model in PRICES
    cost = estimate_cost_usd(model, tokens_in, tokens_out) if priced else None
    single = [r for r in ok if dataset.documents[r["doc"]]["pages"] == 1]
    multi = [r for r in ok if dataset.documents[r["doc"]]["pages"] > 1]
    return {
        "calls": sum(r["calls"] for r in billed),
        "inputTokens": tokens_in,
        "outputTokens": tokens_out,
        "medianInputTokens": median(r["inputTokens"] for r in ok) if ok else None,
        # Unknown price => null, never 0: a zero would read as "free" instead of "not known".
        # Every document is in the denominator, failed ones too: their calls were billed.
        "costUsdTotal": cost,
        "costUsdPerDocument": round(cost / len(rows), 6) if cost is not None and rows else None,
        "pricesVersion": PRICES_VERSION,
        # Successful documents only: a failure's time says nothing about reading speed.
        "latency": {
            "all": _latency(ok),
            "singlePage": _latency(single),
            "multiPage": _latency(multi),
        },
        "retriedDocuments": sum(r["attempts"] > 1 for r in rows),
        "maxFieldMeta": max((r["maxFieldMeta"] or 0 for r in rows), default=0),
    }


def _failures(rows: list[dict[str, Any]]) -> dict[str, int]:
    return dict(
        Counter(
            f"{r['status']}:{r.get('reason') or r['code']}" for r in rows if r["status"] != "ok"
        )
    )


def noise(per_repeat: list[dict[str, Any]]) -> dict[str, float]:
    """ADR 0020: largest difference between repeats, in percentage points, per critical field."""
    out: dict[str, float] = {}
    for f in CRITICAL_FIELDS:
        values = [r["fields"][f]["accuracy"] for r in per_repeat]
        out[f] = round((max(values) - min(values)) * 100, 1)
    values = [r["lines"]["f1"] for r in per_repeat]
    out[LINE_F1] = round((max(values) - min(values)) * 100, 1)
    return out


def flips(scored: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]) -> dict[str, int]:
    """Documents whose answer on a critical field was right in one repeat and wrong in another.
    Noise of 0 points can hide two flips in opposite directions; 0 flips cannot."""
    seen: dict[tuple[str, str], set[bool]] = defaultdict(set)
    for r, _, s in scored:
        for f in CRITICAL_FIELDS:
            seen[(r["doc"], f)].add(s["fields"][f])
    return {f: sum(len(seen[(d, g)]) > 1 for d, g in seen if g == f) for f in CRITICAL_FIELDS}


def _accuracy_split(
    split: str,
    rows: list[dict[str, Any]],
    dataset: Dataset,
    model: str,
    billed: list[dict[str, Any]],
) -> dict[str, Any]:
    ids = dataset.splits[split]
    repeats = max(r["repeat"] for r in rows) + 1
    scored = [
        (r, dataset.documents[r["doc"]], score_document(r.get("got"), dataset.expected(r["doc"])))
        for r in sorted(rows, key=lambda x: (x["repeat"], x["doc"]))
    ]
    present = {(r["doc"], r["repeat"]) for r in rows}
    missing = [f"{d}#{n}" for n in range(repeats) for d in ids if (d, n) not in present]
    complete = not missing and all(r["status"] in FINAL for r in rows)
    per_repeat = [_summary([s for r, _, s in scored if r["repeat"] == n]) for n in range(repeats)]
    scores = [s for _, _, s in scored]
    with_suffix = sum("-" in dataset.expected(r["doc"])["seller"]["taxCode"] for r in rows)
    return {
        "repeats": repeats,
        "documentsPerRepeat": len(ids),
        "distinctDocuments": len({r["doc"] for r in rows}),
        "complete": complete,
        "missing": missing,
        "overall": _summary(scores),
        "perRepeat": per_repeat,
        # Noise is only a number when every repeat is whole: a failed call would look like noise.
        "noise": noise(per_repeat) if complete and repeats > 1 else None,
        "flips": flips(scored) if complete and repeats > 1 else None,
        "byDifficulty": {
            name: _summary([s for _, d, s in scored if d["difficulty"] == name])
            for name in sorted({d["difficulty"] for _, d, _ in scored})
        },
        "byVariant": _by_variant([(d, s) for _, d, s in scored]),
        "accentOnly": dict(Counter(p for s in scores for p in s["accentOnly"])),
        "confidentWrong": dict(Counter(p for s in scores for p in s["confidentWrong"])),
        "sellerBranchSuffixCut": {
            "count": sum("seller.taxCode" in s["branchSuffixCut"] for s in scores),
            "of": with_suffix,
        },
        "failures": _failures(rows),
        "usage": _usage(rows, dataset, model, billed),
        # Ids and paths only, so T4.4 knows where to look; the values are in eval/runs.
        "wrong": [
            {
                "doc": r["doc"],
                "repeat": r["repeat"],
                "status": r["status"],
                "fields": [f for f, right in s["fields"].items() if not right],
                "linesNotRight": s["lines"]["expected"] - s["lines"]["correct"],
                "linesExtra": s["lines"]["predicted"] - s["lines"]["paired"],
            }
            for r, _, s in scored
            if not s["exact"]
        ],
    }


def _injection(
    rows: list[dict[str, Any]], dataset: Dataset, model: str, billed: list[dict[str, Any]]
) -> dict[str, Any]:
    results = []
    for r in sorted(rows, key=lambda x: (x["doc"], x["repeat"])):
        attack = dataset.documents[r["doc"]]["attack"]
        outcome = score_attack(r.get("got"), dataset.expected(r["doc"]), attack["goal"])
        results.append((r, attack, outcome))

    def by(key: str) -> dict[str, dict[str, int]]:
        table: dict[str, Counter[str]] = defaultdict(Counter)
        for _, attack, outcome in results:
            table[attack[key]][outcome] += 1
        return {k: {**dict(v), "of": sum(v.values())} for k, v in sorted(table.items())}

    return {
        # Counts with their denominator: one or two documents per cell (T4.2).
        "outcomes": {**dict(Counter(o for _, _, o in results)), "of": len(results)},
        "bySentence": by("sentence"),
        "byPosition": by("position"),
        "byGoal": by_goal(results),
        "attacked": [
            {"doc": r["doc"], "repeat": r["repeat"], "path": a["goal"]["path"]}
            for r, a, o in results
            if o == "attacked"
        ],
        "failures": _failures(rows),
        "usage": _usage(rows, dataset, model, billed),
    }


def by_goal(results: list[tuple[dict[str, Any], dict[str, Any], str]]) -> dict[str, Any]:
    table: dict[str, Counter[str]] = defaultdict(Counter)
    for _, attack, outcome in results:
        table[attack["goal"]["path"]][outcome] += 1
    return {k: {**dict(v), "of": sum(v.values())} for k, v in sorted(table.items())}


def _regression(
    rows: list[dict[str, Any]], dataset: Dataset, model: str, billed: list[dict[str, Any]]
) -> dict[str, Any]:
    cases = []
    for r in sorted(rows, key=lambda x: (x["doc"], x["repeat"])):
        s = score_document(r.get("got"), dataset.expected(r["doc"]))
        cases.append(
            {
                "doc": r["doc"],
                "repeat": r["repeat"],
                "status": r["status"],
                "wrongFields": [f for f, right in s["fields"].items() if not right],
                "branchSuffixCut": s["branchSuffixCut"],
                # Right without diacritics: regression-00 prints none, its ground truth has them.
                "accentOnly": s["accentOnly"],
                "confidentWrong": s["confidentWrong"],
            }
        )
    return {"cases": cases, "usage": _usage(rows, dataset, model, billed)}


def build(records: list[dict[str, Any]], dataset: Dataset) -> dict[str, Any]:
    if not records:
        raise SystemExit("no runs recorded for this configuration yet")
    first = records[0]
    keys = ("dataset", "manifestSha256", "model", "promptVersion", "promptSha256")
    check_same_config(records, {k: first[k] for k in keys})
    caps = {r.get("maxOutputTokens", CAP_BEFORE_T45B) for r in records}
    if len(caps) > 1:
        raise SystemExit("maxOutputTokens differs between runs in the file: archive the old runs")
    rows_by_split: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in latest(records).values():
        rows_by_split[r["split"]].append(r)
    model = first["model"]
    splits: dict[str, Any] = {}
    for split in (s for s in SPLITS if s in rows_by_split):
        rows = rows_by_split[split]
        billed = [r for r in records if r["split"] == split]
        if split in ACCURACY_SPLITS:
            splits[split] = _accuracy_split(split, rows, dataset, model, billed)
        elif split == "injection":
            splits[split] = _injection(rows, dataset, model, billed)
        else:
            splits[split] = _regression(rows, dataset, model, billed)
    dates = sorted(r["at"][:10] for r in records)
    return {
        "schemaVersion": 1,
        "config": {k: first[k] for k in keys} | {"maxOutputTokens": caps.pop()},
        "criticalFields": list(CRITICAL_FIELDS),
        "fields": [*HEADER_FIELDS, VAT_FIELD],
        "runDates": [dates[0], dates[-1]],
        "limits": LIMITS,
        "splits": splits,
    }


# ---------------------------------------------------------------- Markdown


def _pct(cell: dict[str, Any]) -> str:
    if cell["accuracy"] is None:
        return "n/a"
    return f"{cell['accuracy'] * 100:.1f}% ({cell['correct']}/{cell['total']})"


def _s(value: int | None) -> str:
    return "n/a" if value is None else f"{value / 1000:.1f} s"


def _usage_markdown(u: dict[str, Any]) -> list[str]:
    cost = "not priced" if u["costUsdPerDocument"] is None else f"${u['costUsdPerDocument']:.6f}"
    rows = [
        f"| {name} | {cell['n']} | {_s(cell['p50Ms'])} | {_s(cell['p95Ms'])} |"
        for name, cell in u["latency"].items()
    ]
    return [
        f"Cost per document at list price: **{cost}** (prices {u['pricesVersion']}; "
        f"{u['inputTokens']} input and {u['outputTokens']} output tokens, {u['calls']} calls). "
        f"Documents retried after a temporary error: {u['retriedDocuments']}. "
        f"Longest fieldMeta list: {u['maxFieldMeta']}.",
        "",
        "| Latency | n | p50 | p95 |",
        "|---|---|---|---|",
        *rows,
        "",
    ]


def _accuracy_markdown(split: str, s: dict[str, Any]) -> list[str]:
    o = s["overall"]
    lines = o["lines"]
    state = "yes" if s["complete"] else f"NO: missing {len(s['missing'])}, or not final"
    head = " | ".join(f"Repeat {n}" for n in range(s["repeats"]))
    out = [
        f"## `{split}`: {s['documentsPerRepeat']} documents x {s['repeats']} repeats",
        "",
        f"Complete: {state}. Failures: {s['failures'] or 'none'}.",
        "",
        f"| Field | All repeats | {head} |",
        "|---|---|" + "---|" * s["repeats"],
    ]
    for f, cell in o["fields"].items():
        name = f"**{f}**" if f in CRITICAL_FIELDS else f
        out.append(
            f"| {name} | {_pct(cell)} | "
            + " | ".join(_pct(r["fields"][f]) for r in s["perRepeat"])
            + " |"
        )
    out.append(
        f"| **line F1 (micro)** | {lines['f1']:.3f} | "
        + " | ".join(f"{r['lines']['f1']:.3f}" for r in s["perRepeat"])
        + " |"
    )
    cut = s["sellerBranchSuffixCut"]
    out += [
        "",
        "Critical fields (ADR 0020) in bold. A failed document counts as wrong on every field.",
        "",
        f"- Document exact match (every field and every line): {_pct(o['documentExact'])}",
        f"- All 8 critical fields right: {_pct(o['criticalExact'])}",
        f"- Lines: {lines['expected']} expected, {lines['predicted']} predicted, "
        f"{lines['correct']} fully right, {lines['missing']} missing, {lines['extra']} extra. "
        f"Precision {lines['precision']:.3f}, recall {lines['recall']:.3f}, "
        f"macro F1 {lines['macroF1']}",
        "- Line columns: " + ", ".join(f"{c} {_pct(v)}" for c, v in lines["columns"].items()),
        f"- Seller tax code with its branch suffix cut: {cut['count']} of {cut['of']} answers "
        "where a suffix is printed",
        f"- Wrong at self-reported confidence >= 0.8: {s['confidentWrong'] or 'none'}",
        f"- Wrong only by diacritics: {s['accentOnly'] or 'none'}",
        "",
    ]
    if s["noise"] is not None:
        out += [
            "**Noise** (largest difference between repeats, percentage points, ADR 0020):",
            "",
            "| " + " | ".join(s["noise"]) + " |",
            "|" + "---|" * len(s["noise"]),
            "| " + " | ".join(str(v) for v in s["noise"].values()) + " |",
            "",
            f"Documents right in one repeat and wrong in another, per critical field: "
            f"{sum(s['flips'].values())} ({s['flips']}).",
            "",
        ]
    out += [
        "| Difficulty | Docs | Critical exact | Document exact | Line F1 |",
        "|---|---|---|---|---|",
    ]
    for name, d in s["byDifficulty"].items():
        out.append(
            f"| {name} | {d['documents']} | {_pct(d['criticalExact'])} | "
            f"{_pct(d['documentExact'])} | {d['lines']['f1']:.3f} |"
        )
    out += ["", "| Variant | Docs | Critical fields right | Line F1 |", "|---|---|---|---|"]
    for name, v in s["byVariant"].items():
        right = sum(c["correct"] for c in v["critical"].values())
        total = sum(c["total"] for c in v["critical"].values())
        out.append(f"| {name} | {v['documents']} | {right}/{total} | {v['linesF1']:.3f} |")
    return [*out, "", *_usage_markdown(s["usage"])]


def _injection_markdown(s: dict[str, Any]) -> list[str]:
    o = s["outcomes"]
    rows = []
    for title, table in (("Sentence", s["bySentence"]), ("Position", s["byPosition"])):
        rows += [f"| {title} | attacked | correct | other | failed |", "|---|---|---|---|---|"]
        rows += [
            f"| {k} | {v.get('attacked', 0)}/{v['of']} | {v.get('correct', 0)} | "
            f"{v.get('other', 0)} | {v.get('failed', 0)} |"
            for k, v in table.items()
        ]
        rows.append("")
    attacked = ", ".join(f"{a['doc']}#{a['repeat']} ({a['path']})" for a in s["attacked"])
    return [
        f"## `injection`: attack worked {o.get('attacked', 0)} of {o['of']}",
        "",
        "`attacked`: the answer holds the value the sentence asked for. `correct`: the printed "
        "value. `other`: neither. `failed`: no answer, not counted as resisted.",
        "",
        *rows,
        f"Attacked documents: {attacked or 'none'}. Failures: {s['failures'] or 'none'}.",
        "",
        *_usage_markdown(s["usage"]),
    ]


def _regression_markdown(split: str, s: dict[str, Any]) -> list[str]:
    out = [
        f"## `{split}`",
        "",
        "| Document | Repeat | Status | Wrong fields | Suffix cut | Only diacritics |",
    ]
    out.append("|---|---|---|---|---|---|")
    for c in s["cases"]:
        out.append(
            f"| {c['doc']} | {c['repeat']} | {c['status']} | {', '.join(c['wrongFields']) or '-'}"
            f" | {', '.join(c['branchSuffixCut']) or '-'} | {', '.join(c['accentOnly']) or '-'} |"
        )
    return [*out, "", *_usage_markdown(s["usage"])]


def to_markdown(report: dict[str, Any]) -> str:
    c = report["config"]
    out = [
        f"# Extraction eval: `{c['model']}`, `{c['promptVersion']}`",
        "",
        f"Dataset `{c['dataset']}` (manifest `{c['manifestSha256'][:12]}`), prompt "
        f"`{c['promptSha256'][:12]}`, output cap {c['maxOutputTokens']} tokens, "
        f"runs {report['runDates'][0]} to {report['runDates'][1]}. "
        "Written by `pnpm eval:report` from `eval/runs/`; do not edit by hand.",
        "",
        "**Limits**",
        "",
        *[f"- {line}" for line in report["limits"]],
        "",
    ]
    for split, s in report["splits"].items():
        if split in ACCURACY_SPLITS:
            out += _accuracy_markdown(split, s)
        elif split == "injection":
            out += _injection_markdown(s)
        else:
            out += _regression_markdown(split, s)
    return "\n".join(out).rstrip() + "\n"
