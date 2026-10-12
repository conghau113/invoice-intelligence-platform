# ADR 0012: Rate limiting with token buckets in Redis

- Status: Accepted
- Date: 2026-10-11

## Context
Protect the API and the paid/limited LLM quota from bursts and abuse; fair usage across tenants.

## Options considered
1. In-memory limiter
2. Fixed window counter
3. Sliding window log
4. Token bucket in Redis (atomic Lua)

## Decision criteria
- Correct under multiple instances
- Allows short bursts
- Atomicity

## Decision
Token bucket per (tenant, user, route class) in Redis with an atomic script; 429 + Retry-After + RateLimit headers; stricter limits on upload and Q&A.

## Consequences
- + Works across instances
- + Burst-friendly
- − Redis dependency on the request path (fail-open for reads, fail-closed for uploads, documented)

## Revisit when
If an API gateway is introduced, move coarse limits there.
