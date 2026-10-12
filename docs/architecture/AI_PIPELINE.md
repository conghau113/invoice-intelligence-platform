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
  seller { name, taxCode, address }      buyer { name, taxCode, address }
  invoiceNo, series, issueDate (ISO 8601), currency (ISO 4217)
  lines[] { description, quantity, unit, unitPrice, vatRate, amount }
  subtotal, vatBreakdown[] { rate, base, amount }, total     (integers, minor units)
  fieldMeta { <fieldPath>: { confidence 0..1, evidence { page, text } } }
```

Business rules (shared TS code, also run in the worker): lines sum to subtotal; subtotal + VAT = total (±1 minor unit rounding); tax code **format** is 10 digits or 10+3 (`0123456789-001`); issue date not in the future; currency in an allow-list. Rules produce **warnings**, they never auto-correct numbers. The tax-code check digit is deliberately **not** validated: synthetic data uses invalid check digits so it can never match a real business (docs/LEGAL.md).

## 4. Extraction

1. Worker reads the file through `StoragePort` and sends it as multipart `{file, sourceType}` over the internal network (service token + `traceparent`); the AI service enforces a size cap and timeout.
2. PDF → page images (pypdfium2, ~150–200 DPI); images are normalized (EXIF rotation).
3. Provider call (Strategy pattern, ADR 0009): system instructions + JSON Schema as the response schema; **document content is passed only as image/data parts, never concatenated into the instructions**.
4. Validate with pydantic (generated from JSON Schema). On failure: up to 2 retries including the validation error; then return error code `EXTRACTION_SCHEMA_INVALID`.
5. Return `invoice`, `fieldMeta`, and `usage {model, inputTokens, outputTokens, latencyMs, costUsd}`; cost is computed from a versioned price table in config (prices change — update the table, never hard-code in logic).

Prompt versions live in `apps/ai/app/prompts/<name>/v<N>.md`; the version is stored with every extraction so eval results are comparable.

## 5. Vietnamese e-invoice XML

- Parse with `defusedxml` (blocks XXE and entity expansion).
- Map the common structure (general info, seller, buyer, line items, totals) to `Invoice` with confidence 1.0.
- **Known limitation:** real provider files differ in namespaces and optional fields. The project supports the structure produced by `tools/invoice-gen` and documents how to add a mapping for a new provider. Real e-invoices must not be committed (privacy).
- Built first (M2) as the deterministic path of the end-to-end vertical slice, before any LLM is involved.

## 6. Evaluation

### Extraction (M4)
- Dataset: 100 synthetic invoices from `tools/invoice-gen` (fixed seed), each with ground-truth JSON, XML and a rendered PDF/image; difficulty buckets easy/medium/hard (rotation, noise, low DPI, multi-page, many lines). 20-document smoke subset for CI.
- Synthetic data is legally safe by construction: tax codes with invalid check digits, Faker names suffixed `SAMPLE`, and a `SAMPLE – SYNTHETIC DATA` watermark on every rendered page.
- Metrics: per-field accuracy after normalization; line-item F1 (lines matched by content similarity); document exact match; cost per document; p50/p95 latency.
- Comparison: at least two configurations (two models or two prompt versions). Thresholds are set from the first measured baseline and recorded in an ADR — not guessed up front.
- Honesty rule: synthetic data is cleaner than real scans; reports state this limitation. The human correction rate from production use (T4.6) is the online counterpart.

### RAG (M5)
- 30 golden questions (vi/en) with expected answers and expected source documents.
- Metrics: retrieval hit@5, citation precision (citations point to retrieved chunks that contain the claim), numeric answer correctness, groundedness via LLM-as-judge **cross-checked by hand on 10 samples**.

## 7. RAG

- **Index only approved invoices** (human-verified data).
- Chunks: one header chunk per invoice (parties, dates, totals) + chunks of grouped lines; metadata `{tenant_id, invoice_id, page, field_paths}`.
- Embeddings: `gemini-embedding-001` truncated to 768 dims (Matryoshka); stored in `vector(768)` with HNSW cosine index.
- Retrieval: vector top-k and Postgres full-text top-k in parallel → Reciprocal Rank Fusion. Executed inside a transaction with `app.tenant_id` set (RLS) **and** an explicit tenant filter (defense in depth).
- Question routing: *lookup* → RAG answer; *aggregate* ("total paid to X in Q3") → LLM produces a structured filter validated by schema → parameterized SQL → LLM phrases the result. The model never writes SQL and never does arithmetic on totals.
- Answers must cite `[n]` markers mapped to chunk ids; the API rejects answers whose citations are not in the retrieved set. Insufficient evidence → "I don't know" in the user's language.

## 8. Provider limits

Free and paid tiers enforce requests per minute (RPM), tokens per minute (TPM) and requests per day (RPD); limits vary by account and change over time, so they are **configuration, not constants** (`LLM_RPM`, `LLM_TPM`, `LLM_RPD`).

- BullMQ limiter keeps the extraction queue under RPM.
- On 429: read `Retry-After` if present, otherwise exponential backoff with full jitter; cap total wait; then fail the job with a clear code.
- Circuit breaker opens after N consecutive provider failures and pauses the queue.
- Development and CI use a **fake provider** (deterministic fixtures) so no quota is spent and tests run offline.
- Gemini API Terms for Unpaid Services: Google *"uses the content you submit… to provide, improve, and develop"* its products, *"human reviewers may read… your API input and output"*, and *"Do not submit sensitive, confidential, or personal information to the Unpaid Services."* → **only synthetic data** is ever sent.
- **Fallback provider:** one additional free provider called through its **official API** (Groq or OpenRouter free models), chosen in T4.4 after verifying image input, structured output and data terms. Switched by configuration, not automatically.
- **Not used:** proxies that route requests through personal subscription logins (e.g. 9Router). Anthropic's terms (Feb 2026) forbid using Free/Pro/Max credentials to route requests for third-party tools; such proxies also add an unaudited component that sees all traffic.
- The public demo never calls an LLM (ADR 0018).
