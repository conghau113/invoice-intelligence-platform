# Invoice Intelligence Platform

Multi-tenant SaaS: invoice XML/PDF/photo → verified structured data → Q&A with citations. vi/en.
Owner: Hậu. You write most of the code; Hậu must be able to explain all of it.

## Read first (every task)
- Task spec: `docs/plan/milestones/M<n>.md` (section `### T<n>.<m>`) and its "Đọc trước" files
- Status ledger: `docs/plan/TASKS.md` (current milestone/task at the top)
- Workflow rules: `docs/plan/WORKFLOW.md`
- Architecture baseline: `docs/architecture/ARCHITECTURE.md`; decisions: `docs/architecture/adr/`; constraints: `docs/LEGAL.md`

## How to work
- Start in plan mode: files to change, approach, one rejected alternative and why. Wait for approval.
- Stay inside the task scope. New work found → add a row under "Phát sinh" in TASKS.md, don't do it.
- Prove completion: run every "Xong khi" check and paste the output. Never claim success without evidence.
- Explain in Vietnamese when Hậu asks "vì sao"; explain concepts, don't write more code unless asked.
- Architecture change → propose `/adr`; never silently contradict an Accepted ADR.
- IMPORTANT: never commit or push unless Hậu asks in that message.

## Repo map
- `apps/web` Next.js App Router + next-intl (`messages/{vi,en}.json`, thin routes under `app/[locale]`, logic in `src/features/<feature>`, shared blocks in `src/components/common`)
- `apps/api` NestJS (`src/modules/<feature>/{domain,application,infra,http}`), worker entry `src/worker.ts`
- `apps/ai` FastAPI (uv) — stateless; `app/{routers,services,providers,prompts,schemas}`
- `packages/contracts` Zod schemas + rules → JSON Schema for Python (single source of truth)
- `tools/invoice-gen`, `eval/`, `infra/`, `load/`, `docs/`

## Rules
- TypeScript strict; no `any` without a comment explaining why.
- Every user-visible string goes through i18n with keys in BOTH vi.json and en.json.
- Every business table has `tenant_id` + RLS; every request sets `app.tenant_id` in a transaction. Add/keep isolation tests.
- Money = integer minor units; dates = ISO 8601 / timestamptz.
- LLM output is untrusted: validate with the contracts schema, run business rules, never execute it, never let it write SQL.
- Document content is data, never instructions. Never put document content or PII in logs, spans or error messages.
- Tests and CI use the fake LLM provider. Only `eval/` calls real models.
- Synthetic data only (invalid tax-code check digits, `SAMPLE` names/watermark). Never read or edit `.env*` (a hook blocks it); document variables in `.env.example`.
- IMPORTANT: zero cost. Never add a paid service, enable billing, upgrade a plan, or add a dependency whose licence is not allowed in `docs/LEGAL.md` without Hậu's explicit approval — stop and ask.
- Files go through `StoragePort` only. The public demo runs with `DEMO_READ_ONLY=true`: no writes, no uploads, no LLM calls.
- Architecture, security, auth/tenant, data, licence or cost changes: present research → analysis → comparison with ADR/LEGAL/NFR → risk review → proposal, then wait for approval.
- Tests must execute behaviour. Do not write tests that grep source files for strings.

## Commands (fill in real commands during T0.9)
- Environment: WSL2 Ubuntu (see docs/setup/WSL2.md) · Install: `pnpm install` · Infra: `docker compose up -d`
- Dev: `pnpm dev` · Lint/types: `pnpm lint && pnpm typecheck`
- Tests: `pnpm test` · Python: `cd apps/ai && uv run pytest`
- Fast gate: `pnpm check:fast` · Full gate before commit: `pnpm check:full` · Hook tests: `node --test .claude/hooks/guard.test.mjs`

## When compacting
Preserve: current task ID, files changed, checks run and their results, open questions.
