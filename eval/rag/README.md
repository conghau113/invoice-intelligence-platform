# RAG evaluation (T5.6)

Measures the Q&A pipeline of M5 (retrieval, routing, cited answers, the SQL number tool) on 30
golden questions, with real models, by hand. Never in CI: it spends free-tier quota (CLAUDE.md:
only `eval/` calls real models). Report: `eval/reports/rag-v1.md`.

## What is measured

| Metric | How | Decided by |
|---|---|---|
| Retrieval hit@5 | a chunk of an expected invoice is in the top 5 that the ask itself retrieved; also once per seed (ids from the seed, ties broken by id) | rule |
| Citation precision | each `[n]` whose source states the whole sentence it is on | LLM judge |
| Citations of the expected invoice | each `[n]` pointing at a chunk of an expected invoice | rule |
| Numbers exact | aggregate count and every per-currency sum equal the oracle (`golden.py`, computed from `expected.json`, not from SQL) | rule |
| Lookup answer right | every group of `facts` has one alternative in the answer (`text.py`: separators and case ignored, diacritics kept) | rule |
| Groundedness | fact sentences that at least one source supports | LLM judge |
| Judge vs hand | sentence labels and `[n]` verdicts of 10 answers labelled blind by a person; agreement and Cohen's kappa | person |
| Judge self-consistency | repeat 1 judged twice | LLM judge |
| Cites or abstains (NFR-07) | every outcome is a refusal or carries citations | rule |

Rates are pooled over repeats and given with their denominator and a 95% Wilson interval. A
question the provider fails twice is left out of every denominator and listed.

## Run it

```bash
# 0. Check the billing pages show $0 (AI Studio: no billing account; Groq: Free plan).
# 1. The AI service with Gemini (pnpm dev:ai or pnpm dev:stack), then, from the repo root:
RAG_EVAL_AI_URL=http://127.0.0.1:8000 pnpm eval:rag:run        # Docker needed (Testcontainers)
# 2. Fix the 10 hand samples BEFORE the judge runs; label eval/rag/hand-labels-v1.json from
#    eval/runs/rag/hand-sheet.md without looking at the judge.
pnpm eval:rag:sheet
# 3. The judge (Groq), configured by its own variables in apps/ai's env file (or the environment):
#    RAG_JUDGE_BASE_URL=https://api.groq.com/openai/v1, RAG_JUDGE_API_KEY, RAG_JUDGE_MODEL
#    (default qwen/qwen3.8-27b). They never touch the product's LLM_FALLBACK_* slot (ADR 0009).
pnpm eval:rag:judge             # pass 1; the first line prints the host it calls
pnpm eval:rag:judge --pass 2    # repeat 1 again (self-consistency)
# 4. Optional: embedding input size of the longest chunks (Gemini countTokens, free).
pnpm eval:rag:tokens
# 5. The report.
pnpm eval:rag:report
```

Harness settings (environment): `RAG_EVAL_AI_URL` (required), `RAG_EVAL_AI_TOKEN` (default: the
dev token), `RAG_EVAL_REPEATS` (1–5, default 3), `RAG_EVAL_PACE_MS` (pause before each question,
default 10 000: two generation calls per lookup stay under 15 requests a minute),
`RAG_EVAL_SEEDS` (default `t5.6,s1,s2,s3,s4`), `RAG_EVAL_ONLY` (comma-separated ids, for a quick
check), `RAG_EVAL_RESUME=1` (keep `answers.jsonl` and ask again only what was `unavailable`, e.g.
after Gemini answered 503 twice; the scorer keeps the last record of each repeat and question, and
every request still counts in the usage table), `RAG_EVAL_FRESH=1` (replace an `answers.jsonl` that
already holds answers; without it the run stops, since the hand labels and judgements are keyed on
those answers). A dry run with `LLM_PROVIDER=fake` on the AI service checks the plumbing for free.

## Files

| File | Committed | Holds |
|---|---|---|
| `golden-v1.json` | yes | the questions, expected sources, facts and number filters. Frozen: a change is `v2` |
| `prompts/rag_judge_v1.md` | yes | the judge prompt (`rag_judge/v1`) |
| `hand-labels-v1.json` | yes | keys, sentence indexes and labels only |
| `judge-limits.md` | yes | the limits section of the report |
| `eval/runs/rag/*` | no (git-ignored) | answers, sources, judgements, the hand sheet, cached vectors: synthetic text |
| `eval/reports/rag-v1.{json,md}` | yes | ids and numbers only, no question, answer or amount |

The harness itself is `apps/api/test/rag-eval.eval-spec.ts` (config `apps/api/jest.eval.config.js`):
it needs the API's Nest modules, migrations and Testcontainers setup, which live in `apps/api`.
Its file suffix keeps it out of `test` and `test:int`.

## Why this design

- **The real pipeline, not a copy.** The harness drives `POST /qa/ask` of the Nest Q&A module with
  the production AI client, on a Postgres with the real migrations and RLS. Only the question
  embedder is wrapped by a cache, so repeats and seeds cost no extra embedding requests.
- **Rules first, judge last.** Everything a rule can decide (hits, facts, numbers, markers) is
  decided by a rule. The judge only answers "does this source state this sentence", the one thing a
  rule cannot, and it is itself measured against a person.
- **Judge from another model family** than the answer model, to limit self-preference.
