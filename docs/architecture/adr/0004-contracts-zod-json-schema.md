# ADR 0004: Zod schemas as the single source of truth, exported to JSON Schema

- Status: Accepted
- Date: 2026-10-11

## Context
The Invoice structure is used by the web form, the API, the worker and the Python AI service (as the LLM response schema). Hand-maintaining it in two languages would drift.

## Options considered
1. Hand-written TS + Python models
2. OpenAPI-first generation
3. Zod in `packages/contracts`, exported to JSON Schema, Python models generated

## Decision criteria
- One place to change
- Runtime validation in TS
- Usable as LLM structured-output schema
- Drift detected automatically

## Decision
Zod schemas in `packages/contracts`; build exports JSON Schema; Python validates/generates pydantic models from it; CI fails if generated files are stale.

## Consequences
- + Form validation, API validation and LLM schema stay identical
- − Generation step to maintain
- − Some Zod features do not map to JSON Schema; keep schemas simple

## Revisit when
If a public API for third parties is needed, add OpenAPI as the published contract.
