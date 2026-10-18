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

The API reads **no dotfile** (`ignoreEnvFile: true`), so start it with its variables in the process environment, in its own terminal. These are the local dev values, not secrets:

```bash
NODE_ENV=development \
OIDC_ISSUER_URL=http://localhost:8080/realms/invoice \
DATABASE_URL=postgres://invoice_app:invoice-app-dev-only@localhost:5433/invoice \
pnpm --filter api start:dev
curl localhost:3001/health/ready   # {"status":"ok","checks":{"database":"ok"}}
```

`db:migrate` and `db:seed` are only needed on a fresh database and need `DATABASE_OWNER_URL` and `APP_DB_PASSWORD` too (see `apps/api/.env.example`). If the dashboard says "Service unavailable", the API is not running on :3001. After upgrading from an older build, restart `pnpm --filter web dev` and sign out and in once so the session carries your tenant list. Do not run `pnpm --filter web build` while the dev server is running: both write to `.next`.

1. Open http://localhost:3000/vi/login (or `/en/login`) and sign in. Keycloak asks for the username, then the password (two steps).
2. The app shell shows a sidebar whose items depend on your role, and the dashboard shows the tenant and permissions the API reports. `consultant@demo.example` gets a tenant dropdown in the header: switching it changes the tenant id on the dashboard without signing in again. Sign out with the header button, then sign in as another user to compare.
3. Design baseline: http://localhost:3000/vi/styleguide and `/en/styleguide` (light/dark toggle, language switcher).
4. API check with a token (dev client `dev-cli`, password grant, dev only): `GET http://localhost:3001/auth/me` returns the user, tenant and permissions.

## Try these

- `viewer@globex.example` calls an approve endpoint: API answers 403 (`FORBIDDEN`), enforced in the backend.
- `admin@acme.example` and `viewer@globex.example` each see only their own tenant's data (Postgres row-level security).
- `consultant@demo.example` picks a tenant with the header dropdown (the browser sends it as `X-Tenant`); a tenant the account does not belong to is refused by the API with 403.

## Current limits

- The menu links to pages that arrive in M2+ (documents, upload) or later; until then they show the translated 404.
- Business pages (upload, documents) come in M2, so the roles are visible today only through `/auth/me`, API 403s and the dashboard tenant.
