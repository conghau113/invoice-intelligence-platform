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
