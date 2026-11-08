# ADR 0020: Eval thresholds: set from the first measured baseline, by a fixed method

- Status: Proposed — T4.3 and T4.4 supply the numbers, T4.4 sets it to Accepted
- Date: 2026-11-07
- Related tasks: T4.2, T4.3, T4.4, T4.5

## Context
NFR-05 and `AI_PIPELINE.md` §6 say thresholds come from the first measured baseline, not from a guess. T4.2 freezes the dataset (`eval/datasets/v1`), but no model has run on it: running eval belongs to T4.3, and the full 100 documents run first in T4.4. So this ADR can fix what is gated and how the number is derived, but not the number. Writing a figure now, even the "95%" the task uses as an example, would be the guess the rule forbids.

What is known without a run:
- `smoke` has 20 documents, so one document is 5 percentage points on any per-document field. `core` has 100, so one document is 1 point.
- Results vary between runs of the same model and prompt. How much is not measured yet.
- Real runs so far are single samples: one document had a tax code with its branch suffix cut at confidence 1 (T3.7), and one attack sentence failed on two PDFs (T3.6). They say nothing about rates.

## Options considered
1. Fixed numbers now (for example critical fields ≥ 95%): simple, and easy to state in a README, but not based on anything measured. If the model scores lower, the gate is red from day one and gets ignored or lowered. If it scores higher, the gate allows a real drop.
2. A fixed method now, numbers from the first baseline: this ADR stays Proposed until the runs exist.
3. Only compare with the last run, with no floor: catches sudden drops, but repeated small drops pass, and nothing says whether the level is acceptable.
4. Move the ADR to T4.4 entirely: no method on record while T4.3 builds the report and decides what to measure.

## Decision criteria
- Follows NFR-05: no number without a measurement
- A red gate must mean a real drop, not noise
- Cannot be adjusted after seeing the result it judges
- Runs at zero cost, within the free tier

## Decision
Option 2.

**Critical fields** are the header fields prompt v1 already asks evidence for, plus the currency, because it changes what every amount means: `invoiceNo`, `series`, `issueDate`, `currency`, `subtotal`, `total`, `seller.taxCode`, `buyer.taxCode`. Tax codes compare as whole strings, so a cut suffix counts as wrong (T3.7). An individual buyer has no tax code: the right answer is null, and any value there counts as wrong. Line items are scored by F1 separately, as in `AI_PIPELINE.md` §6.

**Noise.** T4.3 runs `smoke` three times with one configuration and records the largest difference between runs, per critical field.

**Acceptance floor (NFR-05),** on `core`, from the first full run of the chosen configuration in T4.4, per critical field and for line F1: floor = measured value − the larger of the noise and one document (1 point on `core`), rounded down to a whole percent. Noise comes from `smoke`, where one document is already 5 points, so it is either 0 or coarse: without the one-document margin a noise of 0 would put the floor on the measured value, and one document would turn it red. A floor records the level reached. It does not say the level is good enough: if the measured value is too low for a person to review efficiently, T4.4 says so in its report instead of hiding it behind the floor.

**Regression tolerance (T4.5),** on `smoke`, against a committed baseline: fail when a critical field or line F1 drops by more than the larger of the measured noise and one document (5 points). A smaller tolerance would fail on one unlucky document.

**Reporting without a gate.** Document exact match, cost, latency and injection success are reported, not gated, until there is enough data to say what a good value is. A run where an attack changed a value is listed by document in the report.

**Prompts tuned on the set.** Thresholds and final scores use a configuration fixed before reading its errors on `core`. If a prompt changes after reading those errors, its score is labelled "tuned on this set", and is confirmed on a fresh seed before it is quoted or used for a floor. A new seed takes about a minute to generate and is not committed.

| Number | From | Value |
|---|---|---|
| Noise per critical field | T4.3 | 0 points on all 8 critical fields and line F1: `smoke`, 3 runs of `gemini-3.1-flash-lite` with `invoice_extraction/v1`, 2026-11-08 (`eval/reports/v1-gemini-3.1-flash-lite-invoice_extraction-v1.md`). Every run gave the same right/wrong answer on every critical field (0 flips per document in the report); the one-document margin (5 points on `smoke`, 1 on `core`) is therefore what sets floor and tolerance. Three runs of one model on one day: re-measure when the model or prompt changes |
| Floor per critical field, line F1 | T4.4 | not measured yet |
| Smoke baseline | T4.5 | not measured yet |

## Consequences
- + Nothing here is guessed, and the rule for each number is fixed before the number exists
- + A red T4.5 run means more than one document's worth of change
- − Until T4.4 there is no accepted threshold, and the README cannot quote one
- − On `smoke`, drops smaller than 5 points pass; only the full `core` run sees them, and it costs more of the free-tier quota
- − A floor based on what was measured can settle for a weak model; the report has to judge the level on its own
- − Three runs give a rough estimate of the noise, limited by free-tier quota

## Revisit when
T4.4 fills in the numbers (set this to Accepted); noise turns out larger than 5 points on `smoke`, so the gate needs a larger set or more repeats; the prompt or model changes on purpose, which needs a new baseline; or real invoices become available.
