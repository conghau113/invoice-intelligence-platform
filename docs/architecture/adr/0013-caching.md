# ADR 0013: Caching: cache-aside for reads and result cache by file hash

- Status: Accepted
- Date: 2026-10-11

## Context
Dashboard and list queries repeat; identical files re-uploaded across time would waste LLM calls.

## Options considered
1. No cache
2. HTTP caching only
3. Cache-aside in Redis
4. Materialized views

## Decision criteria
- Correctness (tenant isolation)
- Invalidation complexity
- Cost savings

## Decision
Cache-aside in Redis with tenant in every key and short TTL + explicit invalidation on writes; extraction result cache keyed by (content_hash, model, prompt_version).

## Consequences
- + Fewer LLM calls, faster dashboards
- − Invalidation bugs possible (tests required)
- − Stampede risk mitigated with request coalescing

## Revisit when
If cache hit rate measured in T6.3 is low, remove the read cache.
