# ADR 0015: Observability with OpenTelemetry and Grafana Cloud

- Status: Accepted
- Date: 2026-10-11

## Context
A request crosses browser, Next.js, NestJS, a queue, a worker and a Python service. Debugging needs end-to-end traces correlated with logs and metrics.

## Options considered
1. Vendor SDKs (e.g. APM agents)
2. OpenTelemetry → Grafana Cloud free tier
3. Self-hosted Grafana stack on the demo VM

## Decision criteria
- Vendor neutrality
- Cost
- Memory footprint on the demo VM

## Decision
OpenTelemetry SDKs in all services, W3C traceparent propagated through HTTP and BullMQ job data, OTLP export to Grafana Cloud (free tier at time of writing: 50 GB traces, 50 GB logs, 10k metric series, 14-day retention — verify before relying on it).

## Consequences
- + CNCF standard, portable
- + No observability containers on the demo VM
- − Free tier limits may change
- − Must keep PII out of spans

## Revisit when
If Grafana Cloud terms change, switch exporter to a self-hosted collector + Tempo/Loki.
