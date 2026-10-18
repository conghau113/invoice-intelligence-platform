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

1. Open http://localhost:3000/vi/login (or `/en/login`) and sign in. Keycloak asks for the username, then the password (two steps). A user in two organizations first sees "Select an organization".
2. The dashboard shows the tenant you signed in to. Sign out with the button, then sign in as another user to compare.
3. Design baseline: http://localhost:3000/vi/styleguide and `/en/styleguide` (light/dark toggle, language switcher).
4. API check with a token (dev client `dev-cli`, password grant, dev only): `GET http://localhost:3001/auth/me` returns the user, tenant and permissions.

## Try these

- `viewer@globex.example` calls an approve endpoint: API answers 403 (`FORBIDDEN`), enforced in the backend.
- `admin@acme.example` and `viewer@globex.example` each see only their own tenant's data (Postgres row-level security).
- `consultant@demo.example` signs in with `?tenant=acme` or `?tenant=globex` to pick a tenant; without it Keycloak asks.

## Current limits

- The app shell, role-based menu and tenant switcher are task T1.7; until then the web only has login, dashboard and styleguide.
- Business pages (upload, documents) come in M2, so the roles are visible today only through `/auth/me`, API 403s and the dashboard tenant.
