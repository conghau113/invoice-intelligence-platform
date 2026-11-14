# AI Pipeline

## 1. Role of the AI service

`apps/ai` is a **stateless** FastAPI service. It turns files into structured data, text into embeddings, and retrieved context into cited answers. It never stores data and never sees user identities — only a tenant-scoped, short-lived file URL or text passed by the worker/API. Python was chosen for the PDF/imaging and LLM ecosystem (ADR 0002).

## 2. Two extraction paths

| Source | Path | Expected accuracy | Why |
|---|---|---|---|
| Vietnamese e-invoice XML | Deterministic parser | Exact (100% on well-formed files) | Decree 123/2020/NĐ-CP (Art. 12.1) requires e-invoices to use XML. Parsing beats guessing. |
| PDF / photo / foreign invoice / receipt | Vision LLM + JSON Schema structured output | Measured in M4 | Not every document arrives as XML (photos, scans, foreign suppliers, cash receipts). |

The router chooses by `sourceType` (verified by magic bytes, not file extension).

## 3. Extraction schema

Defined once in `packages/contracts` (Zod) and exported to JSON Schema for Python (ADR 0004).

```text
Invoice
  seller { name, taxCode, address }      buyer { name, taxCode | null, address }
  invoiceNo, series, issueDate (ISO 8601), currency (ISO 4217)
  lines[] { description, quantity, unit, unitPrice, vatRate, amount }
  subtotal, vatBreakdown[] { rate, base, amount }, total     (integers, minor units)
  fieldMeta { <fieldPath>: { confidence 0..1, evidence { page, text } | null } }
```

`fieldMeta` is part of the Invoice, so `extractions.data` stores it too. `fieldPath` is a fixed grammar (`seller.name`, `total`, `lines.0.amount`, `vatBreakdown.1.rate`, …); unknown keys are rejected, and business-rule warnings and field corrections use the same paths. `fieldMeta` need not cover every field. "No value" is always `null` with the key present, never a missing key (so Zod, JSON Schema and pydantic agree). `evidence` is `null` when there is no page (XML); it holds an excerpt of the document, so never log it. The buyer's tax code may be `null` (individual buyers).

Business rules (shared TS code, also run in the worker): lines sum to subtotal; subtotal + VAT = total (±1 minor unit rounding); a total of 0 is flagged even when the sums agree; tax code **format** is 10 digits or 10+3 (`0123456789-001`); issue date not in the future; currency in an allow-list. Rules produce **warnings**, they never auto-correct numbers. The tax-code check digit is deliberately **not** validated: synthetic data uses invalid check digits so it can never match a real business (docs/LEGAL.md).

## 4. Extraction

1. Worker reads the file through `StoragePort` and sends it as multipart `{file, sourceType}` over the internal network (service token + `traceparent`); the AI service enforces a size cap and timeout.
2. PDF → page images (pypdfium2, 150 DPI). An uploaded picture is cleaned (`services/image_normalize.py`): metadata is removed by allow-list and an EXIF rotation is applied to the pixels, so the result does not depend on a provider reading EXIF. A turned JPEG leaves as a PNG, at most 2200 px on its long edge. A picture that is not turned keeps its pixels and stays the same size. A damaged file gets `IMAGE_INVALID` without calling a provider; the stored original is never changed.
3. Provider call (Strategy pattern, ADR 0009): system instructions + JSON Schema as the response schema; **document content is passed only as image/data parts, never concatenated into the instructions**.
4. Validate with pydantic (generated from JSON Schema). On failure: up to 2 retries including the validation error, except for an answer cut at the output-token cap (§8), which would be cut again; then return error code `EXTRACTION_SCHEMA_INVALID`.
5. Return `invoice`, `fieldMeta`, and `usage {model, inputTokens, outputTokens, latencyMs, costUsd}`; cost is computed from a versioned price table in config (prices change — update the table, never hard-code in logic).

Prompt versions live in `apps/ai/app/prompts/<name>/v<N>.md`; the version is stored with every extraction so eval results are comparable.

## 5. Vietnamese e-invoice XML

- Parse with `defusedxml` (blocks XXE and entity expansion).
- Map the common structure (general info, seller, buyer, line items, totals) to `Invoice` with confidence 1.0.
- **Known limitation:** real provider files differ in namespaces and optional fields. The project supports the structure produced by `tools/invoice-gen` and documents how to add a mapping for a new provider. Real e-invoices must not be committed (privacy).
- Built first (M2) as the deterministic path of the end-to-end vertical slice, before any LLM is involved.

## 6. Evaluation

### Extraction (M4)
- Dataset: 100 synthetic invoices from `tools/invoice-gen` (fixed seed), each with ground-truth JSON, XML and a rendered PDF/image; difficulty buckets easy/medium/hard (rotation, noise, low DPI, multi-page, many lines). 20-document smoke subset for CI. Frozen by hash in `eval/datasets/v1`, with 24 attack documents and one regression case scored apart from accuracy.
- Synthetic data is legally safe by construction: tax codes with invalid check digits, Faker names suffixed `SAMPLE`, and a `SAMPLE – SYNTHETIC DATA` watermark on every rendered page.
- Metrics: per-field accuracy after normalization; line-item F1 (lines matched by content similarity); document exact match; cost per document; p50/p95 latency.
- Runner (`eval/runner`, T4.3): checks every hash of the manifest, then calls the `/extract` pipeline in-process (PDF render and image cleaning included, no result cache). Identifiers (numbers, series, tax codes, currency, dates) compare as whole strings; amounts as decimals; free text after NFC, case folding and punctuation-as-space. Lost diacritics count as wrong and are counted apart. Lines pair greedily by similarity; a line is right only if every column is. A failed document counts as wrong on every field. Reports carry ids and paths only, never values; the one exception is the five error examples of `eval/reports/compare-v1.md` (T4.4), which show the synthetic right value and the answer next to a picture of the page.
- Comparison: at least two configurations (two models or two prompt versions). Thresholds are set from the first measured baseline and recorded in ADR 0020 — not guessed up front.
- CI gate (T4.5, `.github/workflows/eval.yml`): one run of `smoke` against the committed `eval/baselines/smoke.json`, by hand, weekly, and on PRs that change the prompt, providers, model default, output schema, PDF/image pipeline, runner or dataset. A PR that changes the default model on purpose commits its new baseline (`pnpm eval:baseline`) in the same PR. Red on a drop beyond the ADR 0020 tolerance, and red when the run cannot finish. Not on every PR: it spends free-tier quota and minutes.
- Honesty rule: synthetic data is cleaner than real scans; reports state this limitation. The human correction rate from production use (T4.6) is the online counterpart.

### RAG (M5)
- 30 golden questions (vi/en) with expected answers and expected source documents (`eval/rag/golden-v1.json`, frozen): 16 lookups, 10 aggregates (2 that need a group-by), 4 that must be refused.
- Metrics: retrieval hit@5, citation precision (citations point to retrieved chunks that contain the claim), numeric answer correctness, groundedness via LLM-as-judge **cross-checked by hand on 10 samples**.
- Runner (T5.6, `eval/rag/README.md`), by hand, never in CI: a harness (`apps/api/test/rag-eval.eval-spec.ts`) drives the real `POST /qa/ask` on a Testcontainers Postgres with RLS and the AI service, three repeats, plus a retrieval-only sweep over five id seeds; vectors are cached so repeats cost no embedding. Everything a rule can score is scored by a rule (hit@5, expected facts, numbers against an oracle computed from `expected.json`, markers); the judge (`rag_judge/v1`, a different model family from the answer model, Groq strict decoding) only says which sources state each sentence. Against 10 hand-labelled answers the judge agreed on 9/11 sentences blind (kappa −0.05, a prevalence paradox: nearly every label is "supported"), 11/11 after two labels were revised with the judge's verdict in view; it never labelled a sentence unsupported, so groundedness is an upper bound. Reports carry ids and numbers only.
- Results v1 (`eval/reports/rag-v1.md`, 2026-11-12, `gemini-3.5-flash-lite` + `gemini-embedding-001`, judge `qwen/qwen3.8-27b`): hit@5 39/45 when retrieval ran (13–15/16 per seed); citation precision 36/40 by the judge, 36/36 citations on a chunk of the expected invoice; numbers exact 14/24; lookups with every expected fact 27/48; refusals 12/12; every outcome cites or abstains 90/90. Main failures, by stage: routing (a buyer question sent out of scope; an item total with an invalid metric), retrieval of line chunks for buyer and paraphrase questions (only the header is found), supplier names typed without diacritics or shortened by the model (`ILIKE` keeps them), group-by questions (refused or answered with one total).

## 7. RAG

- **Index only approved invoices** (human-verified data).
- Chunks (`apps/ai/app/services/chunking.py`): input is one row of the view `current_invoices`; one header chunk per invoice (parties, dates, totals) + chunks of consecutive lines (at most 10 lines / 2,000 characters, a line is never split); metadata `{tenant_id, document_id, document_version, invoice_id, kind, ordinal}` and `refs[{document_id, field_path, page}]` for every field rendered in the chunk (`page` from `fieldMeta` evidence, `null` for XML).
- Embeddings (`apps/ai/app/services/embed.py`, T5.2): `gemini-embedding-001` truncated to 768 dims (Matryoshka, `outputDimensionality`), task type `RETRIEVAL_DOCUMENT` for chunks and `RETRIEVAL_QUERY` for questions, one `batchEmbedContents` call per 100 texts; vectors are L2-normalised (Gemini's docs: dimensions below 3,072 are not unit length). Stored in `vector(768)` with HNSW cosine index. The model takes at most 2,048 tokens: only the text sent to it is cut at 2,000 characters (the chunk budget, so only an oversized chunk is cut); the stored content stays whole. `LLM_PROVIDER=fake` also selects a fake embedder (feature hashing over words, so texts sharing words are close), used by tests and CI.
- Indexing (T5.2): approval enqueues a job (queue `rag-index`) → the worker reads the row of `current_invoices` → AI `/index` (chunk + embed) → the worker replaces the document's chunks if it is still approved at that version. Reopening deletes them at once. A failed index job never changes the document's status.
- Retrieval (`apps/api/src/modules/search/application/retrieval.ts`, T5.3): vector candidates and Postgres full-text candidates (`RAG_CANDIDATES`, default 20, each) → Reciprocal Rank Fusion (score = Σ 1/(60 + rank), ranks only, never raw scores) → top `RAG_TOP_K` (default 5). Full-text runs while the AI service embeds the question (`/embed`, task `query`); each list reads in its own short transaction with `app.tenant_id` set (RLS) **and** an explicit tenant filter (defense in depth), and no transaction stays open while waiting on HTTP. Both lists return only chunks of a document that is `approved`, at its current version (second layer behind the delete at reopen, T5.2); the vector list also only compares vectors of the question's embedding model.
  - Vector: `ORDER BY embedding <=> $q LIMIT n` over HNSW, with `SET LOCAL hnsw.iterative_scan = strict_order` and `hnsw.ef_search ≥ n`: the tenant filter is applied while walking the index, and without an iterative scan a small tenant inside a large table could get fewer than n rows. For a tenant with few chunks the planner reads them by tenant (btree) and sorts, which is exact.
  - Full-text: chunks containing any of the question's words (at most 32 distinct words, each parsed by `plainto_tsquery('simple')`, then ORed), ranked by the sum of the BM25 IDF of the matched words over the tenant's chunks, not `ts_rank_cd`: Postgres has no IDF, and the bilingual labels repeated in every chunk outranked the rare words (invoice number, item code). Golden set (T5.3, 10 questions, seed `t5.3`): full-text hit@5 4/10 with `ts_rank_cd`, 9/10 with IDF; hybrid with Gemini vectors 8/10 vs 10/10. Config `simple` keeps accents: a question typed without diacritics matches only its numbers and codes.
  - The internal route `POST /search/debug` (API.md) shows both ranks and raw scores.
- Question routing (T5.4, AI `/classify`, prompt `qa_route/v1`): the model sees the question and today's date (Vietnam), never document content, and answers `QaRoute` (`packages/contracts/src/qa.ts`): *lookup*, *aggregate* or *out_of_scope*. Keeping documents out of this step means a stored invoice cannot steer the filter that becomes a query. Out of scope → refused, with no retrieval and no further call.
- *Aggregate* ("total paid to X in Q3"): the model fills a structured filter (`metric` from a fixed list, supplier name or tax code, inclusive dates, currency, item text); Zod and business rules check it (`aggregateFilterProblems`); the API runs fixed parameterized SQL over `current_invoices` / `current_invoice_lines` (`apps/api/src/modules/qa/application/aggregate.ts`), one sum per currency, with an explicit tenant filter under RLS. The model never writes SQL and never does arithmetic. **The number is not phrased by a model**: it goes to the web as data (`aggregate` event, minor units) with the filter that was applied and the invoices that were added up as citations, and the web formats it with `Intl` in the reader's language. One call fewer, and no model can change the number while rewording it. Supplier and item match with `ILIKE` on the text (accents kept, like full-text). No matching invoice → refused (`NO_MATCHING_INVOICES`), never "0".
- *Lookup* (AI `/answer`, prompt `qa_answer/v1`): the retrieved chunks are sent as numbered sources inside one JSON document (the model never sees a chunk id); the model answers `QaAnswer` `{insufficientEvidence, answer}` with `[n]` markers in the language of the question. The API (`domain/citations.ts`) accepts the answer only if it cites at least one source and every `[n]` is a chunk retrieved for this question; a list such as `[1-9]` is refused, not parsed. A link (`http(s)://`, `www.`) in the answer must be written in a cited chunk (`domain/links.ts`), so a stored invoice cannot make the model hand the reader its own address. The check does not prove that every sentence is grounded: a sentence without a marker passes next to one with a valid marker (measured in T5.6: 0 of 33 delivered sentences lacked a marker, but a "the sources do not say" sentence with `[1]` passes as an answer, and one answer miscopied an item code; `eval/reports/rag-v1.md`). "I don't know" is the model's `insufficientEvidence` flag plus that rule, not a score threshold: RRF scores are ranks and always fill top-k (T5.3). Refusals carry a reason code that the web translates.
- Verify first, then stream: `POST /qa/ask` decides the whole outcome before the first SSE event, so nothing shown is retracted; the events are already those of a token stream (API.md). Model output that does not validate is "no output" (refused), never repaired or retried.

## 8. Provider limits

Free and paid tiers enforce requests per minute (RPM), tokens per minute (TPM) and requests per day (RPD); limits vary by account and change over time, so they are **configuration, not constants** (`LLM_RPM`, `LLM_TPM`, `LLM_RPD`).

- **Output-token cap** (`MAX_OUTPUT_TOKENS` in `providers/base.py`, T4.5b): 12,288, set from time rather than from the model's own limit (65,536 for `gemini-3.5-flash-lite`). At the slowest speed measured (2.2 s + 3.2 ms per output token) the longest answer still arrives inside `llm_timeout_s` (45 s). That is about 86 invoice lines; a longer invoice is cut and fails at once with `EXTRACTION_SCHEMA_INVALID` (the provider reports `MAX_TOKENS` / `length`, and extract does not retry an answer cut at the cap). A larger cap would turn the same invoice into a timeout, which the worker retries and pays for as a temporary error.
- BullMQ limiter keeps the extraction queue under RPM.
- On 429: read `Retry-After` if present, otherwise exponential backoff with full jitter; cap total wait; then fail the job with a clear code.
- Circuit breaker opens after N consecutive provider failures and pauses the queue.
- Development and CI use a **fake provider** (deterministic fixtures) so no quota is spent and tests run offline.
- Gemini API Terms for Unpaid Services: Google *"uses the content you submit… to provide, improve, and develop"* its products, *"human reviewers may read… your API input and output"*, and *"Do not submit sensitive, confidential, or personal information to the Unpaid Services."* → **only synthetic data** is ever sent.
- **Fallback provider:** one additional free provider called through its **official API**, switched by configuration, not automatically. T4.4 found none that qualifies for production: Groq's Free plan cannot return one invoice within its output-token limit, and NVIDIA's free endpoint on OpenRouter is for trial use only, so it is measured, not deployed (ADR 0009).
- **Not used:** proxies that route requests through personal subscription logins (e.g. 9Router). Anthropic's terms (Feb 2026) forbid using Free/Pro/Max credentials to route requests for third-party tools; such proxies also add an unaudited component that sees all traffic.
- The public demo never calls an LLM (ADR 0018).
