# Invoice Intelligence Platform *(working name)*

Multi-tenant SaaS that turns invoices — Vietnamese e-invoice XML, PDFs, photos — into verified structured data, and answers questions about them with cited sources. Vietnamese & English.

> **Status:** planning complete (architecture frozen, 18 ADRs, 70 tasks). Implementation in progress — see [task ledger](docs/plan/TASKS.md).
> Demo link, metrics and screenshots will appear here as milestones complete.

- **Project overview (for reviewers):** [English](docs/PROJECT_OVERVIEW.md) · [Tiếng Việt](docs/PROJECT_OVERVIEW.vi.md)
- **Architecture:** [ARCHITECTURE](docs/architecture/ARCHITECTURE.md) · [Data model](docs/architecture/DATA_MODEL.md) · [API](docs/architecture/API.md) · [AI pipeline](docs/architecture/AI_PIPELINE.md) · [Security](docs/architecture/SECURITY.md) · [ADRs](docs/architecture/adr/README.md)
- **Product:** [PRD](docs/product/PRD.md) · [NFR](docs/product/NFR.md)
- **Plan:** [Roadmap](docs/plan/ROADMAP.md) · [Workflow](docs/plan/WORKFLOW.md) · [Feasibility](docs/plan/FEASIBILITY.md)
- **Legal & data policy:** [LEGAL](docs/LEGAL.md) · **Setup:** [WSL2](docs/setup/WSL2.md) · [Oracle demo](docs/setup/ORACLE.md)

**Stack:** Next.js · React · TypeScript · NestJS · Python/FastAPI · PostgreSQL + pgvector (RLS) · Redis/BullMQ · Keycloak · OpenTelemetry · Docker · GitHub Actions

All data in this repository is synthetic. Running cost: €0.
