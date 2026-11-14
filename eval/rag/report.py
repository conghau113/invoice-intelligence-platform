"""`eval/reports/rag-v1.{json,md}` from the recorded run, the judgements and the hand labels.

Ids and numbers only: no question text, answer, source or amount reaches the report (the run files
hold them and are git-ignored), as for the extraction reports (AI_PIPELINE.md section 6).
"""

import math
from collections import Counter, defaultdict
from typing import Any

from rag import score
from rag.golden import Golden
from rag.judge import verdict
from rag.text import sentences

TAGS = ("no diacritics", "buyer name", "cross-language", "number", "no code")


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    """95% Wilson interval of a proportion: honest for small n, unlike k/n ± 2 standard errors."""
    if n == 0:
        return None
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (round(max(0.0, centre - half), 3), round(min(1.0, centre + half), 3))


def ratio(k: int, n: int) -> dict[str, Any]:
    return {"k": k, "n": n, "rate": round(k / n, 3) if n else None, "ci95": wilson(k, n)}


def cohen_kappa(a: list[str], b: list[str]) -> float | None:
    """Agreement beyond chance between two labellers; None when chance agreement is total."""
    n = len(a)
    if n == 0 or n != len(b):
        return None
    observed = sum(x == y for x, y in zip(a, b, strict=True)) / n
    ca, cb = Counter(a), Counter(b)
    expected = sum(ca[c] * cb[c] for c in set(a) | set(b)) / (n * n)
    if expected == 1:
        return None
    return round((observed - expected) / (1 - expected), 3)


def _per_repeat(rows: list[dict[str, Any]], num: str, den: str | None = None) -> dict[str, Any]:
    """Pooled over repeats, plus the value of each repeat (how much a run moves)."""
    by_repeat: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    for r in rows:
        k = int(r[num]) if den is None else r[num]
        n = 1 if den is None else r[den]
        by_repeat[r["repeat"]][0] += k
        by_repeat[r["repeat"]][1] += n
    total = [sum(v[0] for v in by_repeat.values()), sum(v[1] for v in by_repeat.values())]
    return {
        **ratio(total[0], total[1]),
        "perRepeat": {str(rep): f"{v[0]}/{v[1]}" for rep, v in sorted(by_repeat.items())},
    }


def latest_judgements(judgements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One judgement per pass and answer: the last one. A rerun judges again what was invalid."""
    latest = {(j["pass"], j["key"]): j for j in judgements}
    return [latest[k] for k in sorted(latest)]


def _judge_stats(judgements: list[dict[str, Any]], asks: list[dict[str, Any]]) -> dict[str, Any]:
    cites_of = {f"r{r['repeat']}/{r['id']}": r for r in asks if r["outcome"] == "answer"}
    rows = []
    invalid = 0
    for j in (j for j in judgements if j["pass"] == 1):
        if j["sentences"] is None:
            invalid += 1
            continue
        if j["key"] not in cites_of:
            raise ValueError(f"{j['key']}: judged, but no longer an answer in the run file")
        split = sentences(cites_of[j["key"]]["answer"])
        if len(split) != len(j["sentences"]):
            raise ValueError(f"{j['key']}: judgement does not match the current answer")
        repeat = int(j["key"][1 : j["key"].index("/")])
        claims = [s for s in j["sentences"] if s["claim"]]
        cites = [(n, s) for s, sp in zip(j["sentences"], split, strict=True) for n in sp["cites"]]
        rows.append(
            {
                "repeat": repeat,
                "claims": len(claims),
                "supported": sum(1 for s in claims if s["supportedBy"]),
                "cites": len(cites),
                "citesSupporting": sum(1 for n, s in cites if n in s["supportedBy"]),
                "citesOnClaims": sum(1 for _, s in cites if s["claim"]),
                "claimsUnmarked": sum(
                    1
                    for s, sp in zip(j["sentences"], split, strict=True)
                    if s["claim"] and not sp["cites"]
                ),
                "claimsUnmarkedSupported": sum(
                    1
                    for s, sp in zip(j["sentences"], split, strict=True)
                    if s["claim"] and not sp["cites"] and s["supportedBy"]
                ),
            }
        )
    return {
        "judged": len(rows),
        "invalid": invalid,
        "errors": dict(
            Counter(j["error"] for j in judgements if j["pass"] == 1 and j.get("error"))
        ),
        "groundedness": _per_repeat(rows, "supported", "claims"),
        "citationPrecision": _per_repeat(rows, "citesSupporting", "cites"),
        # Same, leaving out markers on sentences the judge says state nothing (a "the sources do
        # not say" sentence that still carries `[1]`): those can never be supported.
        "citationPrecisionOnClaims": _per_repeat(rows, "citesSupporting", "citesOnClaims"),
        "claimsWithoutMarker": _per_repeat(rows, "claimsUnmarked", "claims"),
        "claimsWithoutMarkerSupported": sum(r["claimsUnmarkedSupported"] for r in rows),
    }


def _wrong_aggregate(s: dict[str, Any]) -> str:
    """Counts and reasons only: the amounts stay in the run file."""
    got = s["got"] if isinstance(s["got"], str) else f"{s['got']['invoiceCount']} invoices"
    return f"r{s['repeat']}/{s['id']}: got {got}, want {s['want']['invoiceCount']} invoices"


def _labels_of(judgement: dict[str, Any]) -> list[str]:
    return [verdict(s) for s in judgement["sentences"]]


def _self_consistency(judgements: list[dict[str, Any]]) -> dict[str, Any]:
    first = {j["key"]: j for j in judgements if j["pass"] == 1 and j["sentences"] is not None}
    second = {j["key"]: j for j in judgements if j["pass"] == 2 and j["sentences"] is not None}
    a: list[str] = []
    b: list[str] = []
    for key in sorted(first.keys() & second.keys()):
        a += _labels_of(first[key])
        b += _labels_of(second[key])
    same = sum(x == y for x, y in zip(a, b, strict=True))
    return {
        "answers": len(first.keys() & second.keys()),
        "sentences": ratio(same, len(a)),
        "kappa": cohen_kappa(a, b),
    }


def _grounded(labels: list[str]) -> dict[str, Any]:
    return ratio(
        sum(1 for x in labels if x == "supported"), sum(1 for x in labels if x != "no_claim")
    )


def _versus_hand(judgements: list[dict[str, Any]], labels: list[dict[str, Any]]) -> dict[str, Any]:
    if not labels:
        return {"status": "no hand labels yet"}
    first = {j["key"]: j for j in judgements if j["pass"] == 1 and j["sentences"] is not None}
    human: list[str] = []
    model: list[str] = []
    cite_same = cite_total = 0
    disagreements = []
    for sample in labels:
        j = first.get(sample["key"])
        if j is None:
            continue
        if [h["i"] for h in sample["sentences"]] != [m["i"] for m in j["sentences"]]:
            raise ValueError(f"{sample['key']}: hand labels do not match the current answer")
        for h, m in zip(sample["sentences"], j["sentences"], strict=True):
            human.append(h["verdict"])
            model.append(verdict(m))
            if h["verdict"] != verdict(m):
                disagreements.append(
                    f"{sample['key']}#{h['i']}: hand {h['verdict']}, judge {verdict(m)}"
                )
            for n, ok in h["cites"].items():
                cite_total += 1
                cite_same += ok == (int(n) in m["supportedBy"])
    return {
        "samples": len(labels),
        "sentences": ratio(sum(x == y for x, y in zip(human, model, strict=True)), len(human)),
        "kappa": cohen_kappa(human, model),
        "cites": ratio(cite_same, cite_total),
        "groundednessByHand": _grounded(human),
        "groundednessByJudge": _grounded(model),
        "disagreements": disagreements,
    }


def _routing(golden: Golden, asks: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """Where the routing step sent each kind of question (`none`: the model's route was invalid or
    the ask failed before routing)."""
    kinds = {q.id: (q.kind + (" (needs groupBy)" if q.needs else "")) for q in golden.questions}
    table: dict[str, Counter[str]] = defaultdict(Counter)
    for r in asks:
        if r["outcome"] != "unavailable":
            table[kinds[r["id"]]][(r.get("route") or {}).get("intent") or "none"] += 1
    return {kind: dict(sorted(c.items())) for kind, c in sorted(table.items())}


def _failed_attempts(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Why an attempt of an ask failed. The API answers 503 both when the AI service answered 503
    (provider overloaded) and when its own 30 s timeout per model call fired (no response)."""
    causes: Counter[str] = Counter()
    for r in records:
        if r.get("type") != "ask":
            continue
        failed = r.get("attempts", 1) - (0 if r["outcome"] == "unavailable" else 1)
        statuses = r.get("aiStatuses") or []
        provider = sum(1 for st in statuses if st >= 500)
        causes["provider 5xx"] += min(provider, failed)
        causes["no response (API timeout)"] += failed - min(provider, failed)
    return {"attempts": sum(causes.values()), **dict(causes)}


def _usage(
    records: list[dict[str, Any]],
    judgements: list[dict[str, Any]],
    discarded: list[dict[str, Any]],
) -> dict[str, Any]:
    steps: dict[str, dict[str, Any]] = {}
    for r in records:
        for u in r.get("usage") or []:
            s = steps.setdefault(
                f"{u['step']} ({u['model']})",
                {"requests": 0, "inputTokens": 0, "outputTokens": 0, "listPriceUsd": 0.0},
            )
            s["requests"] += 1
            s["inputTokens"] += u.get("inputTokens") or 0
            s["outputTokens"] += u.get("outputTokens") or 0
            s["listPriceUsd"] += u.get("costUsd") or 0.0
    ends = [r for r in records if r.get("type") == "end"]
    if ends:
        # Question embeddings made inside an ask are already counted in its usage; the end record
        # counts every one the run made (cache misses), so the ask-level rows are replaced.
        steps.pop("embed (gemini-embedding-001)", None)
        steps["embed, chunks + questions + model probe (end records)"] = {
            "requests": sum(
                e["chunkEmbedRequests"] + e["questionEmbedRequests"] + e["probeEmbedRequests"]
                for e in ends
            ),
            "inputTokens": None,
            "outputTokens": None,
            "listPriceUsd": None,
        }
    for label, group in (("judge", judgements), ("judge, discarded best-effort run", discarded)):
        for j in group:
            s = steps.setdefault(
                f"{label} ({j['judgeModel']})",
                {"requests": 0, "inputTokens": 0, "outputTokens": 0, "listPriceUsd": None},
            )
            s["requests"] += 1
            s["inputTokens"] += j.get("inputTokens") or 0
            s["outputTokens"] += j.get("outputTokens") or 0
    for s in steps.values():
        if s["listPriceUsd"] is not None:
            s["listPriceUsd"] = round(s["listPriceUsd"], 4)
    return steps


def build(
    golden: Golden,
    scored: dict[str, Any],
    records: list[dict[str, Any]],
    judgements: list[dict[str, Any]],
    labels: list[dict[str, Any]],
    tokens: dict[str, Any] | None,
    discarded: list[dict[str, Any]] | None = None,
    blind_labels: list[dict[str, Any]] | None = None,
    revised: list[str] | None = None,
) -> dict[str, Any]:
    """`discarded`: judge calls of a run that was set aside, counted in the usage table only.

    `blind_labels`: the hand labels as first given, before any revision made after a report had
    shown the judge's verdicts; `revised` names the sentences changed since (`hand.blind`).
    """
    asks = score.latest_asks(records)
    meta = next((r for r in records if r.get("type") == "meta"), {})
    rows = [s for s in scored["asks"] if not s.get("unavailable")]
    lookups = [s for s in rows if s["kind"] == "lookup"]
    aggs = [s for s in rows if s["kind"] == "aggregate" and "exact" in s]
    group_by = [s for s in rows if s["kind"] == "aggregate" and "handledAs" in s]
    refusals = [s for s in rows if s["kind"] == "refusal"]
    tags = golden.by_id()
    by_tag = {}
    for tag in TAGS:
        tagged = [s for s in lookups if tag in tags[s["id"]].tags]
        by_tag[tag] = {
            "questions": sorted({s["id"] for s in tagged}),
            "hit5": _per_repeat([s for s in tagged if s["hit5"] is not None], "hit5"),
            "correct": _per_repeat(tagged, "correct"),
        }
    misses: dict[str, Counter[str]] = defaultdict(Counter)
    for s in lookups:
        if s["hit5"] is None:
            misses["routedAway"][f"{s['id']} (as {s['routedAs']})"] += 1
        elif not s["hit5"]:
            misses["missedRetrieval"][s["id"]] += 1
        elif not s["answered"]:
            kinds = "+".join(s["expectedKinds"]) or "none"
            misses["refusedAfterHit"][f"{s['id']} (expected invoice chunks: {kinds})"] += 1
        elif not s["correct"]:
            misses["answeredIncomplete"][
                f"{s['id']} ({s['factsFound']}/{s['factsTotal']} facts)"
            ] += 1
    by_lang = {
        lang: {
            "lookupCorrect": _per_repeat([s for s in lookups if s["lang"] == lang], "correct"),
            "aggregateExact": _per_repeat([s for s in aggs if s["lang"] == lang], "exact"),
        }
        for lang in ("vi", "en")
    }
    return {
        "dataset": "eval/datasets/v1 split core (100 invoices, 223 chunks)",
        "golden": "eval/rag/golden-v1.json",
        "run": {
            k: meta.get(k)
            for k in ("startedAt", "today", "repeats", "seeds", "topK", "candidates", "embedModel")
        },
        "questions": {
            "total": len(golden.questions),
            "byKind": dict(Counter(q.kind for q in golden.questions)),
            "byLang": dict(Counter(q.lang for q in golden.questions)),
            "needGroupBy": sorted(q.id for q in golden.questions if q.needs == "groupBy"),
        },
        "unavailable": sorted(
            f"r{s['repeat']}/{s['id']}" for s in scored["asks"] if s.get("unavailable")
        ),
        "retrieval": {
            "hit5": _per_repeat([s for s in lookups if s["hit5"] is not None], "hit5"),
            "seedSweep": scored["sweep"],
        },
        "lookup": {
            "answered": _per_repeat(lookups, "answered"),
            "correct": _per_repeat(lookups, "correct"),
            "citationsOfExpectedInvoice": _per_repeat(lookups, "citationsOfExpected", "citations"),
            "sentencesWithoutMarker": _per_repeat(lookups, "unmarkedSentences", "sentences"),
            "byTag": by_tag,
            "misses": {k: dict(sorted(v.items())) for k, v in misses.items()},
        },
        "aggregate": {
            "exact": _per_repeat(aggs, "exact"),
            "wrong": sorted(_wrong_aggregate(s) for s in aggs if not s["exact"]),
            "groupBy": sorted(f"r{s['repeat']}/{s['id']}: {s['handledAs']}" for s in group_by),
        },
        "refusal": {
            "correct": _per_repeat(refusals, "correct"),
            "wrong": sorted(
                f"r{s['repeat']}/{s['id']}: {s['got']}" for s in refusals if not s["correct"]
            ),
        },
        "citesOrAbstains": _per_repeat(
            [s for s in rows if "citesOrAbstains" in s], "citesOrAbstains"
        ),
        "byLang": by_lang,
        "judge": {
            "model": sorted({j["judgeModel"] for j in judgements}),
            **_judge_stats(latest_judgements(judgements), asks),
            "selfConsistency": _self_consistency(judgements),
            "versusHand": {
                **_versus_hand(judgements, labels),
                "blind": _versus_hand(judgements, blind_labels or []),
                "revised": revised or [],
            },
        },
        "embeddingTokens": tokens,
        "usage": _usage(records, judgements, discarded or []),
        "failedAttempts": _failed_attempts(records),
        "routing": _routing(golden, asks),
    }


def _na(value: Any) -> str:
    return "n/a" if value is None else str(value)


def _fmt(r: dict[str, Any] | None) -> str:
    if not r or r.get("n") in (None, 0):
        return "n/a"
    ci = r.get("ci95")
    ci_text = f" (95% CI {ci[0]:.2f}–{ci[1]:.2f})" if ci else ""
    reps = r.get("perRepeat")
    rep_text = f"; per repeat {', '.join(reps.values())}" if reps and len(reps) > 1 else ""
    return f"**{r['k']}/{r['n']}** = {r['rate']:.2f}{ci_text}{rep_text}"


def to_markdown(rep: dict[str, Any], limits: str) -> str:
    lk, ag, jd = rep["lookup"], rep["aggregate"], rep["judge"]
    errors = f" {jd['errors']}" if jd["errors"] else ""
    run = rep["run"]
    qs = rep["questions"]
    sc = jd["selfConsistency"]
    sweep = rep["retrieval"]["seedSweep"]
    lines = [
        "# RAG evaluation v1 (T5.6)",
        "",
        f"Dataset: {rep['dataset']}. Golden set: `{rep['golden']}` "
        f"({qs['total']} questions: {qs['byKind']}, {qs['byLang']}). "
        f"Today for the questions: {run['today']}. Repeats: {run['repeats']}. "
        f"Top-k {run['topK']}, {run['candidates']} candidates per list. "
        f"Embedding model: `{run['embedModel']}`. Run started {run['startedAt']}.",
        "",
        "Rates are pooled over repeats with a 95% Wilson interval; the per-repeat counts show "
        "how much "
        "one run moves. Questions the provider could not answer twice in a row are out of every "
        f"denominator: {', '.join(rep['unavailable']) or 'none'}.",
        "",
        "## Headline",
        "",
        "| Metric | Value |",
        "|---|---|",
        "| Retrieval hit@5 (lookups, retrieval of the ask itself) | "
        f"{_fmt(rep['retrieval']['hit5'])} |",
        "| Citation precision, judge (each `[n]` whose source states the sentence) | "
        f"{_fmt(jd['citationPrecision'])} |",
        "| Citations pointing at a chunk of the expected invoice (rule) | "
        f"{_fmt(lk['citationsOfExpectedInvoice'])} |",
        f"| Numbers exact, aggregates (oracle from expected.json) | {_fmt(ag['exact'])} |",
        f"| Lookup answers with every expected fact (rule) | {_fmt(lk['correct'])} |",
        "| Groundedness, judge (fact sentences a source supports; an upper bound, see Limits) | "
        f"{_fmt(jd['groundedness'])} |",
        f"| Right refusals | {_fmt(rep['refusal']['correct'])} |",
        f"| Every answer cites or abstains (NFR-07) | {_fmt(rep['citesOrAbstains'])} |",
        "",
        "## Routing",
        "",
        "Where the routing step (`qa_route/v1`) sent each kind of question, over all repeats:",
        "",
        "| Golden kind | Routed as |",
        "|---|---|",
        *[
            f"| {kind} | {', '.join(f'{k} {v}' for k, v in c.items())} |"
            for kind, c in rep["routing"].items()
        ],
        "",
        "## Retrieval",
        "",
        "hit@5 over seeds (retrieval only, same vectors, ids derived from the seed: ties are "
        "broken by id, T5.3):",
        "",
        "| Seed | Hits | Missed |",
        "|---|---|---|",
        *[
            f"| `{seed}` | {s['hits']}/{s['questions']} | {', '.join(s['missed']) or '—'} |"
            for seed, s in sweep.items()
        ],
        "",
        "## Lookup answers",
        "",
        f"- Answered: {_fmt(lk['answered'])}; with every expected fact: {_fmt(lk['correct'])}.",
        f"- Sentences without any `[n]` (rule): {_fmt(lk['sentencesWithoutMarker'])}.",
        "",
        "| Tag | Questions | hit@5 | Right answer |",
        "|---|---|---|---|",
        *[
            f"| {tag} | {', '.join(t['questions'])} | {_fmt(t['hit5'])} | {_fmt(t['correct'])} |"
            for tag, t in lk["byTag"].items()
        ],
        "",
        "Misses (question: how many repeats):",
        "",
        *[
            f"- {kind}: " + (", ".join(f"{k} ×{v}" for k, v in m.items()) or "none")
            for kind, m in lk["misses"].items()
        ],
        "",
        "## Aggregates",
        "",
        f"- Exact: {_fmt(ag['exact'])}.",
        *[f"- Wrong: {w}" for w in ag["wrong"]],
        f"- Questions that need a group-by ({', '.join(qs['needGroupBy'])}), handled as: "
        + (", ".join(ag["groupBy"]) or "n/a"),
        "",
        "## Refusals",
        "",
        f"- Right refusals: {_fmt(rep['refusal']['correct'])}. "
        f"Wrong: {', '.join(rep['refusal']['wrong']) or 'none'}.",
        "",
        "## By language",
        "",
        "| Language | Lookup right | Aggregate exact |",
        "|---|---|---|",
        *[
            f"| {lang} | {_fmt(v['lookupCorrect'])} | {_fmt(v['aggregateExact'])} |"
            for lang, v in rep["byLang"].items()
        ],
        "",
        "## LLM-as-judge",
        "",
        f"Judge: {', '.join(f'`{m}`' for m in jd['model']) or 'not run'}, prompt `rag_judge/v1`. "
        f"Answers judged (pass 1): {jd['judged']}; without a valid judgement after reruns: "
        f"{jd['invalid']}{errors}.",
        "",
        f"- Groundedness: {_fmt(jd['groundedness'])}.",
        f"- Citation precision: {_fmt(jd['citationPrecision'])}; leaving out markers on sentences "
        f"the judge says state nothing: {_fmt(jd['citationPrecisionOnClaims'])}. The judge counts "
        "every `[n]` in every sentence; the rule in the headline counts the citations the API "
        "delivered with each answer, so the two denominators differ.",
        f"- Fact sentences without a marker: {_fmt(jd['claimsWithoutMarker'])} "
        f"({jd['claimsWithoutMarkerSupported']} of them still supported by a source).",
        f"- Self-consistency (repeat 1 judged twice, {sc['answers']} answers): same label on "
        f"{_fmt(sc['sentences'])} sentences, Cohen's kappa {sc['kappa']}.",
        "",
        "Judge versus hand labels: every answered lookup of repeat 1 (10 answers, fixed before the "
        "judge ran), labelled by one person from a sheet without the judge's verdicts. Repeats 2 "
        "and 3 are not in the sample.",
        "",
    ]
    vh = jd["versusHand"]
    if "status" in vh:
        lines.append(f"- {vh['status']}.")
    else:
        blind = vh["blind"]
        if vh["revised"] and "status" not in blind:
            lines += [
                f"- Blind first pass: same sentence label {_fmt(blind['sentences'])}, Cohen's "
                f"kappa {blind['kappa']}; same verdict on each `[n]` {_fmt(blind['cites'])}; "
                f"disagreements: {'; '.join(blind['disagreements']) or 'none'}.",
                f"- Revised after the first report had shown the judge's verdicts "
                f"({', '.join(vh['revised'])}), so the lines below are not blind and are an "
                "upper bound:",
            ]
        lines += [
            f"- Same sentence label: {_fmt(vh['sentences'])}; Cohen's kappa {vh['kappa']}.",
            f"- Same verdict on each `[n]`: {_fmt(vh['cites'])}.",
            f"- Groundedness on these samples: by hand {_fmt(vh['groundednessByHand'])}, "
            f"by the judge {_fmt(vh['groundednessByJudge'])}.",
            f"- Disagreements: {'; '.join(vh['disagreements']) or 'none'}.",
        ]
    fa = rep["failedAttempts"]
    lines += [
        "",
        limits.strip(),
        "",
        "## Requests",
        "",
        f"Failed attempts of `POST /qa/ask` (retried once, then `unavailable`): {fa['attempts']}; "
        f"{fa.get('provider 5xx', 0)} answered 5xx by the AI service (provider overloaded), "
        f"{fa.get('no response (API timeout)', 0)} without a response (the API's 30 s timeout per "
        "model call; the AI service may still finish and spend the call).",
        "",
    ]
    tok = rep.get("embeddingTokens")
    if tok:
        lines += [
            "Embedding input size (Phát sinh T5.2): `countTokens` on the "
            f"{len(tok['chunks'])} longest chunk texts as sent "
            f"(cut at {tok['cutAt']} characters), model `{tok['model']}`: "
            + ", ".join(f"{c['chars']} chars → {c['tokens']} tokens" for c in tok["chunks"])
            + f"; limit {tok['limit']} tokens.",
            "",
        ]
    lines += [
        "| Step (model) | Requests | Input tokens | Output tokens | List price if paid (USD) |",
        "|---|---|---|---|---|",
        *[
            f"| {step} | {u['requests']} | {_na(u['inputTokens'])} | {_na(u['outputTokens'])} | "
            f"{'n/a' if u['listPriceUsd'] is None else u['listPriceUsd']} |"
            for step, u in rep["usage"].items()
        ],
        "",
        "Amount actually paid: **$0**. Every call ran on free tiers (Gemini API without a "
        "billing account, Groq Free plan); the billing pages were checked before and after the "
        "run (docs/learning/T5.6-task-notes.md). "
        "The list price column is what the same tokens would cost on a paid plan, not money spent. "
        "Requests retried by the harness count twice.",
        "",
    ]
    return "\n".join(lines)
