# API

> REST over HTTPS, JSON, base path `/api/v1`. OpenAPI is generated from NestJS decorators and published at `/api/docs` in non-production environments. This file is the human-readable contract; when it disagrees with the code, the PR must fix one of them.

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <access token>` issued by Keycloak. Deny by default; `@Public()` opts out (health only). |
| Tenant | Derived from the token's `organization` claim; the web asks for `organization:*`, so the token lists every tenant of the user, and header `X-Tenant: <alias>` selects one. The alias must be in that signed claim (else 403 `TENANT_NOT_MEMBER`); several tenants and no header → 403 `TENANT_REQUIRED`. The header only selects, it never grants. |
| Errors | RFC 9457 Problem Details: `{type, title, status, detail, instance, code, traceId}` |
| Pagination | `?page=1&limit=20` → `{items, meta: {page, limit, total, totalPages}}` (`page` from 1, at most 10 000; `limit` 1–100, default 20; ADR 0019). `total` is counted after tenant and filters. A `page` past `totalPages` answers empty `items` with the true `meta`. Append-only streams (audit, events) use cursors instead; none exists yet |
| Filtering/sorting | `?status=needs_review&type=xml&from=2026-09-01&to=2026-09-30&sort=-createdAt` — `type` is `xml`, `pdf` or `image`; `from`/`to` are whole days, both inclusive, in `Asia/Ho_Chi_Minh`; `sort` is `createdAt` or `-createdAt` (default), always followed by `id` as tie-breaker. Anything else is `400 INVALID_QUERY` |
| Idempotency | `Idempotency-Key` header on POSTs that create resources; replay returns the original response for 24 h |
| Concurrency | `If-Match: <rowVersion>` on approve/update; stale → `409` |
| Rate limits | `429` with `Retry-After` and `RateLimit-*` headers (ADR 0012) |
| Tracing | W3C `traceparent` accepted and propagated; `traceId` echoed in errors |
| Versioning | URL major version (`/v1`); additive changes only within a version |
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
| GET | `/documents/:id` | `document:read` | Includes latest extraction + warnings |
| GET | `/documents/:id/file` | `document:read` | Streams the file through the API after the permission check (no public file URLs) |
| POST | `/documents/:id/retry` | `document:manage` | Only from `failed` |
| POST | `/documents/:id/approve` | `document:approve` | Body = corrected Invoice; `If-Match` required |
| POST | `/documents/:id/reopen` | `document:approve` | `approved → needs_review`, version+1 |

### Q&A
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/qa/ask` | `qa:ask` | SSE stream: `token` events, then `citations`, then `done` |
| GET | `/qa/history` | `qa:ask` | Own questions only |

### Insights
| Method | Path | Permission |
|---|---|---|
| GET | `/insights/extraction` | `insights:read` — correction rate per field, cost per document |

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

Reachable only on the internal Docker network; requests carry a shared service token and `traceparent`.
