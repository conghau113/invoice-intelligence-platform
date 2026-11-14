# Non-Functional Requirements

> Targets are initial and **must be measured**. The "Measured" column is filled from reports in `docs/reports/` and `eval/reports/`. A target without a measurement is a hypothesis, not a claim.

| ID | Attribute | Target (v1) | How measured | Task | Measured |
|---|---|---|---|---|---|
| NFR-01 | Tenant isolation | 0 cross-tenant reads/writes in tests (DB, API, RAG) | Integration + e2e tests in CI | T1.8, T5.7 | |
| NFR-02 | API latency (reads) | p95 < 300 ms at 20 concurrent users on the local stack | k6 | T6.6 | |
| NFR-03 | Upload acknowledgment | p95 < 500 ms (excludes processing) | k6 | T6.6 | |
| NFR-04 | Extraction latency | p95 < 30 s per single-page document (provider dependent) | eval runner | T4.3 | Primary `gemini-3.5-flash-lite`: p95 12.3 s, p50 4.6 s (single-page, `core`, free tier, 2026-11-09, output cap 12,288; 7.1 s on 2026-11-08 with the same model: free-tier latency varies by day). Longest invoice (54 lines, 2 pages): 15.6–25.6 s, inside the 55 s budget. `gemini-3.1-flash-lite` on the same set: p95 26.1 s (T4.4, `eval/reports/compare-v1.md`) |
| NFR-05 | Extraction accuracy | Threshold set from first baseline and recorded in ADR 0020 | eval runner | T4.2–T4.4 | Floors on `core` for `gemini-3.5-flash-lite` (ADR 0020; re-measured 2026-11-09, T4.5b): 99% on 7 critical fields, 92% on `seller.taxCode`, line F1 97 |
| NFR-06 | Cost | Cost per document reported (computed at list price even when using the free tier); actual LLM spend = 0 | eval + metrics | T4.3, T7.3 | Primary `gemini-3.5-flash-lite`: $0.00450 per document at list price (`core`, prices 2026-11-08, runs 2026-11-09); spend 0 (free tier, no billing account on the AI Studio billing page, confirmed by the owner 2026-11-09) |
| NFR-07 | RAG quality | Retrieval hit@5 and citation precision reported; every answer cites or abstains | RAG eval | T5.6 | 30 golden questions × 3 repeats, `gemini-3.5-flash-lite` (2026-11-12, `eval/reports/rag-v1.md`): hit@5 39/45 (0.87; 95% CI 0.74–0.94) when retrieval ran; citation precision 36/40 (LLM judge; 36/37 leaving out markers on sentences that state nothing; on 10 hand-labelled answers the judge agreed on 9/11 sentences blind and 11/11 after two labels were revised with its verdict in view, so an upper bound), 36/36 citations on the expected invoice; cites or abstains 90/90. Caveat: 3 of 48 lookup answers were a "the sources do not say" sentence carrying a citation, which counts as citing |
| NFR-08 | Resilience | No lost or duplicated jobs when AI service, worker or Redis restarts | failure drill | T6.7 | |
| NFR-09 | Rate limiting | Excess requests get 429 + Retry-After; provider 429 never fails a job before retries are exhausted | k6 + fake provider | T6.1, T6.2 | |
| NFR-10 | Observability | One trace spans web → api → worker → ai for an upload | Grafana screenshot | T7.1 | |
| NFR-11 | Web performance | LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 on key pages (Google "good" thresholds) | Lighthouse CI | T7.6 | |
| NFR-12 | i18n | 100% key parity vi/en; no hard-coded UI strings | CI script | T0.8 | |
| NFR-13 | Security | No unresolved High findings from dependency/secret scans; checklist in SECURITY.md passed | CI + review report | T7.4 | |
| NFR-14 | Recoverability | Daily encrypted backup stored outside the demo VM; restore and rebuild drill succeeds (RPO 24 h, RTO < 1 h for demo) | drill | T7.5 | |
| NFR-15 | Cost of hosting | 0 (local + Oracle Always Free + DuckDNS + GitHub Actions on a public repo); any paid item needs owner approval | billing pages | T4.7 | |
| NFR-16 | Legal | No real personal/business data anywhere; public demo read-only with no live LLM calls; third-party licences listed | review + CI licence check | T4.1, T4.7, T7.4 | |
