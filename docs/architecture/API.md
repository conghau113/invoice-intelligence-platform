# API

> REST over HTTPS, JSON, base path `/api/v1`. OpenAPI is generated from NestJS decorators and published at `/api/docs` in non-production environments. This file is the human-readable contract; when it disagrees with the code, the PR must fix one of them.

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <access token>` issued by Keycloak. Deny by default; `@Public()` opts out (health only). |
| Tenant | Derived from the token's `organization` claim; the web asks for `organization:*`, so the token lists every tenant of the user, and header `X-Tenant: <alias>` selects one. The alias must be in that signed claim (else 403 `TENANT_NOT_MEMBER`); several tenants and no header → 403 `TENANT_REQUIRED`. The header only selects, it never grants. |
| Errors | RFC 9457 Problem Details: `{type, title, status, detail, instance, code, traceId}`; `code` only from `API_ERROR_CODES` in `packages/contracts/src/error-codes.ts`, each with a message in both languages |
| Pagination | `?page=1&limit=20` → `{items, meta: {page, limit, total, totalPages}}` (`page` from 1, at most 10 000; `limit` 1–100, default 20; ADR 0019). `total` is counted after tenant and filters. A `page` past `totalPages` answers empty `items` with the true `meta`. Append-only streams (audit, events) use cursors instead; none exists yet |
| Filtering/sorting | `?status=needs_review&type=xml&from=2026-09-01&to=2026-09-30&sort=-createdAt` — `type` is `xml`, `pdf` or `image`; `from`/`to` are whole days, both inclusive, in `Asia/Ho_Chi_Minh`; `sort` is `createdAt` or `-createdAt` (default), always followed by `id` as tie-breaker. Anything else is `400 INVALID_QUERY` |
| Idempotency | `Idempotency-Key` header on POSTs that create resources; replay returns the original response for 24 h |
| Concurrency | `If-Match: "<document version>"` on approve and reopen (required, else `428 IF_MATCH_REQUIRED`); stale version → `409 VERSION_CONFLICT`; a status the action cannot start from (already approved, or reopening what is not approved) → `409 INVALID_DOCUMENT_TRANSITION` |
| Rate limits | `429` with `Retry-After` and `RateLimit-*` headers (ADR 0012) |
| Tracing | W3C `traceparent` accepted and propagated; `traceId` echoed in errors |
| Versioning | URL major version (`/v1`); additive changes only within a version |
| Client address | `req.ip` follows `X-Forwarded-For` only from peers in `TRUSTED_PROXIES` (default `loopback`), used for audit rows (SECURITY.md §5). The web upload proxy passes the header on only when `TRUST_FORWARDED_FOR=true` (a proxy that overwrites it is in front); a value that is not an IP is stored as no address |
| Demo mode | When `DEMO_READ_ONLY=true` every request other than GET/HEAD/OPTIONS returns `403` with code `DEMO_READ_ONLY`, before authentication and on `@Public()` routes too (`DemoReadOnlyGuard`, T4.7); tenant transactions are opened `READ ONLY` as a second layer; `/auth/me` lists only `document:read` and `insights:read` so the UI hides write actions. Q&A will serve only precomputed answers (ADR 0018, T5.5) |
| Routing | Behind Caddy only the web server is public (`/`, including its own `/api/*` route handlers and next-auth) and Keycloak's `/auth/realms/*`, `/auth/resources/*`. The API is on the internal network and is reached by the web server (BFF, ADR 0006), never by the browser, so no CORS is needed (T4.7, `infra/prod/Caddyfile`) |

## Endpoints

### Health
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness, public |
| GET | `/health/ready` | Readiness: DB, Redis, Keycloak JWKS reachable |

### Me & tenants
| Method | Path | Permission |
|---|---|---|
| GET | `/auth/me` | authenticated — user, tenant id, `tenants` (aliases to switch to), roles, permissions |
| GET | `/tenants/current/members` | `tenant:manage` |

### Documents
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/documents/upload` | `document:create` | `multipart/form-data` (one file ≤ 10 MB, streamed); type checked by magic bytes; dedupe by (tenant, sha256); `Idempotency-Key` required |
| GET | `/documents` | `document:read` | Paginated list with filters; items are `{id, status, sourceType, version, createdAt}`, plus `meta` |
| GET | `/documents/:id` | `document:read` | `{id, status, sourceType, version, createdAt, failureCode, extraction, invoice, reopenedFrom}`; `failureCode` is set only while `failed`; `extraction` is `null` until one exists, else `{id, documentVersion, source, data (Invoice incl. fieldMeta), warnings, createdAt}`; `invoice` is the invoice approved at the current version, else `null`, as `{id, documentVersion, data, warnings, approvedAt}`; `reopenedFrom` has the same shape: the invoice approved before a reopen, not approved any more, and `null` whenever `invoice` is set, the document was never approved, or that older row no longer passes the schema (the form then starts from the extraction). Another tenant's id and a malformed id are both `404`; stored data that no longer matches the schema is `500 EXTRACTION_DATA_INVALID` |
| GET | `/documents/:id/file` | `document:read` | Streams the file through the API after the permission check (no public file URLs) |
| POST | `/documents/:id/retry` | `document:manage` | Only from `failed` |
| POST | `/documents/:id/approve` | `document:approve` | Body = corrected Invoice (JSON, ≤ 1 MB here and 100 KB on every other route, else `413 BODY_TOO_LARGE`; malformed JSON `400 BODY_INVALID`; schema failure or over the limits, ≤ 500 lines, ≤ 20 VAT rows, text ≤ 1,000 characters without NUL, `422 INVOICE_INVALID`); `If-Match` required. `200 {id, status, version, invoiceId, corrections, warnings}`; warnings never block |
| POST | `/documents/:id/reopen` | `document:approve` | `approved → needs_review`, version+1, from `approved` only; no body; `If-Match` required. `200 {id, status, version}`. A document can reach version 20 at most, beyond that `409 REOPEN_LIMIT_REACHED`. Does not extract again |

### Q&A
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/qa/ask` | `qa:ask` | Body `{question (1–1,000 chars after trim)}` (`QaAskBodySchema`), anything else `400 BODY_INVALID`. **Verify first, then stream** (T5.4): routing, retrieval, the answer and its citation check (or the SQL of an aggregate) all finish before the response starts, so nothing streamed is ever taken back. `200 text/event-stream`, events in `QA_STREAM_EVENTS` (`packages/contracts/src/qa.ts`), each `data` one JSON line: a lookup answer is `token` × n (`{text}`, joined they give the answer with `[n]` markers), then `citations`; an aggregate is `aggregate` (`{filter, results: [{currency, amount}] in minor units per currency (empty for `invoiceCount`), invoiceCount, sellers: [{name, taxCode}] (the suppliers actually added up, at most 20; a name filter is "contains"), sellerCount}`), then `citations`; otherwise `refusal` (`{reason}`: `OUT_OF_SCOPE`, `INSUFFICIENT_EVIDENCE`, `NO_MATCHING_INVOICES`, `ANSWER_REJECTED`). Always ends with `done`. `citations` is `{citations: [{n, documentId, documentVersion, invoiceId, chunkId, refs: [{document_id, field_path, page}]}]}`: for a lookup, `n` matches `[n]` in the text (exactly `[n]`, no spaces, so a marker is one `token`; `[1, 3]`, `[1-9]`, `[ 1 ]` are refused; so is an answer with an `http(s)://` or `www.` link that no cited chunk contains) and `chunkId` is a chunk retrieved for this question; for an aggregate, the first 50 invoices added up (`chunkId` null, `refs` the summed fields). The AI service cannot answer → `503 AI_SERVICE_UNAVAILABLE` before any event. The question is never logged. Closing the connection cancels the pending model call (not the question's embedding, which runs to its end). The question may not contain NUL. On the public demo the adapter also refuses to call the AI service (second layer behind the guard). No rate limit yet (T6.1). The public demo refuses POST (ADR 0018) |
| GET | `/qa/history` | `qa:ask` | Own questions only |
| POST | `/search/debug` | `qa:ask` | Internal, for debugging retrieval (T5.3); not used by the web app and `404` when `NODE_ENV=production` (POST is also refused on the demo). Body `{question (1–1,000 chars), topK? (1–20, default RAG_TOP_K)}`, anything else `400 BODY_INVALID`. `200 {model, topK, candidates, chunks: [{chunkId, documentId, documentVersion, invoiceId, kind, ordinal, content, refs, score, vectorRank, vectorDistance, ftsRank, ftsScore}]}`, best first; ranks are 1-based and `null` where that list did not return the chunk. The question cannot be embedded → `503 AI_SERVICE_UNAVAILABLE` |

### Insights
| Method | Path | Permission |
|---|---|---|
| GET | `/insights/extraction` | `insights:read` — `{online, offline}` (`ExtractionInsightsSchema` in `packages/contracts`). `online`: correction rate per field over approved PDF/image documents, from `current_invoices` + `current_field_corrections` (line/VAT columns grouped as `lines.*.amount`, one count per document), XML approvals counted apart, mean list-price cost per document. `offline`: aggregate numbers of the primary model's eval report read from `EVAL_REPORTS_DIR`, `null` when unavailable |

### Notifications
| Method | Path | Permission |
|---|---|---|
| GET | `/notifications` | authenticated (own) |
| POST | `/notifications/:id/read` | authenticated (own) |

### Admin (tenant_admin)
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/jobs?state=failed` | Failed jobs with reason |
| POST | `/admin/jobs/:id/retry` | Retry a failed job |

## Realtime (Socket.IO, namespace `/realtime`)
- Handshake requires the access token; server joins rooms `tenant:<id>` and `user:<id>`.
- Server events: `document.updated {id, status, progress?}`, `notification.created {id, type}`.
- Clients treat events as hints and refetch via REST (events can be missed).

## Internal API: AI service (not public)
| Method | Path | Body → Result |
|---|---|---|
| POST | `/extract` | multipart `{file, sourceType, schemaVersion?}` → `{invoice, warnings, usage}` (`invoice` includes `fieldMeta`, so no separate `confidence`; `usage` is `null` for xml); `sourceType` is `xml \| pdf \| image` (same as `documents.source_type`); `xml` → parser, `pdf/image` → LLM (501 `EXTRACTION_PATH_NOT_IMPLEMENTED` until M3). Errors: `{code, message}` — 422 `XML_*`, 413 `FILE_TOO_LARGE` |
| POST | `/index` | one row of the view `current_invoices` `{id, tenant_id, document_id, document_version, data}` (extra columns → 422) → `{model, chunks: [{chunk, embedding}]}`: T5.1 chunks, each with a unit vector of 768 numbers (T5.2). Called by the RAG index worker after an approval |
| POST | `/embed` | `{texts[] (1–512, each 1–8,000 chars), task: "query" \| "document"}` → `{vectors[], usage: {model, texts}}`: unit vectors of 768 numbers; `query` embeds a question for retrieval (T5.3) |
| POST | `/classify` | `{question (1–1,000 chars), today (YYYY-MM-DD)}` → `{output: QaRoute \| null, usage}`: `{intent: lookup \| aggregate \| out_of_scope, filter}`, the structured filter of an aggregate (`QaAggregateFilter`). The model sees the question only, never document content (T5.4). On both Q&A routes `output` is `null` when the model's text does not match the schema or was cut off (the API refuses with `ANSWER_REJECTED`); a provider failure keeps its code and status (`503 LLM_*`). Not retried |
| POST | `/answer` | `{question, sources: [{n, content}] (1–20, numbered 1..len in order, each ≤ 20,000 chars)}` → `{output: QaAnswer \| null, usage}`: `{insufficientEvidence, answer}` citing sources as `[n]`. Sources go to the model inside one JSON document; the model never sees a chunk id (T5.4) |

Reachable only on the internal Docker network. Every route except `/health` requires `Authorization: Bearer <AI_SERVICE_TOKEN>` (the same value in the API/worker and AI service environments, at least 16 characters; missing or wrong → `401 {code: "SERVICE_UNAUTHORIZED"}`, compared in constant time). Requests may carry a W3C `traceparent`, which the service echoes back when it is well formed. Worker classification: `401`/`403`/`404` mean our own settings are wrong, so they are retried and, if the attempts run out, the document fails as `AI_SERVICE_MISCONFIGURED` (not a file error; fix the setting, then retry from the admin job list). Every other `4xx` with a `code` (`XML_*`, `FILE_TOO_LARGE`, and on the LLM path `PDF_INVALID`, `PDF_TOO_MANY_PAGES`, `PDF_TOO_LARGE`, `IMAGE_UNSUPPORTED`, `LLM_REQUEST_REJECTED`, `LLM_NO_CANDIDATE`) and `501` are permanent: the document becomes `failed` with that code at once. Network errors, timeouts, a body cut off mid-read, `408`, `429` and `5xx` (except `501`) are transient (retried up to 5 attempts). When the attempts run out the document fails with the `code` the AI service sent (`LLM_UNAVAILABLE`, `LLM_RATE_LIMITED`, `LLM_TIMEOUT_OR_NETWORK`, `LLM_MISCONFIGURED`, `LLM_NOT_CONFIGURED`, `LLM_BAD_RESPONSE`), or `EXTRACTION_RETRIES_EXHAUSTED` when there is none (network error, proxy 502). The worker waits 15 s for an XML answer and `AI_LLM_TIMEOUT_MS` (default 60 s, above the service's own 55 s budget) for PDF/image.
