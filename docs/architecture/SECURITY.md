# Security

> Scope: a portfolio system processing **synthetic** invoices. Controls are designed as if data were real so they can be demonstrated and discussed. Baseline references: OWASP ASVS (selected Level 1–2 items) and OWASP Top 10 for LLM Applications.

## 1. Threat model (summary)

| Asset | Threat | Main controls |
|---|---|---|
| Tenant data | Cross-tenant read/write | RLS + explicit tenant filter + isolation tests (T1.8, T5.7) |
| Accounts | Token theft, session fixation | OIDC Auth Code + PKCE, httpOnly SameSite cookies (BFF), short access tokens, refresh rotation |
| Upload pipeline | Malicious files, XXE, path traversal, oversized files | Streaming upload through the API with size limit, magic-byte check, server-generated keys, `defusedxml`, time limits |
| LLM features | Prompt injection (direct + via stored documents), data exfiltration, excessive cost | Instructions/data separation, schema-constrained output, citation verification, rules engine, rate limits, per-tenant quotas |
| Secrets | Leak via repo/logs | `.env` never committed or read by agents (hook), gitleaks in CI, secrets via GitHub Secrets / server env (Gemini key, DuckDNS token, backup key, SSH key) |
| Public demo | Abuse, cost, receiving real personal data, provider-terms violations | Read-only mode, no upload, no live LLM calls (ADR 0018) |
| Demo server | Remote compromise | SSH key only, password login disabled, only 80/443 open, containers non-root, automatic security updates |
| Logs/telemetry | PII leakage | Structured logs with redaction, no document content in logs/spans |

## 2. Authentication
- Keycloak realm `invoice`; one Organization per tenant (ADR 0005).
- Web uses the BFF pattern (ADR 0006): Auth.js handles the Authorization Code + PKCE flow on the server; tokens live in an encrypted httpOnly, `Secure`, `SameSite=Lax` cookie; the browser never sees the access token. Logout calls Keycloak end-session.
- API validates JWT signature via JWKS (cached, rotation-aware) and checks `iss`, `aud`, `exp`, `nbf`. No token → 401.

## 3. Authorization
- Roles: `tenant_admin`, `accountant`, `viewer`. Permissions are strings (`document:approve`) mapped from roles in one file; endpoints declare required permissions; deny by default.
- UI hides actions the user cannot perform (usability), the API enforces (security).

| Permission | tenant_admin | accountant | viewer |
|---|---|---|---|
| document:read | ✓ | ✓ | ✓ |
| document:create | ✓ | ✓ | |
| document:approve | ✓ | ✓ | |
| document:manage | ✓ | | |
| qa:ask | ✓ | ✓ | ✓ |
| insights:read | ✓ | ✓ | ✓ |
| tenant:manage | ✓ | | |

Demo account: read-only flag enforced in the API guard (non-GET methods rejected), not by role juggling.

## 4. File upload
- Uploads are streamed through the API (`POST /documents/upload`) to the file volume via `StoragePort` (ADR 0017); max 10 MB; allowed: PDF, PNG, JPEG, XML. Type verified by magic bytes; mismatch → `rejected`.
- Storage keys are server-generated (`tenant/<tenantId>/<uuid>`); user file names are metadata only; path traversal is tested.
- XML is parsed with `defusedxml` (XXE and entity-expansion attacks blocked).
- Download only through the API after a permission check; files are never served from a public path.
- Uploads are disabled entirely in the public demo.

## 5. Audit
Append-only `audit_logs` for: login (first seen), upload, approve, reopen, retry, role-relevant admin actions. Contains ids and action names, never extracted values.

## 6. AI-specific threats
- **Direct/indirect prompt injection (LLM01):** document content is supplied as data parts, never merged into instructions; outputs are schema-constrained; business rules flag implausible values; answers must cite retrieved chunks and the API verifies citations; test fixtures contain injection attempts (T3.6, T5.7).
- **Sensitive information disclosure (LLM02):** retrieval is tenant-scoped at the DB layer; the model only receives the retrieved chunks of the current tenant.
- **Improper output handling (LLM05):** model output is never executed; aggregate queries use a validated structured filter → parameterized SQL.
- **Unbounded consumption (LLM10):** per-tenant rate limits and daily quotas; demo account upload cap.
- **Data sent to providers:** synthetic data only. Gemini Unpaid Services terms allow use for product improvement and human review, and say not to submit personal information.
- **Provider terms:** the public demo does not call the Gemini free tier, because the terms require Paid Services for API clients made available to users in the EEA/Switzerland/UK (ADR 0018).

## 7. Logging and PII
- JSON logs with `trace_id`, `span_id`, `tenant_id`; redaction of emails, phone numbers, tax codes, person/company names via a shared logger config with tests.
- Spans carry model name and token counts, never prompts or document text.

## 8. Supply chain & platform
- Lockfiles committed; Dependabot; `pnpm audit`/OSV and `pip-audit` in CI; gitleaks on every push.
- Security headers + CSP (nonce-based for Next.js), strict CORS on the API, HTTPS only (Caddy).
- Containers run as non-root; internal services not exposed publicly (only Caddy on 80/443).

## 9. Legal
See `docs/LEGAL.md` (data protection, provider terms, licences of third-party components).

## 10. Review checklist (filled in T7.4)
A table of each control above with status `pass / fail / n.a.` and evidence link, stored in `docs/reports/security-review-v1.md`.
