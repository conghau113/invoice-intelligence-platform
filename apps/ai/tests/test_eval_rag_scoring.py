"""RAG eval (T5.6) scoring, judge, hand sample and report on hand-made run records, with a
scripted provider: no network. Each metric is checked on a case where it must move, so a broken
rule fails."""

import json
from pathlib import Path
from typing import Any

import pytest
from rag import hand, judge, report, score
from rag.golden import Golden, Question
from runner.provider import Pacer, StopRun

from app.providers.base import LLMResult, LLMUnavailable
from app.providers.fake import FakeProvider

FAST = 600_000  # calls a minute: no pacing in tests

LOOKUP = Question(
    id="q01",
    lang="vi",
    kind="lookup",
    question="Hoá đơn X gồm gì?",
    tags=("no diacritics",),
    sources=("invoice-0017",),
    facts=(("R4052",), ("P9825",)),
)
AGG = Question(
    id="q17",
    lang="vi",
    kind="aggregate",
    question="Tháng 9 chi bao nhiêu?",
    tags=(),
    expect={"metric": "total", "sellers": ["Garcia"], "from": "2026-09-01", "to": "2026-09-30"},
)
GROUP = Question(
    id="q25",
    lang="vi",
    kind="aggregate",
    question="?",
    tags=(),
    expect={"metric": "total", "groupBy": "seller"},
    needs="groupBy",
)
REFUSE = Question(
    id="q27", lang="en", kind="refusal", question="?", tags=(), reasons=("OUT_OF_SCOPE",)
)
GOLDEN = Golden(today="2026-11-11", questions=(LOOKUP, AGG, GROUP, REFUSE))
INVOICES = {
    "invoice-0069": {
        "seller": {"name": "Garcia-Riley SAMPLE"},
        "issueDate": "2026-09-02",
        "currency": "USD",
        "total": 1689592,
        "lines": [],
        "vatBreakdown": [],
    }
}


def chunk(dataset_id: str, kind: str = "lines", content: str = "SAMPLE") -> dict[str, Any]:
    return {"datasetId": dataset_id, "kind": kind, "ordinal": 1, "content": content}


def ask(qid: str, outcome: str, repeat: int = 1, **over: Any) -> dict[str, Any]:
    """One recorded ask; routed as a lookup unless `route` says otherwise."""
    return {
        "type": "ask",
        "id": qid,
        "repeat": repeat,
        "outcome": outcome,
        "question": "?",
        "route": {"intent": "lookup", "filter": None},
        **over,
    }


def test_hit_at_5_looks_only_at_the_first_five_chunks() -> None:
    six = [chunk("invoice-0001")] * 5 + [chunk("invoice-0017")]
    assert not score.hit(six, ("invoice-0017",))
    assert score.hit(six[1:], ("invoice-0017",))


def test_a_lookup_answer_is_right_only_with_every_fact() -> None:
    rec = ask(
        "q01",
        "answer",
        answer="Gồm R4052 [1]. Còn P9825.",
        citations=[{"n": 1, "datasetId": "invoice-0017"}, {"n": 2, "datasetId": "invoice-0003"}],
        retrieved=[chunk("invoice-0003"), chunk("invoice-0017", "header")],
    )
    got = score.score_ask(LOOKUP, rec, INVOICES)
    assert got["correct"] and got["hit5"] and got["citesOrAbstains"]
    assert (got["citationsOfExpected"], got["citations"]) == (1, 2)
    assert (got["unmarkedSentences"], got["sentences"]) == (1, 2)
    assert got["expectedKinds"] == ["header"]
    partial = score.score_ask(LOOKUP, {**rec, "answer": "Gồm R4052 [1]."}, INVOICES)
    assert not partial["correct"] and partial["factsFound"] == 1


def test_an_answer_without_citations_neither_cites_nor_abstains() -> None:
    rec = ask("q01", "answer", answer="R4052 P9825", citations=[], retrieved=[])
    assert not score.score_ask(LOOKUP, rec, INVOICES)["citesOrAbstains"]


def test_an_aggregate_is_exact_only_when_count_and_every_currency_match() -> None:
    right = {"invoiceCount": 1, "results": [{"currency": "USD", "amount": 1689592}]}
    rec = ask(
        "q17", "aggregate", aggregate=right, citations=[{"n": 1}], route={"intent": "aggregate"}
    )
    assert score.score_ask(AGG, rec, INVOICES)["exact"]
    off = {**right, "results": [{"currency": "USD", "amount": 1689591}]}
    assert not score.score_ask(AGG, {**rec, "aggregate": off}, INVOICES)["exact"]
    refused = score.score_ask(AGG, ask("q17", "refusal", reason="NO_MATCHING_INVOICES"), INVOICES)
    assert not refused["exact"] and refused["got"] == "NO_MATCHING_INVOICES"


def test_an_aggregate_routed_as_a_lookup_is_wrong_but_still_cites() -> None:
    rec = ask(
        "q17", "answer", answer="Garcia [1].", citations=[{"n": 1}], route={"intent": "lookup"}
    )
    got = score.score_ask(AGG, rec, INVOICES)
    assert not got["exact"] and got["got"] == "answered as answer" and got["citesOrAbstains"]
    built = report.build(GOLDEN, score.score_run(GOLDEN, [rec], INVOICES), [rec], [], [], None)
    assert built["aggregate"]["wrong"] == ["r1/q17: got answered as answer, want 1 invoices"]


def test_group_by_questions_record_what_happened_without_a_score() -> None:
    got = score.score_ask(GROUP, ask("q25", "refusal", reason="ANSWER_REJECTED"), INVOICES)
    assert got["handledAs"] == "ANSWER_REJECTED" and "exact" not in got


def test_refusals_need_an_accepted_reason_and_unavailable_is_left_out() -> None:
    assert score.score_ask(REFUSE, ask("q27", "refusal", reason="OUT_OF_SCOPE"), INVOICES)[
        "correct"
    ]
    assert not score.score_ask(REFUSE, ask("q27", "refusal", reason="ANSWER_REJECTED"), INVOICES)[
        "correct"
    ]
    assert score.score_ask(REFUSE, ask("q27", "unavailable"), INVOICES)["unavailable"]


def test_the_seed_sweep_counts_hits_per_seed() -> None:
    records = [
        {"type": "retrieval", "seed": "s1", "id": "q01", "retrieved": [chunk("invoice-0017")]},
        {"type": "retrieval", "seed": "s2", "id": "q01", "retrieved": [chunk("invoice-0001")]},
    ]
    sweep = score.score_run(GOLDEN, records, INVOICES)["sweep"]
    assert sweep == {
        "s1": {"hits": 1, "questions": 1, "missed": []},
        "s2": {"hits": 0, "questions": 1, "missed": ["q01"]},
    }


# Judge -------------------------------------------------------------------------------------------


def test_a_judgement_must_cover_every_sentence_with_existing_sources() -> None:
    ok = json.dumps(
        {
            "sentences": [
                {"i": 0, "claim": True, "supportedBy": [2, 2]},
                {"i": 1, "claim": False, "supportedBy": []},
            ]
        }
    )
    assert judge.parse_judgement(ok, 2, 3) == [
        {"i": 0, "claim": True, "supportedBy": [2]},
        {"i": 1, "claim": False, "supportedBy": []},
    ]
    for bad in (
        "not json",
        json.dumps({"sentences": [{"i": 0, "claim": True, "supportedBy": []}]}),  # one missing
        json.dumps(
            {
                "sentences": [
                    {"i": 1, "claim": True, "supportedBy": []},
                    {"i": 0, "claim": True, "supportedBy": []},
                ]
            }
        ),
        json.dumps(
            {
                "sentences": [
                    {"i": 0, "claim": True, "supportedBy": [4]},
                    {"i": 1, "claim": False, "supportedBy": []},
                ]
            }
        ),
        json.dumps(
            {
                "sentences": [
                    {"i": 0, "claim": False, "supportedBy": [1]},
                    {"i": 1, "claim": False, "supportedBy": []},
                ]
            }
        ),
        json.dumps(
            {
                "sentences": [
                    {"i": 0, "claim": True, "supportedBy": [True]},
                    {"i": 1, "claim": False, "supportedBy": []},
                ]
            }
        ),
    ):
        assert judge.parse_judgement(bad, 2, 3) is None


ANSWERED = [
    ask(
        "q01",
        "answer",
        answer="A [1]. B [2].",
        retrieved=[chunk("invoice-0017", content="A"), chunk("invoice-0003", content="B")],
    ),
    ask("q27", "refusal", reason="OUT_OF_SCOPE"),
]


def test_the_judge_sees_the_sources_as_numbered_and_the_split_sentences() -> None:
    items = judge.judge_items(ANSWERED)
    assert [i["key"] for i in items] == ["r1/q01"]
    payload = items[0]["payload"]
    assert payload["sources"] == [{"n": 1, "content": "A"}, {"n": 2, "content": "B"}]
    assert payload["sentences"] == [
        {"i": 0, "text": "A [1].", "cites": [1]},
        {"i": 1, "text": "B [2].", "cites": [2]},
    ]


def _judgement(*items: tuple[bool, list[int]]) -> str:
    return json.dumps(
        {"sentences": [{"i": i, "claim": c, "supportedBy": s} for i, (c, s) in enumerate(items)]}
    )


def test_the_judge_records_retries_once_and_resumes(tmp_path: Path) -> None:
    out = tmp_path / "judgements.jsonl"
    items = judge.judge_items(ANSWERED)
    provider = FakeProvider(script=[LLMUnavailable(), _judgement((True, [1]), (True, []))])
    pauses: list[float] = []
    calls = judge.run_judge(
        provider,
        items,
        judge_pass=1,
        done=set(),
        out=out,
        pacer=Pacer(FAST),
        max_calls=5,
        sleep=pauses.append,
    )
    assert calls == 2 and pauses == [judge.RETRY_PAUSE_S]
    records = score.read_records(out)
    assert records[0]["sentences"][1] == {"i": 1, "claim": True, "supportedBy": []}
    assert "A [1]" not in out.read_text(encoding="utf-8")  # judgements hold indexes, never text
    again = judge.run_judge(
        provider,
        items,
        judge_pass=1,
        done=judge.judged_keys(records),
        out=out,
        pacer=Pacer(FAST),
        max_calls=5,
    )
    assert again == 0


def test_the_judge_stops_on_a_quota_and_records_an_invalid_output(tmp_path: Path) -> None:
    items = judge.judge_items(ANSWERED)
    with pytest.raises(StopRun):
        judge.run_judge(
            FakeProvider(script=[LLMUnavailable("LLM_RATE_LIMITED")]),
            items,
            judge_pass=1,
            done=set(),
            out=tmp_path / "j.jsonl",
            pacer=Pacer(FAST),
            max_calls=5,
        )
    judge.run_judge(
        FakeProvider(script=[LLMResult(text="{}", model="m", input_tokens=1, output_tokens=1)]),
        items,
        judge_pass=1,
        done=set(),
        out=tmp_path / "k.jsonl",
        pacer=Pacer(FAST),
        max_calls=5,
    )
    assert score.read_records(tmp_path / "k.jsonl")[0]["error"] == "JUDGE_OUTPUT_INVALID"


# Hand sample -------------------------------------------------------------------------------------


def test_the_hand_sample_is_fixed_by_rule_and_split_by_language() -> None:
    asks = [ask(f"v{i}", "answer", answer=f"S{i} [1].", retrieved=[chunk("x")]) for i in range(8)]
    asks += [ask(f"e{i}", "answer", answer=f"S{i} [1].", retrieved=[chunk("x")]) for i in range(8)]
    asks += [ask("v0", "answer", repeat=2, answer="S [1].", retrieved=[chunk("x")])]
    langs = {f"v{i}": "vi" for i in range(8)} | {f"e{i}": "en" for i in range(8)}
    first = hand.select(asks, langs)
    assert first == hand.select(list(reversed(asks)), langs)
    keys = [i["key"] for i in first]
    assert len(keys) == 10 and all(k.startswith("r1/") for k in keys)
    assert sum(langs[k.split("/")[1]] == "vi" for k in keys) == 5
    template = hand.template(first)
    assert template["samples"][0]["sentences"] == [{"i": 0, "verdict": None, "cites": {"1": None}}]
    assert "S" not in json.dumps(template["samples"])  # no answer text in the committed file


def test_unfinished_hand_labels_are_not_used(tmp_path: Path) -> None:
    path = tmp_path / "labels.json"
    path.write_text(
        json.dumps(
            {"samples": [{"key": "r1/q01", "sentences": [{"i": 0, "verdict": None, "cites": {}}]}]}
        )
    )
    assert hand.read_labels(path) == []
    path.write_text(
        json.dumps(
            {
                "samples": [
                    {"key": "r1/q01", "sentences": [{"i": 0, "verdict": "maybe", "cites": {}}]}
                ]
            }
        )
    )
    with pytest.raises(ValueError):
        hand.read_labels(path)


# Report ------------------------------------------------------------------------------------------


def test_wilson_interval_and_kappa() -> None:
    assert report.wilson(0, 0) is None
    low, high = report.wilson(9, 10)  # type: ignore[misc]
    assert 0.55 < low < 0.6 and 0.98 < high <= 1.0
    assert report.cohen_kappa(["a", "b", "a", "b"], ["a", "b", "a", "b"]) == 1.0
    assert report.cohen_kappa(["a", "b", "a", "b"], ["b", "a", "b", "a"]) == -1.0
    assert report.cohen_kappa(["a", "a"], ["a", "a"]) is None  # chance agreement is total


def test_the_report_pools_repeats_and_compares_judge_with_hand(tmp_path: Path) -> None:
    records = [
        {"type": "meta", "today": "2026-11-11", "repeats": 2},
        ask(
            "q01",
            "answer",
            1,
            answer="R4052 [1]. P9825.",
            citations=[{"n": 1, "datasetId": "invoice-0017"}],
            retrieved=[chunk("invoice-0017")],
            usage=[
                {
                    "step": "answer",
                    "model": "m",
                    "inputTokens": 10,
                    "outputTokens": 2,
                    "costUsd": 0.001,
                }
            ],
        ),
        ask("q01", "refusal", 2, reason="INSUFFICIENT_EVIDENCE", retrieved=[chunk("invoice-0001")]),
        ask("q17", "unavailable", 1),
        ask("q27", "refusal", 1, reason="OUT_OF_SCOPE"),
    ]
    judgements = [
        {
            "pass": 1,
            "key": "r1/q01",
            "judgeModel": "j",
            "sentences": [
                {"i": 0, "claim": True, "supportedBy": [1]},
                {"i": 1, "claim": True, "supportedBy": []},
            ],
        },
        {
            "pass": 2,
            "key": "r1/q01",
            "judgeModel": "j",
            "sentences": [
                {"i": 0, "claim": True, "supportedBy": [1]},
                {"i": 1, "claim": True, "supportedBy": [1]},
            ],
        },
    ]
    labels = [
        {
            "key": "r1/q01",
            "sentences": [
                {"i": 0, "verdict": "supported", "cites": {"1": True}},
                {"i": 1, "verdict": "supported", "cites": {}},
            ],
        }
    ]
    scored = score.score_run(GOLDEN, records, INVOICES)
    built = report.build(GOLDEN, scored, records, judgements, labels, None)
    assert built["unavailable"] == ["r1/q17"]
    assert built["retrieval"]["hit5"]["k"] == 1 and built["retrieval"]["hit5"]["n"] == 2
    assert built["retrieval"]["hit5"]["perRepeat"] == {"1": "1/1", "2": "0/1"}
    assert built["lookup"]["misses"]["missedRetrieval"] == {"q01": 1}
    jd = built["judge"]
    assert (jd["groundedness"]["k"], jd["groundedness"]["n"]) == (1, 2)
    assert (jd["citationPrecision"]["k"], jd["citationPrecision"]["n"]) == (1, 1)
    assert (jd["claimsWithoutMarker"]["k"], jd["claimsWithoutMarker"]["n"]) == (1, 2)
    assert jd["selfConsistency"]["sentences"]["k"] == 1
    assert jd["versusHand"]["sentences"]["k"] == 1
    assert jd["versusHand"]["disagreements"] == ["r1/q01#1: hand supported, judge unsupported"]
    assert built["usage"]["answer (m)"]["requests"] == 1
    text = report.to_markdown(built, "## Limits\n\nSAMPLE")
    assert "**1/2**" in text and "## Limits" in text and "$0" in text
    assert "R4052" not in text  # ids and numbers only, no answer text


def _one_answer_run() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    records = [
        {"type": "meta", "today": "2026-11-11", "repeats": 1},
        ask(
            "q01",
            "answer",
            1,
            answer="R4052 [1]. The sources do not say more [1].",
            citations=[{"n": 1, "datasetId": "invoice-0017"}],
            retrieved=[chunk("invoice-0017")],
        ),
    ]
    return records, score.score_run(GOLDEN, records, INVOICES)


def _judged(second_claims: bool) -> list[dict[str, Any]]:
    return [
        {
            "pass": 1,
            "key": "r1/q01",
            "judgeModel": "j",
            "sentences": [
                {"i": 0, "claim": True, "supportedBy": [1]},
                {"i": 1, "claim": second_claims, "supportedBy": []},
            ],
        }
    ]


def test_citation_precision_on_claims_leaves_out_markers_on_sentences_that_state_nothing() -> None:
    records, scored = _one_answer_run()
    jd = report.build(GOLDEN, scored, records, _judged(False), [], None)["judge"]
    assert (jd["citationPrecision"]["k"], jd["citationPrecision"]["n"]) == (1, 2)
    assert (jd["citationPrecisionOnClaims"]["k"], jd["citationPrecisionOnClaims"]["n"]) == (1, 1)


def test_the_blind_first_labels_are_reported_next_to_the_revised_ones(tmp_path: Path) -> None:
    path = tmp_path / "labels.json"
    revised = [
        {"i": 0, "verdict": "supported", "cites": {"1": True}},
        {"i": 1, "verdict": "no_claim", "cites": {"1": False}},
    ]
    path.write_text(
        json.dumps(
            {
                "samples": [{"key": "r1/q01", "sentences": revised}],
                "revisions": [
                    {
                        "key": "r1/q01",
                        "i": 1,
                        "blind": {"verdict": "supported", "cites": {"1": True}},
                    }
                ],
            }
        )
    )
    first, changed = hand.blind(path)
    assert changed == ["r1/q01#1"]
    assert first[0]["sentences"][1]["verdict"] == "supported"
    assert hand.read_labels(path)[0]["sentences"][1]["verdict"] == "no_claim"  # not mutated
    records, scored = _one_answer_run()
    built = report.build(
        GOLDEN,
        scored,
        records,
        _judged(False),
        hand.read_labels(path),
        None,
        blind_labels=first,
        revised=changed,
    )
    vh = built["judge"]["versusHand"]
    assert vh["sentences"]["k"] == 2 and vh["blind"]["sentences"]["k"] == 1
    text = report.to_markdown(built, "")
    assert "Blind first pass" in text and "r1/q01#1" in text


def test_a_revision_of_a_sentence_that_was_never_labelled_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "labels.json"
    path.write_text(
        json.dumps(
            {
                "samples": [
                    {"key": "r1/q01", "sentences": [{"i": 0, "verdict": "supported", "cites": {}}]}
                ],
                "revisions": [
                    {"key": "r1/q01", "i": 3, "blind": {"verdict": "supported", "cites": {}}}
                ],
            }
        )
    )
    with pytest.raises(ValueError, match="no such labelled sentence"):
        hand.blind(path)


def test_hand_labels_or_a_judgement_that_no_longer_fit_the_answer_stop_the_report() -> None:
    records, scored = _one_answer_run()
    labels = [{"key": "r1/q01", "sentences": [{"i": 0, "verdict": "supported", "cites": {}}]}]
    with pytest.raises(ValueError, match="hand labels do not match"):
        report.build(GOLDEN, scored, records, _judged(True), labels, None)
    short = [{**_judged(True)[0], "sentences": _judged(True)[0]["sentences"][:1]}]
    with pytest.raises(ValueError, match="judgement does not match"):
        report.build(GOLDEN, scored, records, short, [], None)


def test_a_resumed_ask_replaces_the_unavailable_one_and_both_count_as_requests() -> None:
    usage = [{"step": "classify", "model": "m", "inputTokens": 1, "outputTokens": 1}]
    records = [
        ask("q27", "unavailable", usage=usage),
        ask("q27", "refusal", reason="OUT_OF_SCOPE", usage=usage),
    ]
    assert [r["outcome"] for r in score.latest_asks(records)] == ["refusal"]
    built = report.build(GOLDEN, score.score_run(GOLDEN, records, INVOICES), records, [], [], None)
    assert built["unavailable"] == [] and built["refusal"]["correct"]["k"] == 1
    assert built["usage"]["classify (m)"]["requests"] == 2


def test_failed_attempts_tell_a_provider_503_from_an_api_timeout() -> None:
    records = [
        ask("q01", "answer", attempts=2, aiStatuses=[503, 200, 200]),
        ask("q17", "aggregate", attempts=2, aiStatuses=[200]),
        ask("q27", "unavailable", attempts=2, aiStatuses=[503, -1]),
        ask("q25", "refusal", attempts=1, aiStatuses=[200]),
    ]
    assert report._failed_attempts(records) == {
        "attempts": 4,
        "provider 5xx": 2,
        "no response (API timeout)": 2,
    }


def test_a_lookup_routed_away_is_a_routing_miss_not_a_retrieval_miss() -> None:
    away = ask("q01", "refusal", reason="OUT_OF_SCOPE", route={"intent": "out_of_scope"})
    got = score.score_ask(LOOKUP, away, INVOICES)
    assert got["hit5"] is None and got["routedAs"] == "out_of_scope"
    hit = ask("q01", "answer", 2, answer="R4052 P9825 [1].", retrieved=[chunk("invoice-0017")])
    records = [away, hit]
    built = report.build(GOLDEN, score.score_run(GOLDEN, records, INVOICES), records, [], [], None)
    assert (built["retrieval"]["hit5"]["k"], built["retrieval"]["hit5"]["n"]) == (1, 1)
    assert built["lookup"]["misses"]["routedAway"] == {"q01 (as out_of_scope)": 1}


def test_routing_counts_where_each_kind_of_question_went() -> None:
    records = [
        ask("q01", "refusal", reason="OUT_OF_SCOPE", route={"intent": "out_of_scope"}),
        ask("q17", "aggregate", route={"intent": "aggregate"}),
        ask("q25", "refusal", reason="OUT_OF_SCOPE", route={"intent": "out_of_scope"}),
        ask("q27", "unavailable"),
    ]
    assert report._routing(GOLDEN, records) == {
        "aggregate": {"aggregate": 1},
        "aggregate (needs groupBy)": {"out_of_scope": 1},
        "lookup": {"out_of_scope": 1},
    }


def test_a_rejudged_answer_replaces_the_invalid_judgement() -> None:
    first = {"pass": 1, "key": "r1/q01", "judgeModel": "j", "sentences": None}
    again = {**first, "sentences": [{"i": 0, "claim": True, "supportedBy": [1]}]}
    assert report.latest_judgements([first, again]) == [again]


def test_end_records_count_every_embedding_request_of_the_run() -> None:
    usage = [{"step": "embed", "model": "gemini-embedding-001", "texts": 1}]
    records = [
        ask("q01", "answer", usage=usage),
        {
            "type": "end",
            "chunkEmbedRequests": 9,
            "questionEmbedRequests": 17,
            "probeEmbedRequests": 1,
        },
        {
            "type": "end",
            "chunkEmbedRequests": 0,
            "questionEmbedRequests": 0,
            "probeEmbedRequests": 1,
        },
    ]
    steps = report._usage(records, [], [])
    assert "embed (gemini-embedding-001)" not in steps  # counted by the end records instead
    assert steps["embed, chunks + questions + model probe (end records)"]["requests"] == 28
