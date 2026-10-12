# ADR 0008: Background processing with BullMQ on Redis

- Status: Accepted
- Date: 2026-10-11

## Context
Extraction takes seconds to tens of seconds and calls rate-limited providers. It must not run inside HTTP requests.

## Options considered
1. Synchronous processing
2. BullMQ (Redis)
3. RabbitMQ
4. Kafka
5. Postgres-based queue (pg-boss)

## Decision criteria
- Retries/backoff/rate limiting built in
- Ops footprint on one VM
- Fit with NestJS
- Learning value

## Decision
BullMQ with a dedicated worker process; job payload holds ids + traceparent only; attempts with exponential backoff + jitter; limiter matched to provider RPM.

## Consequences
- + Redis already needed for cache/rate limit/pub-sub
- + Mature NestJS integration
- − Redis is a single point of failure on one VM (acceptable for demo, documented)
- − Kafka-style event streaming is out of scope (see interview notes)

## Revisit when
Multiple consuming services or event replay needs → consider Kafka/NATS; strict durability needs → pg-boss.
