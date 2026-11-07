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

An upload writes one row: `document.created`, or `document.upload_duplicate` when the same bytes already exist in the tenant (a replay of the same `Idempotency-Key` is the same upload and adds none). Each row has the actor, tenant, time and the caller's address; `meta` holds only `sourceType`, never the file name, storage key or bytes. The address is the real caller's when a reverse proxy passes `X-Forwarded-For` and the proxy is listed in `TRUSTED_PROXIES` (default `loopback`; entries that would trust everyone, such as `true` or a `/0` range, are refused at start). From any other peer the header is ignored. Two conditions make the address trustworthy: the proxy in front of the web server must overwrite (not append to) `X-Forwarded-For`, and the web server passes the header on only when `TRUST_FORWARDED_FOR=true` (off by default; otherwise a user could choose the address). A value that is not an IP address is dropped before the insert (the column is `inet`), so a bad header cannot fail an upload.

## 6. AI-specific threats
- **Direct/indirect prompt injection (LLM01):** document content is supplied as data parts, never merged into instructions; outputs are schema-constrained; business rules flag sums that disagree, a zero total, a badly formatted tax code, a future date and an unknown currency; Q&A answers will have to cite retrieved chunks, verified by the API (planned, M5); test fixtures contain injection attempts (T3.6, T5.7). **Residual risks (T3.6):**
  - A document can still talk the model into values that are well-formed and add up (other non-zero amounts, another seller name or tax code). Rules cannot see that. The last line of defence is that nothing is approved without a person comparing the form with the original (`needs_review`).
  - `confidence` and `evidence` are the model's own claims. A falsified field can report high confidence, so it is not highlighted, and cite a real excerpt from elsewhere on the page. Do not read a clean form as a verified one (the review screen's legend says so, T3.7); comparing values with the PDF text layer is planned with T4.4.
  - Known metadata is removed before a provider sees a file; this is a reduction, not a guarantee that only pixels travel. A PDF is re-rendered, so its metadata and invisible text stay behind. An uploaded image is rebuilt from an allow-list (T4.1b, `services/image_normalize.py`): PNG keeps one each of `IHDR`, `PLTE` (palette images only), `tRNS` and fixed-size `gAMA`/`cHRM`/`sRGB`, plus `IDAT` and `IEND`; JPEG keeps validated tables, frame and scans, with JFIF and Adobe headers written by us. EXIF, XMP, ICC profiles, comments, thumbnails, MPF, unknown blocks, and bytes after `IEND`, `EOI` or the zlib stream are dropped. The stored original, its hash and the viewer are unchanged. A picture with an EXIF rotation is turned in its pixels and sent as PNG, which also removes what the JPEG structure could hold.
  - What this cleaning cannot stop:
    - **Compressed data is copied as it is.** Without decoding, bytes after the last block of a JPEG scan and the compressed image data itself can hold up to megabytes chosen by an attacker. Valid JPEG tables can hold up to 64 KB (capped), a PNG palette 768 bytes. Nothing suggests a provider reads these as text, but it is outside our control. Closing them needs decoding and re-encoding every picture, which was not chosen: there is no JPEG encoder without Pillow, and a PNG of every photo is far larger.
    - **What a model reads in the pixels.** Text printed on a picture, near-white text and annotations with an appearance stream are visible to the model and may be overlooked by a person (measured in T4.3, T4.4).
    - **The model and the person may not see the same picture.** The viewer shows the original. Pixels under full transparency in a PNG can read differently once a provider flattens them, a PNG's `eXIf` rotation is dropped and not applied, and an animated PNG reaches the model as its default image only (`TASKS.md`, Phát sinh).
    - **Damage inside the compressed data** of a JPEG with a sound structure is not detected unless it has to be turned.
  - PDFium can crash the process on a malformed JPEG (SIGSEGV, not an exception; found in review of T4.1b with a flipped byte in a Huffman table), and it has no time limit. JPEG structure is validated before PDFium sees it, and every header byte was swept without a crash, but that is evidence about the cases tried, not proof. The service has no process isolation around PDFium, for pictures or for PDFs (`TASKS.md`, Phát sinh).
  - An injection sentence that is transcribed stays in the extracted data as an ordinary string, and becomes input for Q&A later (T5.7).
  - Whether a given model resists is measured in M4, not by the tests (they use a fake provider).
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
