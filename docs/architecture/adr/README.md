# Architecture Decision Records

Format: lightweight MADR. One decision per file. Create new ones with `/adr`. Never edit an accepted ADR's decision; supersede it with a new ADR.

| # | Decision | Status |
|---|---|---|
| [0001](0001-monorepo-pnpm-turborepo.md) | Monorepo with pnpm workspaces and Turborepo | Accepted |
| [0002](0002-python-ai-service.md) | Separate Python service for AI functions | Accepted |
| [0003](0003-postgres-rls-tenant-isolation.md) | Tenant isolation with PostgreSQL Row-Level Security | Accepted |
| [0004](0004-contracts-zod-json-schema.md) | Zod schemas as the single source of truth, exported to JSON Schema | Accepted |
| [0005](0005-keycloak-organizations.md) | Keycloak with one realm and Organizations for tenants | Accepted |
| [0006](0006-web-auth-bff.md) | Web authentication via BFF (Auth.js on the Next.js server) | Accepted |
| [0007](0007-i18n-next-intl.md) | Internationalization with next-intl and locale-prefixed routes | Accepted |
| [0008](0008-queue-bullmq.md) | Background processing with BullMQ on Redis | Accepted |
| [0009](0009-llm-provider-gemini.md) | LLM provider: Gemini free tier behind a provider interface, plus one official-API fallback | Proposed — confirm with M4 numbers |
| [0010](0010-hosting-oracle-always-free.md) | Hosting: local development, public demo on Oracle Cloud Always Free (ARM) | Accepted — owner approved card verification on 2026-10-12 |
| [0011](0011-pgvector.md) | Vector search with pgvector inside PostgreSQL | Accepted |
| [0012](0012-rate-limiting.md) | Rate limiting with token buckets in Redis | Accepted |
| [0013](0013-caching.md) | Caching: cache-aside for reads and result cache by file hash | Accepted |
| [0014](0014-realtime-websocket-vs-fcm.md) | Realtime updates: WebSocket (Socket.IO) in-app; push notifications optional | Accepted |
| [0015](0015-observability-otel.md) | Observability with OpenTelemetry and Grafana Cloud | Accepted |
| [0016](0016-drizzle-orm.md) | Data access with Drizzle ORM and SQL migrations | Accepted |
| [0017](0017-storage-local-fs.md) | File storage: StoragePort with a local filesystem adapter (MinIO rejected) | Accepted |
| [0018](0018-public-demo-read-only.md) | Public demo is read-only and makes no live LLM calls | Accepted |
