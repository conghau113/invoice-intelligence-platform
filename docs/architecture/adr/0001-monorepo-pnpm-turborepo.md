# ADR 0001: Monorepo with pnpm workspaces and Turborepo

- Status: Accepted
- Date: 2026-10-11

## Context
Three deployables (Next.js, NestJS, FastAPI) and shared contracts, built by one developer working mostly through an AI agent. The agent needs to see the whole system to make cross-cutting changes safely.

## Options considered
1. Monorepo (pnpm workspaces + Turborepo)
2. Polyrepo (one repo per service)
3. Monorepo with Nx

## Decision criteria
- Agent context in one place
- Atomic cross-service changes
- CI simplicity
- Reviewer opens one repo

## Decision
Monorepo with pnpm workspaces and Turborepo. Python app lives in `apps/ai` with its own `uv` project; Turborepo runs its scripts via package.json wrappers.

## Consequences
- + One CLAUDE.md, one CI, contract changes land atomically
- + Turborepo caching keeps CI fast
- − Two toolchains (pnpm, uv) in one repo need clear scripts
- − Nx would give richer generators; not needed at this size

## Revisit when
More than one team owns services, or deploy cadences diverge strongly.
