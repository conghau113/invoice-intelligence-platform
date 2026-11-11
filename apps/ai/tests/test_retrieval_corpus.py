"""The API's retrieval test (T5.3) reads chunks it cannot make itself (no Python there). This keeps
that file equal to what chunking makes today, so the hit@5 it measures is on real chunk text."""

import json

from scripts.export_retrieval_corpus import OUTPUT, build_corpus


def test_the_committed_corpus_is_what_chunking_makes_today() -> None:
    committed = json.loads(OUTPUT.read_text(encoding="utf-8"))
    assert committed == build_corpus(), (
        "chunking changed: run `uv run python -m scripts.export_retrieval_corpus` in apps/ai"
    )


def test_the_corpus_covers_the_core_split_with_a_header_first() -> None:
    corpus = build_corpus()
    assert len(corpus["invoices"]) == 100
    for invoice in corpus["invoices"]:
        assert invoice["chunks"][0]["kind"] == "header"
        assert [c["ordinal"] for c in invoice["chunks"]] == list(range(len(invoice["chunks"])))
