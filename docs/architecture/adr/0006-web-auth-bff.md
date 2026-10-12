# ADR 0006: Web authentication via BFF (Auth.js on the Next.js server)

- Status: Accepted
- Date: 2026-10-11

## Context
Browser apps storing tokens in localStorage are exposed to XSS token theft.

## Options considered
1. SPA with keycloak-js and tokens in memory/localStorage
2. BFF: Next.js server holds tokens in httpOnly cookies
3. Separate gateway BFF service

## Decision criteria
- XSS blast radius
- Implementation effort
- Works with SSR

## Decision
Auth.js (stable major) Keycloak provider in Next.js; encrypted httpOnly cookie session; server components and route handlers attach the access token when calling the API; refresh rotation handled server-side.

## Consequences
- + Token never reachable by page JavaScript
- + SSR pages can call the API
- − Realtime socket needs a short-lived token fetched from the BFF
- − Must handle refresh failures carefully

## Revisit when
If a mobile client is added, it will use its own OIDC flow against Keycloak.
