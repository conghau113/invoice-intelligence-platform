Written by hand after reading the numbers above (T4.4, 2026-11-08). The numbers are generated; this
section is judgement and says where each claim comes from. Updated 2026-11-09 (T4.5b): B was run
again with the output-token cap raised from 8,192 to 12,288, same model and prompt; A and C keep
their runs at 8,192 (A never reached it, C did on three documents).

### Which model, and why

`gemini-3.5-flash-lite` (B) is the primary by the rule fixed before the runs: 92 of 100 documents
with all 8 critical fields right (92 before the cap was raised), against 85 for
`gemini-3.1-flash-lite` (A). Paired, B is right where A is wrong on 10 documents and the reverse on
2, so the difference is not one or two lucky documents. B also cuts fewer branch suffixes from the
seller's tax code (7 of 26 against 12 of 26) and has a lower tail latency (p95 12.3 s against
26.1 s on single pages; B measured 7.1 s on 2026-11-08, so free-tier latency varies by day).

B is not better everywhere:

- **Lines.** A reads lines almost perfectly (F1 0.999); B reaches 0.983. On one noisy photo B
  reads the rows out of step (example 3). Before T4.5b it also lost a whole 54-line, two-page
  invoice to the output-token cap (F1 0.943).
- **Cost.** At list price B costs about 1.6 times as much ($0.00450 against $0.00275 a document).
  Nothing was paid: both ran on the free tier.

The trade-off: a person has to fix a critical field on 15 invoices of 100 with A and on 7 with
B, and a line on 1 invoice with A against 4 with B (one photo read out of step, one line
description wrong on each of two invoices, one VAT rate on a 51-line invoice). Header fields decide whether an invoice can be booked at
all (tax code, total), so B wins on this set. If line-level accuracy mattered more than tax codes,
or if the price difference were paid for, the answer could change.

### What goes wrong most

1. **The seller's tax code loses its branch suffix** (`5193714551-891` read as `5193714551`,
   example 1). It is the largest error for both models (12 for A, 7 for B on `core`). Every one of
   them came with a self-reported confidence of 0.8 or more, so the review screen does not
   highlight it (SECURITY.md §6). The value still has a valid 10-digit form, so schema and rules
   pass it. For A it is systematic (0 points of noise); for B one document flipped between runs.
2. **Long answers reached the output-token cap (fixed in T4.5b).** `invoice-0004` (54 lines)
   needed 8,175 output tokens from B, against a cap of 8,192: the JSON was cut and the document
   failed. Prompt v1 asks for a `fieldMeta` entry for every line amount, so each line costs about
   133 tokens. T4.5b raised the cap to 12,288, the largest answer that still arrives inside the
   45 s provider timeout at the slowest speed measured (`AI_PIPELINE.md` §8): `invoice-0004` then
   used 7,952 to 8,251 tokens over four runs (two of them above the old cap) and took 15.6 to
   25.6 s. About 86 lines fit; longer invoices still fail, now at once and with no retry.
3. **Rows out of step on a noisy, tilted photo** (example 3): B gave lines the quantity and
   amount of another line (in the 2026-11-08 run, the quantity and unit price of the line above).
   Descriptions stayed right, so each line looks plausible on its own. Only one document of four
   in that variant, and the same document both times.
4. **Misread digits:** one date on a low-resolution photo (`09/05/2026` read as September, example
   4), and one character dropped in a line description (example 5).

Neither Gemini model produced a hallucination in the sense of a value printed nowhere on the
invoice: every wrong value was a cut, a misread, a value from another field or line, or a missing
one.

### Checking values against the PDF text layer

A whole-token check of the seven checkable fields against the PDF text layer would have flagged
every wrong value it could check (13 of 13 for A, 7 of 7 for B, all of them cut tax codes or
misread identifiers) and no right one (0 false alarms in 670 right values each). This supports
the check planned since T3.6 and T3.7, as a product feature for PDFs with a text layer. It does
not help with photos, which have no text layer; for those the numbers come from the PDF of the same
invoice and only show what such a check could do. Recorded under "Phát sinh".

### The watermark

None of the five examples sits under the `SAMPLE – SYNTHETIC DATA` watermark (checked on the
pictures). In example 3 the watermark crosses rows 4 to 7, while the rows are out of step from
the top of the table, so it did not cause it. This was checked on five examples only, not on every error.

### Is the level good enough?

The floors in ADR 0020 record what was reached. Whether it is enough: 99 to 100% on most critical
fields is good for synthetic invoices; 93% on the seller's tax code is not, because the error is
silent (high confidence, valid form). Until a text-layer check or a prompt change fixes it, the
review screen should not let a high confidence on a tax code stand for "verified".

### The fallback

`nvidia/nemotron-3.5-super-vl:free` through OpenRouter (C) is measured for comparison only:
NVIDIA's trial terms forbid production use, so it cannot be the production fallback whatever it
scores (ADR 0009). It ran on 49 of the 100 `core` documents, covering all 9 variants, and then
stopped by decision (Hậu, 2026-11-08): at 50 free requests a day the other 51 would take two more
days and could not change that conclusion. `injection` was not sent to it (trial terms §4.10), and
`regression` was not run (quota). Compare it with A and B through the paired table, which uses
the same 49 documents.

What the 49 documents show:

- **It does not cut tax codes.** 0 of 13 branch suffixes lost, where both Gemini models lose
  several. On the critical fields it sits between A and B (44 of 49 all right; A 42, B 46 on the
  same documents).
- **It drops Vietnamese diacritics**: 20 of 49 invoices have a name or address wrong only by its
  marks, and line units and descriptions lose them too (73 of its 92 misreads). For a Vietnamese
  invoice product this alone rules it out.
- **It fails long invoices.** All three of its failures (both two-page invoices it met and one
  19-line invoice) reached the 8,192-token output cap, mostly with reasoning, and returned cut
  JSON. Line F1 0.654. It was not run again with the 12,288 cap (T4.5b): its terms rule it out
  whatever it scores.
- **It is slow**: p50 22.2 s and p95 64.3 s on single pages, above the 30 s of NFR-04.

Groq's Free plan could not be measured at all: its output limit of 1,000 tokens a minute is below
what one invoice needs.

### Leakage check

The prompt was not changed in T4.4 or T4.5b, so no score here is "tuned on this set". The cap
was raised after reading the cut answer on `core`, but it changes no reading: it only decides
whether a long answer is received at all. The 20 `smoke`
documents had been read in T4.3; they are part of `core`, and the rule that picked B was written
before any `core` run.
