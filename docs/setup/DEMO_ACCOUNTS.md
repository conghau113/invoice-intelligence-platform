# Demo accounts and roles (dev only)

Synthetic accounts from the Keycloak realm file `infra/keycloak/realm-invoice.json`. They exist only in the local dev stack (`pnpm infra:up`). Do not reuse these passwords anywhere; production removes them (see `docs/plan/TASKS.md`, "Phát sinh" T1.1).

## Accounts

All demo users share the password **`demo-dev-only`**.

| Username | Role | Tenant (organization) | Use it to see |
|---|---|---|---|
| `admin@acme.example` | `tenant_admin` | acme | Everything, including members and settings |
| `accountant@acme.example` | `accountant` | acme | Upload and approve invoices |
| `viewer@globex.example` | `viewer` | globex | Read-only: no write actions |
| `consultant@demo.example` | `accountant` | acme **and** globex | Switching tenant (two organizations) |

Tenants: `acme` (`00000000-0000-4000-8000-0000000000a1`), `globex` (`00000000-0000-4000-8000-0000000000a2`).

**Do not mix the two logins.** Web login uses the demo users above with `demo-dev-only`. The Keycloak admin console (http://localhost:8080) is a different account: username `admin` (no `@acme.example`), password `admin-dev-only` unless your own env file overrides `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`. `admin@acme.example` with `admin-dev-only` is rejected.

## What each role can do

Source of truth: `apps/api/src/modules/auth/permissions.ts` (table in `docs/architecture/SECURITY.md` section 3).

| Permission | viewer | accountant | tenant_admin |
|---|---|---|---|
| `document:read`, `qa:ask`, `insights:read` | yes | yes | yes |
| `document:create`, `document:approve` | no | yes | yes |
| `document:manage`, `tenant:manage` | no | no | yes |

Roles are realm roles, not per tenant: `consultant@demo.example` has `accountant` in both tenants.

## Run the demo

```bash
pnpm infra:up                     # Postgres 5433, Redis 6380, Keycloak 8080
pnpm --filter api db:migrate && pnpm --filter api db:seed
pnpm --filter api start:dev       # :3001
pnpm --filter web dev             # :3000
```

The API reads **no dotfile** (`ignoreEnvFile: true`), so its variables must be in the process environment. `pnpm dev:api` (`scripts/dev-api.mjs`) sets `NODE_ENV` and `OIDC_ISSUER_URL` and builds `DATABASE_URL` from the password of the `invoice_app` role, which it reads from `APP_DB_PASSWORD` (no password is stored in the repo). Export it once in your shell profile (`~/.bashrc`), using the value you gave the role in your own env file, then open a new terminal. Anything you already export (`DATABASE_URL`, `OIDC_ISSUER_URL`) wins. Run it in its own terminal:

```bash
pnpm dev:api
curl localhost:3001/health/ready   # {"status":"ok","checks":{"database":"ok","redis":"ok"}}
```

Uploaded documents are processed by the queue worker, a separate process. Without it they stay `queued`. Start it in another terminal with the same environment defaults (it also sets `REDIS_URL` to the Redis of `pnpm infra:up`):

```bash
pnpm dev:worker
```

`pnpm db:migrate`, `pnpm db:seed` and `pnpm db:seed:documents [acme|globex] [count]` (like `pnpm dev:api`) fill in the database variables themselves: the throw-away passwords of `compose.yaml` (owner `invoice` / `invoice-dev-only`, app role `invoice_app` / `invoice-app-dev-only`), port 5433. Whatever you export in your shell wins (`DATABASE_OWNER_URL`, `DATABASE_URL`, `APP_DB_PASSWORD`, `POSTGRES_*`), so keep exporting `APP_DB_PASSWORD` if your `invoice_app` role already has another password. They refuse to run when `NODE_ENV` is set to anything but `development` (unset is fine), and refuse to guess when `DATABASE_OWNER_URL`/`DATABASE_URL` name a host other than localhost. A tunnel to a real database through `localhost` is not detected: never point these at one. Run `pnpm db:migrate` on a fresh database **and again after pulling or finishing any task that adds a file under `apps/api/drizzle/`** (it is safe to repeat; it applies only what is missing). A dev database that was not migrated makes endpoints fail with `500 Internal server error` while `/auth/me` and `/health/ready` still answer, because the older tables exist (for example uploads fail with `relation "documents" does not exist` until T2.2 and T2.3 are applied). `db:seed` is only needed on a fresh database. `pnpm db:seed:documents acme 1000` adds 1.000 synthetic documents (all statuses and types, no stored file behind them) for trying the list page and paging. If the dashboard says "Service unavailable", the API is not running on :3001. After upgrading from an older build, restart `pnpm --filter web dev` and sign out and in once so the session carries your tenant list. Do not run `pnpm --filter web build` while the dev server is running: both write to `.next`.

1. Open http://localhost:3000/vi/login (or `/en/login`) and sign in. Keycloak asks for the username, then the password (two steps).
2. The app shell shows a sidebar whose items depend on your role, and the dashboard shows the tenant and permissions the API reports. `consultant@demo.example` gets a tenant dropdown in the header: switching it changes the tenant id on the dashboard without signing in again. Sign out with the header button, then sign in as another user to compare.
3. Design baseline: http://localhost:3000/vi/styleguide and `/en/styleguide` (light/dark toggle, language switcher).
4. API check with a token (dev client `dev-cli`, password grant, dev only): `GET http://localhost:3001/auth/me` returns the user, tenant and permissions.

## Run the automated tests (T1.8)

```bash
pnpm test:int   # Postgres in a throw-away container (Docker needed): row-level security from the real migrations
pnpm test:e2e   # Playwright; needs pnpm infra:up, pnpm dev:api and pnpm --filter web dev already running
```

Before the first `pnpm test:e2e` install the browser once: `pnpm --filter web exec playwright install chromium`. The e2e run stops with one message listing whichever of Keycloak, API or web is down. CI runs both (`integration` and `e2e` jobs).

## Try these

- `viewer@globex.example` calls an approve endpoint: API answers 403 (`FORBIDDEN`), enforced in the backend.
- `admin@acme.example` and `viewer@globex.example` each see only their own tenant's data (Postgres row-level security).
- `consultant@demo.example` picks a tenant with the header dropdown (the browser sends it as `X-Tenant`); a tenant the account does not belong to is refused by the API with 403.

## Current limits

- The menu links to pages that arrive in M2+ (documents, upload) or later; until then they show the translated 404.
- Business pages (upload, documents) come in M2, so the roles are visible today only through `/auth/me`, API 403s and the dashboard tenant.
