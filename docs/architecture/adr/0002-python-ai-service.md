# ADR 0002: Separate Python service for AI functions

- Status: Accepted
- Date: 2026-10-11

## Context
Extraction needs PDF rasterization, image handling and LLM SDKs; RAG needs chunking and embeddings. The Python ecosystem is strongest here. The rest of the system is TypeScript.

## Options considered
1. AI code inside NestJS
2. Separate stateless FastAPI service
3. Serverless functions per AI task

## Decision criteria
- Library ecosystem
- Isolation of slow/variable workloads
- Operational simplicity
- Learning value (polyglot, service boundary)

## Decision
Stateless FastAPI service called by the worker/API over the internal network. No database access, no user identity.

## Consequences
- + Best libraries (pypdfium2, pydantic, provider SDKs)
- + Slow LLM calls isolated from API latency
- − Extra network hop, contract to keep in sync (mitigated by ADR 0004)
- − Two languages to maintain

## Revisit when
If AI work shrinks to one provider call with no file processing, fold it back into the worker.
