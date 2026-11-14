"""Deterministic scores of one recorded run (`eval/runs/rag/answers.jsonl`, written by the API
harness `apps/api/test/rag-eval.eval-spec.ts`). No model is called here.

Record types, one JSON object per line:
- `meta`: run settings (date, seeds, top-k, models seen in the AI service's usage).
- `retrieval`: one question of the hit@5 sweep (retrieval only, one per seed), the top-k in order.
- `ask`: one `POST /qa/ask` of one repeat: outcome, delivered answer and citations, the chunks this
  very ask retrieved (in the order the model saw them, source n = index + 1), the model's raw
  answer and route, and each AI call's usage.
"""

import json
from pathlib import Path
from typing import Any

from rag.golden import Golden, Question, oracle
from rag.text import facts_found, sentences


def read_records(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def hit(retrieved: list[dict[str, Any]], sources: tuple[str, ...], k: int = 5) -> bool:
    """A question hits when a chunk of an expected invoice is in the top k."""
    return any(c["datasetId"] in sources for c in retrieved[:k])


def _retrieved(rec: dict[str, Any]) -> bool:
    return (rec.get("route") or {}).get("intent") == "lookup"


def _lookup(q: Question, rec: dict[str, Any]) -> dict[str, Any]:
    answered = rec["outcome"] == "answer"
    text = rec.get("answer") or ""
    cited = rec.get("citations") or []
    found = facts_found(text, [list(g) for g in q.facts]) if answered else []
    split = sentences(text) if answered else []
    return {
        # None when the question never reached retrieval (routed out of scope or to the number
        # tool): that is a routing miss, not a retrieval miss, and stays out of hit@5.
        "hit5": hit(rec.get("retrieved") or [], q.sources) if _retrieved(rec) else None,
        "routedAs": (rec.get("route") or {}).get("intent"),
        "answered": answered,
        "correct": answered and all(found),
        "factsFound": sum(found),
        "factsTotal": len(q.facts),
        "citations": len(cited),
        "citationsOfExpected": sum(1 for c in cited if c.get("datasetId") in q.sources),
        "sentences": len(split),
        "unmarkedSentences": sum(1 for s in split if not s["cites"]),
        "citesOrAbstains": (answered and len(cited) > 0) or rec["outcome"] == "refusal",
        # Which chunks of the right invoice reached the model: only the header means a buyer or a
        # paraphrase matched the header, and the lines were never seen (T5.4 l03/l04).
        "expectedKinds": sorted(
            {c["kind"] for c in rec.get("retrieved") or [] if c["datasetId"] in q.sources}
        ),
    }


def _aggregate(q: Question, rec: dict[str, Any], invoices: dict[str, Any]) -> dict[str, Any]:
    got = rec.get("aggregate")
    out: dict[str, Any] = {
        # Routed as a lookup, an aggregate question gets a text answer: it still must cite.
        "citesOrAbstains": (
            rec["outcome"] in ("aggregate", "answer") and bool(rec.get("citations"))
        )
        or rec["outcome"] == "refusal",
        "route": (rec.get("route") or {}).get("intent"),
    }
    if q.needs:  # not answerable by the tool today: what the system did instead
        out["handledAs"] = rec["outcome"] if rec["outcome"] != "refusal" else rec.get("reason")
        return out
    want = oracle(q.expect, invoices)
    results = {r["currency"]: r["amount"] for r in got["results"]} if got else None
    out["exact"] = (
        got is not None
        and got["invoiceCount"] == want["invoiceCount"]
        and results == want["results"]
    )
    out["want"] = want
    if got:
        out["got"] = {"invoiceCount": got["invoiceCount"], "results": results}
    elif rec["outcome"] == "refusal":
        out["got"] = rec.get("reason")
    else:  # misrouted: a text answer cannot be an exact number (the model may not add up, T5.4)
        out["got"] = f"answered as {rec['outcome']}"
    return out


def _refusal(q: Question, rec: dict[str, Any]) -> dict[str, Any]:
    refused = rec["outcome"] == "refusal"
    return {
        "correct": refused and rec.get("reason") in q.reasons,
        "citesOrAbstains": refused or bool(rec.get("citations")),
        "got": rec.get("reason") if refused else rec["outcome"],
    }


def score_ask(q: Question, rec: dict[str, Any], invoices: dict[str, Any]) -> dict[str, Any]:
    base = {"id": q.id, "repeat": rec["repeat"], "kind": q.kind, "lang": q.lang}
    if rec["outcome"] == "unavailable":  # the provider failed twice: out of every denominator
        return {**base, "unavailable": True}
    if q.kind == "lookup":
        return {**base, **_lookup(q, rec)}
    if q.kind == "aggregate":
        return {**base, **_aggregate(q, rec, invoices)}
    return {**base, **_refusal(q, rec)}


def latest_asks(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One ask per repeat and question: the last one recorded. A resumed run (RAG_EVAL_RESUME)
    appends a new record for a question that was `unavailable`; the old one is replaced."""
    latest: dict[tuple[int, str], dict[str, Any]] = {}
    for r in records:
        if r.get("type") == "ask":
            latest[(r["repeat"], r["id"])] = r
    return [latest[k] for k in sorted(latest)]


def score_run(
    golden: Golden, records: list[dict[str, Any]], invoices: dict[str, Any]
) -> dict[str, Any]:
    by_id = golden.by_id()
    asks = latest_asks(records)
    scored = [score_ask(by_id[r["id"]], r, invoices) for r in asks]
    sweep: dict[str, dict[str, bool]] = {}
    for r in records:
        if r.get("type") == "retrieval":
            sweep.setdefault(r["seed"], {})[r["id"]] = hit(r["retrieved"], by_id[r["id"]].sources)
    return {
        "asks": scored,
        "sweep": {
            seed: {
                "hits": sum(h.values()),
                "questions": len(h),
                "missed": sorted(i for i, ok in h.items() if not ok),
            }
            for seed, h in sweep.items()
        },
    }
