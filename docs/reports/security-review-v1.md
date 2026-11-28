# Security review v1 (T7.4)

Date: 2026-11-28. Scope: the controls in [`SECURITY.md`](../architecture/SECURITY.md) §1–§8, checked
against the repository at branch `task/T7.4-security` (base `main` 74d8ac0). Method: a reduced
OWASP ASVS pass (selected Level 1–2 items behind each control), dependency and licence scans, and
browser tests of the new Content-Security-Policy. Out of scope: an external penetration test and any
certification. The demo server itself (SSH, firewall, updates) is not deployed yet; its items are
`n.a.` here and belong to T7.5.

Status: **pass** = implemented and backed by the evidence given; **fail** = claimed in SECURITY.md
but missing or weaker than written; **n.a.** = not applicable yet. Every `fail` has a row under
"Phát sinh" in [`TASKS.md`](../plan/TASKS.md).

## Result

**Done-when of T7.4: no unhandled High.** At the end of this review:

| Scan | Command | Before T7.4 | After |
|---|---|---|---|
| npm advisories, prod + dev | `pnpm audit --audit-level high` | 6 high, 13 moderate, 1 low | **0 high**, 3 moderate (below) |
| npm advisories, prod only | `pnpm audit --prod` | 0 | 0 |
| Python advisories, every group of `uv.lock` | `pnpm --filter ai audit:py` (pip-audit 2.10.0) | 1 (certifi 2026.7.22, PYSEC-2026-4320) | **0** |
| Licences, npm + Python, dev included | `pnpm check:licences` | not enforced; 8 npm licence ids and 6 Python packages outside the allow-list | **0** outside the allow-list or a reviewed exception |
| Secrets in git history | `pnpm check:secrets` (gitleaks 8.30.0, pinned by digest) | 0 | 0 |

All the High findings were in the `shadcn` CLI, a dev dependency of `apps/web` that is run by hand to
add components and is never shipped: `zod` < 4.6.6 (GHSA-mrhx-c7xc-m3w5), `undici` 7 < 7.30.1 (six
advisories, e.g. GHSA-xjj6-f33q-929c), `systeminformation` < 5.33.16 (GHSA-3f7j-7jwc-fxfj, Windows
command injection). Fixed by upgrading `shadcn` to 4.23.1 (which also dropped the `hono` chain) and
by two `overrides` in `pnpm-workspace.yaml`, same major and licence. certifi was upgraded in
`uv.lock` to 2026.11.20; `uv.lock` is not one of the eval gate's pipeline files, so the extraction
baseline is unaffected.

Moderate findings left on purpose (all dev-only, none reachable from a request):

| Package | Advisory | Path | Why it is left |
|---|---|---|---|
| esbuild ≤ 0.24.2 | GHSA-67mh-4wv8-2f99 | `drizzle-kit` > `@esbuild-kit/*` | The advisory is about esbuild's development **server** (`serve`); drizzle-kit only uses it as a loader to read the schema. No newer drizzle-kit drops the chain yet |
| glob 9–14.0.1 | GHSA-3g3m-2fjr-6pw4 | `jest` > `babel-plugin-istanbul` | Test runner on our own files |
| minimatch 7–11.0.0 | GHSA-g3hv-75wg-m249 | `jest` > `jest-config` > `glob` | Same; patterns are ours |

From now on the CI job `supply-chain` (`.github/workflows/ci.yml`) runs all three scans on every
push and PR, and fails on High/Critical and on any licence outside
[`docs/legal/licence-policy.json`](../legal/licence-policy.json). Dependabot
(`.github/dependabot.yml`) proposes weekly grouped updates for npm, uv, GitHub Actions, Dockerfiles
and compose images.

## Checklist

### §1–2 Authentication

| Control | ASVS area | Status | Evidence |
|---|---|---|---|
| OIDC Authorization Code + PKCE + state, on the server (BFF) | V2, V3 | pass | `apps/web/src/auth/options.ts:34` (`checks: ['pkce', 'state']`); ADR 0006 |
| Session in an encrypted httpOnly, `SameSite=Lax` cookie, `Secure` on https; browser never sees the access token | V3.4 | pass | `apps/web/src/proxy.ts` (cookie options), `apps/web/src/proxy.test.ts` "marks cookies Secure and uses the __Secure- name on https" |
| Short access tokens, refresh rotation, single-flight refresh | V3.3 | pass | `infra/keycloak/realm-invoice.json:7-8` (`accessTokenLifespan` 300 s, `revokeRefreshToken`); `apps/web/src/auth/refresh.ts`; proxy tests "refreshes an expired access token…", "sends the user to /login … when Keycloak rejects the refresh token" |
| Logout ends the Keycloak session | V3.3 | pass | `apps/web/src/app/api/auth/logout`; e2e `app-shell.spec.ts` test 10, and `csp.spec.ts` (sign-out redirect still allowed by `form-action`) |
| API checks JWT signature (JWKS), `iss`, `aud`, `exp`, `nbf`; no token → 401 | V3.5 | pass | `apps/api/src/modules/auth/infra/jose-token-verifier.ts:29-30`; `apps/api/src/modules/auth/jwt-auth.guard.spec.ts` |
| Realtime token: 60 s HS256, `aud=realtime`, useless against REST; `Origin` allow-list; WebSocket only | V3.5, V13 | pass | `apps/api/test/realtime.int-spec.ts`; e2e `realtime.spec.ts` |
| Revocation of an open socket is immediate | V3.3 | **accepted risk** | Not claimed: SECURITY.md §2 states the 15-min lifetime. Phát sinh T6.4 stays open |
| Number of sockets per user/tenant is bounded | V11 | **fail** (known) | Not implemented; Phát sinh T6.4 (code-reviewer) stays open |

### §3 Authorization and tenant isolation

| Control | ASVS area | Status | Evidence |
|---|---|---|---|
| RLS on every business table, `FORCE`, non-owner app role; `app.tenant_id` set per transaction | V4.1, V4.2 | pass | `apps/api/test/tenant-isolation.int-spec.ts` (incl. "is not a superuser, does not bypass RLS and owns no table"); `apps/api/src/db/tenant-transaction.interceptor.spec.ts` |
| Tenant scoping of retrieval and Q&A | V4.2 | pass | `apps/api/test/qa-isolation.int-spec.ts`, `retrieval.int-spec.ts` |
| Permissions from one matrix, deny by default (undeclared route → 403) | V4.1 | pass | `apps/api/src/modules/auth/http/permissions.guard.spec.ts` |
| Notifications filtered by `user_id` too | V4.2 | pass | `apps/api/test/notifications.int-spec.ts` |
| Public demo: writes refused in three layers | V4 | pass | `apps/api/src/modules/auth/http/demo-read-only.guard.spec.ts`; READ ONLY transactions and read-only volume (T4.7 rehearsal, `infra/prod/README.md`) |
| **CORS: no browser origin may call the API** (new, T7.4) | V14.5 | pass | `apps/api/src/common/http/cors-policy.ts`; `cors-policy.spec.ts`: no `Access-Control-*` header for any origin, a preflight finds no route (drill: `origin: true` turns all 4 tests red). The spec proves the policy, not that `main.ts` calls it; without the call Nest sends no CORS header either, so a missing call fails safe. The AI service has no CORS middleware and is not published |

### §4 File upload

| Control | ASVS area | Status | Evidence |
|---|---|---|---|
| Streamed through the API, 10 MB limit, magic-byte check | V12.1, V12.2 | pass | `apps/api/src/modules/documents/domain/file-type.spec.ts`, `documents/http/documents-upload.spec.ts`, `test/documents-http.int-spec.ts` |
| Server-generated keys, path traversal tested | V12.3 | pass | `apps/api/src/modules/storage/infra/local-fs.storage.spec.ts` |
| XML through `defusedxml` (XXE, billion laughs, quadratic blow-up) | V5.5 | pass | `apps/ai/tests/test_xml_invoice.py`, fixtures `apps/ai/tests/fixtures/xml_attacks/` |
| Files only through the API after a permission check, served inert (`nosniff`, `CSP: sandbox`, `no-store`) | V12.5 | pass | `apps/api/src/modules/documents/http/documents.controller.ts:66-67`; `apps/web/src/app/api/documents/[id]/file/route.test.ts:48-49` |
| Uploads off in the public demo | — | pass | `DemoReadOnlyGuard` (above) |

### §5 Audit

| Control | ASVS area | Status | Evidence |
|---|---|---|---|
| Append-only `audit_logs` for upload, approve, reopen, retry; ids and action names only | V7.1, V7.2 | pass | `apps/api/test/documents-create.int-spec.ts`, `documents.int-spec.ts`, `review.int-spec.ts` |
| Caller address only from trusted proxies; invalid value dropped | V7.1 | pass | SECURITY.md §5; `TRUSTED_PROXIES` refuses `true` and `/0` at start (`apps/api/src/config/trusted-proxies.ts`, called from `env.schema.ts:72`) |

### §6 AI-specific threats

| Control | Status | Evidence |
|---|---|---|
| LLM01 prompt injection: data parts, schema-constrained output, rules, injection fixtures | pass (residual risks listed in SECURITY.md §6) | `apps/ai/tests/test_injection.py`; eval split `injection-*` in `eval/datasets/v1` |
| LLM02 disclosure: retrieval scoped to the tenant in the DB | pass | `apps/api/test/qa-isolation.int-spec.ts` |
| LLM05 output never executed; filters → parameterized SQL | pass | `apps/api/test/insights.int-spec.ts`; SECURITY.md §6 |
| LLM10 unbounded consumption: per-tenant rate limits | pass | `apps/api/test/rate-limit.int-spec.ts`; `apps/api/src/modules/rate-limit/domain/policies.ts` |
| LLM10: **daily quotas** per tenant | **fail** | SECURITY.md §6 says "per-tenant rate limits and daily quotas". Only token buckets exist (per user and per tenant, refilling continuously); nothing caps a tenant's total per day. New row under Phát sinh |
| Public demo makes no LLM call | pass | ADR 0018; `DEMO_READ_ONLY` |

### §7 Logging and PII

| Control | Status | Evidence |
|---|---|---|
| JSON logs with redaction, same cases in Node and Python | pass | `packages/logger/fixtures/redaction-cases.json`, `packages/logger/test/redact.spec.ts`, `logger.spec.ts`, `apps/ai/tests/test_logging.py` |
| Spans carry model and tokens, never prompts or text | pass | `apps/ai/tests/test_otel.py::test_llm_span_holds_no_prompt_and_no_answer` (T7.1) |
| Web server output (Phát sinh T7.2): does `next start` print the OAuth callback URL with `?code=…&state=…`? | pass | Checked on a production build (`next start`, port 3100): requests to `/api/auth/callback/keycloak?code=PROBE_CODE_123&state=PROBE_STATE` and `/vi/documents?q=PROBE_QUERY` left no trace in the output (0 matches). Residual: next-auth prints its own errors as plain text, not JSON and not through the redactor (seen: "State cookie was missing", no code or state value). Moving them behind `packages/logger` stays in the T7.2 row |
| Redis cache entries removed early on tenant deletion | **accepted risk** (known) | SECURITY.md §7 states TTL only; Phát sinh T6.3 |

### §8 Supply chain and platform

| Control | ASVS area | Status | Evidence |
|---|---|---|---|
| Lockfiles committed | V10.3 | pass | `pnpm-lock.yaml`, `apps/ai/uv.lock`; CI installs with `--frozen-lockfile` / `--frozen` |
| `pnpm audit` and `pip-audit` in CI (new) | V10.3, V14.2 | pass | job `supply-chain`; table "Result" above. Negative check: a requirement list with `certifi==2026.7.22` makes the same pip-audit command report PYSEC-2026-4320 and exit 1 | Residual: `uvx` pins pip-audit itself, not its own dependencies (resolved fresh in CI). Accepted: the job holds no secret and only reads the exported list
| Licence allow-list enforced in CI (new) | — | pass | `scripts/licences.mjs`, `docs/legal/licence-policy.json`; `scripts/licences.test.mjs` runs the real gate on committed fixtures: copyleft, `MIT AND GPL`, a changed licence string under an exception, an unreadable "BSD License" classifier and stale notices each fail |
| `THIRD_PARTY_NOTICES.md` generated from the lockfiles (new) | — | pass | `pnpm gen:notices`; 318 npm and 48 Python packages shipped, manual entries kept; drift fails `check:licences` |
| Dependabot (new) | V14.2 | pass | `.github/dependabot.yml` |
| Actions pinned by commit SHA, gitleaks image by digest (Phát sinh T0.7) | V10.3 | pass | `.github/workflows/ci.yml`, `eval.yml`, `package.json` `check:secrets`; digest `sha256:691af3c7…` matches what CI pulled since T0.7. Actions are updated by Dependabot; the gitleaks digest by hand |
| gitleaks on every push | V14.1 | pass | job `secrets` |
| **CSP with a per-response nonce on every page** (new) | V14.4, V5.3 | pass | `apps/web/src/lib/csp.ts`, `apps/web/src/proxy.ts`; unit `csp.test.ts`, `proxy.test.ts` ("content security policy (T7.4)"); browser `e2e/csp.spec.ts`, see below | Exception: next-auth's own HTML pages under `/api/auth/*` (`error`, `signout`) are skipped with the rest of `/api/*`; they hold no script and no user data, and the app only links to its own `/login` page
| Other security headers: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, no `X-Powered-By` | V14.4 | pass | `apps/web/next.config.ts` (everywhere the web runs) and `infra/prod/Caddyfile` (demo) |
| HTTPS only, HSTS | V9.1 | pass (config) | `infra/prod/Caddyfile` (HSTS one year; port 80 only redirects); live check with T7.5 |
| Containers run as non-root | V14.1 | pass | `USER` in `apps/web/Dockerfile:30`, `apps/api/Dockerfile:41`, `apps/ai/Dockerfile:15` |
| Only Caddy publishes ports (80/443); API, AI, DB, Redis, Keycloak admin internal | V14.1 | pass (config) | `infra/prod/compose.prod.yaml:42-44`; Caddy routes only the app realm of Keycloak |
| AI service API docs (`/docs`, `/openapi.json`) | V14.3 | **fail** (minor) | Served without the service token (200 on the local stack). Reachable only inside the compose network, so it leaks the schema to a process already inside; turning them off in production is a new Phát sinh row |
| SSH key only, password login off, automatic updates on the demo VM | V14.1 | n.a. | No server yet (T7.5) |

## The Content-Security-Policy

Production policy (realtime off, as on the demo):

```text
default-src 'self'; script-src 'self' 'nonce-<16 random bytes>' 'strict-dynamic'; style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none';
base-uri 'none'; form-action 'self' <Keycloak origin>; frame-ancestors 'none'; upgrade-insecure-requests (https only)
```

- **What it blocks.** A script the server did not render for this response: injected `<script>`,
  inline event handlers (`onerror=`), `javascript:` URLs, scripts from other origins, plugins, a
  `<base>` that re-points relative URLs, the page inside a frame (clickjacking), and form posts to
  other sites. It does not stop a bug in our own scripts, and `style-src 'unsafe-inline'` still lets
  injected markup change how a page looks (no code runs from CSS).
- **Why a nonce.** Next writes inline scripts into every page (the data that hydrates React). With a
  fixed policy the only way to let them run is `script-src 'unsafe-inline'`, which lets an injected
  script run too. The proxy makes a fresh nonce per response and puts the policy on the request as
  well; Next reads the nonce from it while rendering and adds it to every script tag it writes.
  `'strict-dynamic'` lets those trusted scripts load the chunks they need without a host list.
- **Cost.** Pages must be rendered per request. They already were (the root layout reads the theme
  cookie), so no page changed mode; the build shows every route as dynamic except Next's built-in
  `/_not-found`, which is static and therefore has no nonce: if Next ever serves it, it shows its
  HTML but runs no script. T7.6 measures the pages under this policy.
- **No eval in production, including the libraries.** Zod 4 probes `Function("")` the first time it
  parses, to decide whether to compile schemas; the policy refuses it and the browser reports a
  `script-src` violation on every page (Zod then falls back, so nothing broke, but the noise would
  hide a real violation). `apps/web/src/instrumentation-client.ts` sets `jitless` before the app
  runs, so the probe never happens. This only showed on production builds in CI: development allows
  `'unsafe-eval'`, and the first local production check covered the public login page only.
- **`style-src 'unsafe-inline'`** is required because React renders `style=""` attributes (progress
  bars, column widths). A nonce there would make browsers ignore `'unsafe-inline'`.

Browser evidence (`apps/web/e2e/csp.spec.ts`, Chromium; run on the local dev stack with the fake
provider, and the first two tests also against a production build on port 3100):

| Test | Result |
|---|---|
| Every page has a nonce policy that differs per response; every `<script>` in the HTML carries it | pass (dev and production) |
| Injected markup (`<img onerror>`, `<a href="javascript:">`) does not run, and a `script-src-attr` violation is reported | pass (dev and production) |
| Dashboard, documents, insights, ask, upload with the realtime socket, PDF review (pdf.js worker draws the page and fills the text layer), sign-out through Keycloak: zero violations on our origin | pass (dev stack) |
| Drill: `worker-src 'none'` | the PDF test fails as it should; policy restored |

CI runs the whole e2e suite, `csp.spec.ts` included, against production builds.

## Earlier findings handed to T7.4 ("Phát sinh")

| Row | Outcome |
|---|---|
| T0.2, T1.8: licences outside the allow-list (LGPL libvips, CC-BY caniuse-lite, 0BSD, BlueOak, Unlicense, CC0) | Each one is a named exception with a reason in `docs/legal/licence-policy.json` (allow-list unchanged, Hậu's decision 2026-11-28) |
| T0.7: actions pinned by tag, no Dependabot for workflows, gitleaks by tag | Pinned by SHA and digest. Dependabot (`github-actions`) updates the action SHAs; it does not read the `docker run` line, so the gitleaks digest is bumped by hand (new Phát sinh row) |
| T0.7: `check:full` has no dependency scan | `check:full` now runs `check:licences` and `audit:deps` |
| T1.6b: `THIRD_PARTY_NOTICES.md` hand-written | Generated part added below a marker; the manual section is kept |
| T3.1, T3.4: notices of pypdfium2 and pdfjs-dist | In the manual section of `THIRD_PARTY_NOTICES.md` |
| T3.4: no app-wide CSP | Done (above) |
| T4.1: IBM Plex Sans/Mono (OFL-1.1) without a LEGAL row | Row added to `docs/LEGAL.md` §3, on the same grounds as Tinos/Arimo |
| T4.2: `regression-00` carries only `SAMPLE`, not `SAMPLE – SYNTHETIC DATA` | Recorded as a known exception in `docs/LEGAL.md` §1: the frozen dataset cannot change without a `v2` |
| T7.2: Next.js server output | Checked on `next start` (above); the next-auth plain-text errors stay in the T7.2 row |
| T4.1: Playwright versions in Python and npm move together by hand | Not a security control; left open |
| T6.3, T6.4: cache deletion per tenant, socket revocation and limits | Accepted / open, as listed in the checklist |

## Reproduce

```bash
pnpm audit --audit-level high        # npm, prod + dev
pnpm --filter ai audit:py            # Python, every group of uv.lock
pnpm check:licences                  # licences + notices drift
pnpm check:secrets                   # gitleaks (Docker)
pnpm --filter web exec vitest run src/lib/csp.test.ts src/proxy.test.ts
pnpm --filter api exec jest src/common/http/cors-policy.spec.ts
# browser: stack running with the fake provider (LLM_PROVIDER=fake pnpm dev:stack), then
pnpm --filter web exec playwright test e2e/csp.spec.ts
```
