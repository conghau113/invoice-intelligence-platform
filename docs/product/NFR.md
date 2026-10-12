# Non-Functional Requirements

> Targets are initial and **must be measured**. The "Measured" column is filled from reports in `docs/reports/` and `eval/reports/`. A target without a measurement is a hypothesis, not a claim.

| ID | Attribute | Target (v1) | How measured | Task | Measured |
|---|---|---|---|---|---|
| NFR-01 | Tenant isolation | 0 cross-tenant reads/writes in tests (DB, API, RAG) | Integration + e2e tests in CI | T1.8, T5.7 | |
| NFR-02 | API latency (reads) | p95 < 300 ms at 20 concurrent users on the local stack | k6 | T6.6 | |
| NFR-03 | Upload acknowledgment | p95 < 500 ms (excludes processing) | k6 | T6.6 | |
| NFR-04 | Extraction latency | p95 < 30 s per single-page document (provider dependent) | eval runner | T4.3 | |
| NFR-05 | Extraction accuracy | Threshold set from first baseline and recorded in ADR 0019 | eval runner | T4.2–T4.4 | |
| NFR-06 | Cost | Cost per document reported (computed at list price even when using the free tier); actual LLM spend = 0 | eval + metrics | T4.3, T7.3 | |
| NFR-07 | RAG quality | Retrieval hit@5 and citation precision reported; every answer cites or abstains | RAG eval | T5.6 | |
| NFR-08 | Resilience | No lost or duplicated jobs when AI service, worker or Redis restarts | failure drill | T6.7 | |
| NFR-09 | Rate limiting | Excess requests get 429 + Retry-After; provider 429 never fails a job before retries are exhausted | k6 + fake provider | T6.1, T6.2 | |
| NFR-10 | Observability | One trace spans web → api → worker → ai for an upload | Grafana screenshot | T7.1 | |
| NFR-11 | Web performance | LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 on key pages (Google "good" thresholds) | Lighthouse CI | T7.6 | |
| NFR-12 | i18n | 100% key parity vi/en; no hard-coded UI strings | CI script | T0.8 | |
| NFR-13 | Security | No unresolved High findings from dependency/secret scans; checklist in SECURITY.md passed | CI + review report | T7.4 | |
| NFR-14 | Recoverability | Daily encrypted backup stored outside the demo VM; restore and rebuild drill succeeds (RPO 24 h, RTO < 1 h for demo) | drill | T7.5 | |
| NFR-15 | Cost of hosting | 0 (local + Oracle Always Free + DuckDNS + GitHub Actions on a public repo); any paid item needs owner approval | billing pages | T4.7 | |
| NFR-16 | Legal | No real personal/business data anywhere; public demo read-only with no live LLM calls; third-party licences listed | review + CI licence check | T4.1, T4.7, T7.4 | |
