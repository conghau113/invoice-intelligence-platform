# ADR 0003: Tenant isolation with PostgreSQL Row-Level Security

- Status: Accepted
- Date: 2026-10-11

## Context
Multi-tenant SaaS with a shared database. A single forgotten `WHERE tenant_id = ?` would leak data between customers.

## Options considered
1. Application-level filtering only
2. Schema per tenant
3. Database per tenant
4. Shared schema + RLS + application filter

## Decision criteria
- Leak resistance to developer mistakes
- Operational cost at small scale
- Migration complexity
- Works with pgvector search

## Decision
Shared schema; every business table has `tenant_id`; RLS policies use a transaction-local setting `app.tenant_id`; the app role is not the table owner and RLS is forced; the application also filters explicitly.

## Consequences
- + Defense in depth: a missing filter returns zero rows instead of other tenants' rows
- + One migration path
- − Every request needs a transaction that sets the tenant
- − Policies must be tested (T1.8) and indexed on tenant_id

## Revisit when
Large enterprise tenants requiring physical isolation or per-tenant backups.
