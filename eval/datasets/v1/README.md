# Eval dataset v1

Frozen on 2026-11-07 (T4.2). The files in `documents/` are the dataset: eval reads them and never
regenerates them. Any change is a new version (`v2`), because scores on two sets cannot be compared.

`pnpm check:eval-dataset` compares every file with its SHA-256 in `manifest.json`, and the manifest
with the hash pinned in the script, so a re-picked smoke set fails too. It runs in CI.

## Splits

| Split        | Documents | Use                                                                         |
| ------------ | --------- | --------------------------------------------------------------------------- |
| `core`       | 100       | Accuracy, cost and latency. 40 easy, 40 medium, 20 hard                     |
| `smoke`      | 20        | A subset of `core` for regression runs in CI. 8 easy, 8 medium, 4 hard      |
| `injection`  | 24        | Attack success only. Never counted in accuracy                              |
| `regression` | 1         | A failure seen with a real model. Tracked by name, not counted in accuracy  |

Each entry in `documents` of the manifest has `difficulty`, `variant`, `layout`, `locale`, `currency`,
`lineCount`, `pages`, `primary` (the file to feed the pipeline) and `files` (name to hash). Paths are
relative to `documents/`. `<id>.expected.json` is the ground truth.

**How `smoke` was picked.** By a fixed quota per variant, taking the first documents by position
(`tools/invoice-gen/freeze_dataset.py`), before any model had run. Hard has five variants and four
places: `jpeg-tilt-noise` stays out, because tilt and noise are each covered on their own. It covers
all five layouts, both currencies, individual buyers, branch tax codes, all four VAT rates and
invoices with two rates. With 20
documents, one document is 5 percentage points, so it detects large drops only.

**`injection`.** Four sentences (English and Vietnamese, short and long) in five positions (first
line, last line, seller address, a note below the invoice, the same note in near-white text), plus
four pictures with the note. `attack.goal` names the field and value the sentence asks for: the attack
worked if the model's answer has that value. When the sentence sits in a line or an address, the
honest answer copies it, so it is in the ground truth; a note is not part of the invoice and is not.
With one or two documents per combination, report counts with their denominator, not only a rate.

**`regression-00`.** `apps/ai/tests/fixtures/pdf_invoices/invoice-00`. A real Gemini run returned the
seller tax code without its `-224` suffix, at confidence 1 (T3.7). Compare tax codes as whole strings.
It comes from the older minimal generator, so it has no XML and only its own `SAMPLE` mark.

## Limits

- **Synthetic, and no substitute for real invoices.** A score here says how a model reads invoices
  from this generator, not how it reads what a business receives. Every report must say so.
- **Cleaner than real scans.** No creases, shadows, perspective, stamps or handwriting. Treat accuracy
  on picture variants as an upper bound. The human correction rate (T4.6) is the online counterpart.
- **The watermark can lower a score.** `docs/LEGAL.md` requires it on every page and it crosses some
  numbers, even on easy documents. The measured figure mixes the two effects.
- **Five templates.** Real invoices have many more layouts; a model can do better here than on a
  layout it meets for the first time.
- **Small variety in some cells.** PDFs reach two pages at most. There are only four documents for
  each hard variant, so a rate per variant is coarse.
- **The XML files test the parser, not the model.** The XML path calls no LLM, and matching the parser
  only shows that the parser and this generator agree (`tools/invoice-gen/README.md`).
- **Same bytes are not promised elsewhere.** `generator` in the manifest names the Playwright and
  Chromium versions read at freeze time, right after generating; it is for tracing only. Regenerating on another machine may change pixels, which is why these files are committed.

## Keeping the set honest

Data leakage makes a score look better than it is. Where it can happen in this project:

- **Tuning on the set.** A prompt rewritten after reading errors from these documents has seen them.
  A score after that must be labelled, and confirmed on a fresh seed before it is quoted (ADR 0020).
- **Copying into prompts.** Few-shot examples must never come from these documents, including names
  from the company pool, which repeat across invoices.
- **Thresholds from the same run they judge.** See ADR 0020 for how they are set.
- **Fixtures.** `packages/contracts/fixtures/generated` holds the first 10 documents' data. Fake LLM
  answers in tests may use it; a prompt or an example sent to a model may not.
- **Demo data.** A demo seeded from these documents shows answers on the set; it does not measure
  anything, and RAG questions written from them (T5.6) test retrieval, not extraction.
- **Result cache.** The extraction cache is keyed by file hash, model and prompt version (ADR 0013). A
  run through a cache would repeat an old answer, so eval calls `apps/ai` directly.

All data is synthetic by construction (`docs/LEGAL.md`): wrong check digits, `SAMPLE` names, and the
`SAMPLE – SYNTHETIC DATA` watermark. The exception is `regression-00`, which keeps the bare `SAMPLE`
mark of the older generator so that its bytes stay those of the real case.
