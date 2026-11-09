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
| Demo mode | When `DEMO_READ_ONLY=true` every non-GET request returns `403` with code `DEMO_READ_ONLY`, and `/qa/ask` serves only precomputed answers (ADR 0018) |
| Routing | Behind Caddy: web at `/`, API at `/api` on the same origin (no CORS needed in production) |

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
| POST | `/qa/ask` | `qa:ask` | SSE stream: `token` events, then `citations`, then `done` |
| GET | `/qa/history` | `qa:ask` | Own questions only |

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
| POST | `/embed` | `{texts[]}` → `{vectors[], usage}` |
| POST | `/answer` | `{question, chunks[], locale}` → stream of tokens + `{citations[]}` |
| POST | `/plan-query` | `{question, locale}` → structured filter (validated schema) |

Reachable only on the internal Docker network. Every route except `/health` requires `Authorization: Bearer <AI_SERVICE_TOKEN>` (the same value in the API/worker and AI service environments, at least 16 characters; missing or wrong → `401 {code: "SERVICE_UNAUTHORIZED"}`, compared in constant time). Requests may carry a W3C `traceparent`, which the service echoes back when it is well formed. Worker classification: `401`/`403`/`404` mean our own settings are wrong, so they are retried and, if the attempts run out, the document fails as `AI_SERVICE_MISCONFIGURED` (not a file error; fix the setting, then retry from the admin job list). Every other `4xx` with a `code` (`XML_*`, `FILE_TOO_LARGE`, and on the LLM path `PDF_INVALID`, `PDF_TOO_MANY_PAGES`, `PDF_TOO_LARGE`, `IMAGE_UNSUPPORTED`, `LLM_REQUEST_REJECTED`, `LLM_NO_CANDIDATE`) and `501` are permanent: the document becomes `failed` with that code at once. Network errors, timeouts, a body cut off mid-read, `408`, `429` and `5xx` (except `501`) are transient (retried up to 5 attempts). When the attempts run out the document fails with the `code` the AI service sent (`LLM_UNAVAILABLE`, `LLM_RATE_LIMITED`, `LLM_TIMEOUT_OR_NETWORK`, `LLM_MISCONFIGURED`, `LLM_NOT_CONFIGURED`, `LLM_BAD_RESPONSE`), or `EXTRACTION_RETRIES_EXHAUSTED` when there is none (network error, proxy 502). The worker waits 15 s for an XML answer and `AI_LLM_TIMEOUT_MS` (default 60 s, above the service's own 55 s budget) for PDF/image.
