# API

> REST over HTTPS, JSON, base path `/api/v1`. OpenAPI is generated from NestJS decorators and published at `/api/docs` in non-production environments. This file is the human-readable contract; when it disagrees with the code, the PR must fix one of them.

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <access token>` issued by Keycloak. Deny by default; `@Public()` opts out (health only). |
| Tenant | Derived from the token's `organization` claim; if the user belongs to several, header `X-Tenant-Id` selects one and is checked against membership. Never trusted alone. |
| Errors | RFC 9457 Problem Details: `{type, title, status, detail, instance, code, traceId}` |
| Pagination | Cursor-based: `?limit=20&cursor=<opaque>` → `{items, nextCursor}` |
| Filtering/sorting | `?status=needs_review&from=2026-09-01&to=2026-09-30&sort=-createdAt` |
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
| GET | `/me` | authenticated — user, tenants, roles, permissions |
| GET | `/tenants/current/members` | `tenant:manage` |

### Documents
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/documents/upload` | `document:create` | `multipart/form-data` (one file ≤ 10 MB, streamed); type checked by magic bytes; dedupe by (tenant, sha256); `Idempotency-Key` required |
| GET | `/documents` | `document:read` | Paginated list with filters |
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
| POST | `/extract` | multipart `{file, sourceType, schemaVersion}` → `{invoice, confidence, warnings, usage}`; `xml` → parser, `pdf/png/jpeg` → LLM |
| POST | `/embed` | `{texts[]}` → `{vectors[], usage}` |
| POST | `/answer` | `{question, chunks[], locale}` → stream of tokens + `{citations[]}` |
| POST | `/plan-query` | `{question, locale}` → structured filter (validated schema) |

Reachable only on the internal Docker network; requests carry a shared service token and `traceparent`.
