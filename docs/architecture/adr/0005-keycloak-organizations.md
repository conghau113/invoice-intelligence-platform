# ADR 0005: Keycloak with one realm and Organizations for tenants

- Status: Accepted
- Date: 2026-10-11

## Context
Need OIDC login, roles and multi-tenancy. Keycloak is already on the CV and widely used in enterprise. Keycloak introduced Organizations (preview in 25, targeted as supported in 26) for B2B multi-tenancy.

## Options considered
1. One realm per tenant
2. One realm + Organizations
3. Managed IdP (Auth0/Clerk)
4. Roll-your-own auth

## Decision criteria
- Enterprise relevance
- Cost (free, self-hosted)
- Tenant onboarding effort
- Token carries tenant claim

## Decision
One realm `invoice`, one Organization per tenant, realm roles for permissions; organization claim in the access token; realm exported as code.

## Consequences
- + Tenant creation is data, not infrastructure
- + Realistic enterprise setup
- − Keycloak needs ~0.75–1 GB RAM
- − Organizations behaviour must be verified against the installed version in T1.1

## Revisit when
If memory on the demo VM is insufficient or Organizations does not meet needs, revisit with realm-per-tenant or a managed IdP.
