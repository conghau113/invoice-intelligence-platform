# RAG evaluation v1 (T5.6)

Dataset: eval/datasets/v1 split core (100 invoices, 223 chunks). Golden set: `eval/rag/golden-v1.json` (30 questions: {'lookup': 16, 'aggregate': 10, 'refusal': 4}, {'vi': 17, 'en': 13}). Today for the questions: 2026-11-11. Repeats: 3. Top-k 5, 20 candidates per list. Embedding model: `gemini-embedding-001`. Run started 2026-11-12T14:07:55.890Z.

Rates are pooled over repeats with a 95% Wilson interval; the per-repeat counts show how much one run moves. Questions the provider could not answer twice in a row are out of every denominator: none.

## Headline

| Metric | Value |
|---|---|
| Retrieval hit@5 (lookups, retrieval of the ask itself) | **39/45** = 0.87 (95% CI 0.74–0.94); per repeat 13/15, 13/15, 13/15 |
| Citation precision, judge (each `[n]` whose source states the sentence) | **36/40** = 0.90 (95% CI 0.77–0.96); per repeat 12/13, 11/13, 13/14 |
| Citations pointing at a chunk of the expected invoice (rule) | **36/36** = 1.00 (95% CI 0.90–1.00); per repeat 12/12, 12/12, 12/12 |
| Numbers exact, aggregates (oracle from expected.json) | **14/24** = 0.58 (95% CI 0.39–0.76); per repeat 5/8, 4/8, 5/8 |
| Lookup answers with every expected fact (rule) | **27/48** = 0.56 (95% CI 0.42–0.69); per repeat 9/16, 9/16, 9/16 |
| Groundedness, judge (fact sentences a source supports; an upper bound, see Limits) | **30/30** = 1.00 (95% CI 0.89–1.00); per repeat 10/10, 10/10, 10/10 |
| Right refusals | **12/12** = 1.00 (95% CI 0.76–1.00); per repeat 4/4, 4/4, 4/4 |
| Every answer cites or abstains (NFR-07) | **90/90** = 1.00 (95% CI 0.96–1.00); per repeat 30/30, 30/30, 30/30 |

## Routing

Where the routing step (`qa_route/v1`) sent each kind of question, over all repeats:

| Golden kind | Routed as |
|---|---|
| aggregate | aggregate 24 |
| aggregate (needs groupBy) | aggregate 3, out_of_scope 3 |
| lookup | lookup 45, out_of_scope 3 |
| refusal | aggregate 3, lookup 3, out_of_scope 6 |

## Retrieval

hit@5 over seeds (retrieval only, same vectors, ids derived from the seed: ties are broken by id, T5.3):

| Seed | Hits | Missed |
|---|---|---|
| `t5.6` | 14/16 | q11, q13 |
| `s1` | 14/16 | q11, q13 |
| `s2` | 14/16 | q11, q13 |
| `s3` | 13/16 | q05, q11, q13 |
| `s4` | 15/16 | q11 |

## Lookup answers

- Answered: **30/48** = 0.62 (95% CI 0.48–0.75); per repeat 10/16, 10/16, 10/16; with every expected fact: **27/48** = 0.56 (95% CI 0.42–0.69); per repeat 9/16, 9/16, 9/16.
- Sentences without any `[n]` (rule): **0/33** = 0.00 (95% CI 0.00–0.10); per repeat 0/11, 0/11, 0/11.

| Tag | Questions | hit@5 | Right answer |
|---|---|---|---|
| no diacritics | q06, q07, q13, q14 | **9/12** = 0.75 (95% CI 0.47–0.91); per repeat 3/4, 3/4, 3/4 | **6/12** = 0.50 (95% CI 0.25–0.75); per repeat 2/4, 2/4, 2/4 |
| buyer name | q03, q04, q14, q15 | **9/9** = 1.00 (95% CI 0.70–1.00); per repeat 3/3, 3/3, 3/3 | **0/12** = 0.00 (95% CI 0.00–0.24); per repeat 0/4, 0/4, 0/4 |
| cross-language | q04, q10, q11, q15, q16 | **12/15** = 0.80 (95% CI 0.55–0.93); per repeat 4/5, 4/5, 4/5 | **6/15** = 0.40 (95% CI 0.20–0.64); per repeat 2/5, 2/5, 2/5 |
| number | q11, q12, q16 | **6/9** = 0.67 (95% CI 0.35–0.88); per repeat 2/3, 2/3, 2/3 | **6/9** = 0.67 (95% CI 0.35–0.88); per repeat 2/3, 2/3, 2/3 |
| no code | q13, q14 | **3/6** = 0.50 (95% CI 0.19–0.81); per repeat 1/2, 1/2, 1/2 | **0/6** = 0.00 (95% CI 0.00–0.39); per repeat 0/2, 0/2, 0/2 |

Misses (question: how many repeats):

- routedAway: q03 (as out_of_scope) ×3
- refusedAfterHit: q04 (expected invoice chunks: header) ×3, q09 (expected invoice chunks: header) ×3, q15 (expected invoice chunks: header) ×3
- missedRetrieval: q11 ×3, q13 ×3
- answeredIncomplete: q14 (0/4 facts) ×3

## Aggregates

- Exact: **14/24** = 0.58 (95% CI 0.39–0.76); per repeat 5/8, 4/8, 5/8.
- Wrong: r1/q20: got ANSWER_REJECTED, want 28 invoices
- Wrong: r1/q23: got NO_MATCHING_INVOICES, want 9 invoices
- Wrong: r1/q24: got NO_MATCHING_INVOICES, want 2 invoices
- Wrong: r2/q19: got NO_MATCHING_INVOICES, want 1 invoices
- Wrong: r2/q20: got ANSWER_REJECTED, want 28 invoices
- Wrong: r2/q23: got NO_MATCHING_INVOICES, want 9 invoices
- Wrong: r2/q24: got NO_MATCHING_INVOICES, want 2 invoices
- Wrong: r3/q20: got ANSWER_REJECTED, want 28 invoices
- Wrong: r3/q23: got NO_MATCHING_INVOICES, want 9 invoices
- Wrong: r3/q24: got NO_MATCHING_INVOICES, want 2 invoices
- Questions that need a group-by (q25, q26), handled as: r1/q25: OUT_OF_SCOPE, r1/q26: aggregate, r2/q25: OUT_OF_SCOPE, r2/q26: aggregate, r3/q25: OUT_OF_SCOPE, r3/q26: aggregate

## Refusals

- Right refusals: **12/12** = 1.00 (95% CI 0.76–1.00); per repeat 4/4, 4/4, 4/4. Wrong: none.

## By language

| Language | Lookup right | Aggregate exact |
|---|---|---|
| vi | **9/27** = 0.33 (95% CI 0.19–0.52); per repeat 3/9, 3/9, 3/9 | **5/15** = 0.33 (95% CI 0.15–0.58); per repeat 2/5, 1/5, 2/5 |
| en | **18/21** = 0.86 (95% CI 0.65–0.95); per repeat 6/7, 6/7, 6/7 | **9/9** = 1.00 (95% CI 0.70–1.00); per repeat 3/3, 3/3, 3/3 |

## LLM-as-judge

Judge: `qwen/qwen3.8-27b`, prompt `rag_judge/v1`. Answers judged (pass 1): 30; without a valid judgement after reruns: 0.

- Groundedness: **30/30** = 1.00 (95% CI 0.89–1.00); per repeat 10/10, 10/10, 10/10.
- Citation precision: **36/40** = 0.90 (95% CI 0.77–0.96); per repeat 12/13, 11/13, 13/14; leaving out markers on sentences the judge says state nothing: **36/37** = 0.97 (95% CI 0.86–0.99); per repeat 12/12, 11/12, 13/13. The judge counts every `[n]` in every sentence; the rule in the headline counts the citations the API delivered with each answer, so the two denominators differ.
- Fact sentences without a marker: **0/30** = 0.00 (95% CI 0.00–0.11); per repeat 0/10, 0/10, 0/10 (0 of them still supported by a source).
- Self-consistency (repeat 1 judged twice, 10 answers): same label on **11/11** = 1.00 (95% CI 0.74–1.00) sentences, Cohen's kappa 1.0.

Judge versus hand labels: every answered lookup of repeat 1 (10 answers, fixed before the judge ran), labelled by one person from a sheet without the judge's verdicts. Repeats 2 and 3 are not in the sample.

- Blind first pass: same sentence label **9/11** = 0.82 (95% CI 0.52–0.95), Cohen's kappa -0.048; same verdict on each `[n]` **11/13** = 0.85 (95% CI 0.58–0.96); disagreements: r1/q05#0: hand unsupported, judge supported; r1/q14#0: hand supported, judge no_claim.
- Revised after the first report had shown the judge's verdicts (r1/q05#0, r1/q14#0), so the lines below are not blind and are an upper bound:
- Same sentence label: **11/11** = 1.00 (95% CI 0.74–1.00); Cohen's kappa 1.0.
- Same verdict on each `[n]`: **12/13** = 0.92 (95% CI 0.67–0.99).
- Groundedness on these samples: by hand **10/10** = 1.00 (95% CI 0.72–1.00), by the judge **10/10** = 1.00 (95% CI 0.72–1.00).
- Disagreements: none.

## Limits of this evaluation

**LLM-as-judge.** Groundedness and citation precision come from a model reading other models'
output, so they carry that model's errors:

- *Self-preference*: a judge tends to rate text written the way it writes. The judge here is
  `qwen/qwen3.8-27b` on Groq, a different model family from the answer model (Gemini), to keep
  this small; it does not remove other shared habits of instruction-tuned models.
- *Leniency*: judges lean towards "supported" when a sentence is close to a source ("about
  1.7 million" next to "1782339"). The prompt asks for every name, number, date and code to be
  written in the source; the hand labels measure how far that holds.
- *Verbosity and position*: long answers and the first sources tend to get more credit. The judge
  reads every source, numbered as the answer model saw them; the order is the retrieval order and is
  not shuffled, so a position effect is not measured.
- *Not deterministic*: the same input can get another label. Repeat 1 is judged twice and the
  agreement is reported; a difference between two runs smaller than that is noise.
- *Language*: the judge reads Vietnamese and English; agreement is not reported per language (10
  hand samples are too few to split).
- *Output format*: without constrained decoding, the same judge broke the schema on 10 of 42
  calls (zero-width spaces inside keys, a bare list, an invented key) and 2 more were refused.
  Those outputs were not repaired and that run was set aside (its calls are in the usage table).
  The run reported here asks for Groq's strict mode (`strict: true`, constrained decoding): no
  output broke the schema, but Groq refused 11 of 51 calls with `json_validate_failed` (its own
  check failed; the same input passed on another try). Refused answers were judged again until
  every answer had one valid judgement; nothing was repaired.
- *Missed errors seen by reading*: in one answer outside the hand sample (`r2/q05`), the answer
  model miscopied an item code (a separator inside it) and the judge still marked the sentence
  supported; in `q14` (repeats 2 and 3) the judge labelled a sentence with an amount as "no
  claim" because it also said the sources were silent. Both point to leniency on codes and on
  mixed sentences.
- *Groundedness is an upper bound*: the judge labelled no sentence "unsupported" in this run, and
  the hand sample holds no unsupported sentence either, so how often the judge catches an
  unsupported sentence (its sensitivity) is not measured. The one known miss above is the only
  evidence, and it says the judge does miss some.
- *Only what the sentence splitter gives it*: sentences are cut by a rule (`eval/rag/text.py`); an
  abbreviation such as "Co." makes two sentences of one, and a list item is one sentence.

**Hand labels.** Every answered lookup of repeat 1 (10 answers, 4 vi and 6 en), one person,
labelled from a sheet without the judge's verdicts. With n = 10 answers (11 sentences), the
interval on agreement is wide and one label moves Cohen's kappa a lot; it says whether the judge is
roughly usable here, not how good it is in general.

The first labels were blind. After the first report had listed the disagreements with the judge,
two labels were changed (kept with their first value under `revisions` in
`eval/rag/hand-labels-v1.json`, so both figures are computed):

- `r1/q05#0`: the first label, "unsupported" with a true `[n]`, broke the labelling rule (a true
  `[n]` means a source states the sentence). The labeller re-read the source and changed it to
  "supported".
- `r1/q14#0`: changed from "supported" to "no claim" after seeing the judge's label.

Both were changed with the judge's verdict in view, so the revised agreement is an upper bound; the
blind first pass is the honest figure. Its kappa shows the prevalence paradox: almost every label
is "supported", so two raters agreeing by chance already reach about 83%, and 82% observed
agreement gives a kappa just below zero. On a sample this one-sided, kappa says little; the raw
agreement and the listed disagreements are the informative part.

**Rule scores.** "Every expected fact" checks that the facts of the golden answer appear in the
text; it does not check every other character. An answer that miscopies a code not listed as a
fact still counts as right, so the lookup rate is an upper bound on character-exact answers.

**Golden set.** Written by the same agent that built the pipeline, before the T5.6 run but after
T5.3 and T5.4 had shown which questions are hard. Tags make the hard groups visible instead of
averaging them away. 30 questions: one question is 3 to 6 points of a rate.

**Data.** Synthetic invoices from five templates (eval/datasets/v1): cleaner and more regular than
real invoices, with bilingual labels in every chunk. Retrieval on real invoices, with more suppliers
sharing words, will be harder.

**Models.** Free tiers, one day. Provider errors (503) are retried once by the harness; a question
that still fails is left out and listed.

## Requests

Failed attempts of `POST /qa/ask` (retried once, then `unavailable`): 27; 24 answered 5xx by the AI service (provider overloaded), 3 without a response (the API's 30 s timeout per model call; the AI service may still finish and spend the call).

Embedding input size (Phát sinh T5.2): `countTokens` on the 3 longest chunk texts as sent (cut at 2000 characters), model `gemini-embedding-001`: 1628 chars → 706 tokens, 1627 chars → 737 tokens, 1626 chars → 745 tokens; limit 2048 tokens.

| Step (model) | Requests | Input tokens | Output tokens | List price if paid (USD) |
|---|---|---|---|---|
| classify (gemini-3.5-flash-lite) | 102 | 66527 | 4042 | 0.0301 |
| answer (gemini-3.5-flash-lite) | 48 | 97737 | 2348 | 0.0352 |
| embed, chunks + questions + model probe (end records) | 29 | n/a | n/a | n/a |
| judge (qwen/qwen3.8-27b) | 51 | 81636 | 1086 | n/a |
| judge, discarded best-effort run (qwen/qwen3.8-27b) | 42 | 81636 | 1157 | n/a |

Amount actually paid: **$0**. Every call ran on free tiers (Gemini API without a billing account, Groq Free plan); the billing pages were checked before and after the run (docs/learning/T5.6-task-notes.md). The list price column is what the same tokens would cost on a paid plan, not money spent. Requests retried by the harness count twice.
