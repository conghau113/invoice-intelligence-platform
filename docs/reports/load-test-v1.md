# Load test v1 (T6.6)

Date: 2026-11-16. Local stack only (never the public demo). LLM provider: fake (`LLM_PROVIDER=fake`),
so no model was called and no quota was used. Scripts and how to run them: [`load/k6/`](../../load/k6/README.md).

## Summary

| Scenario | Load | p95 (each run) | Error rate | Throughput | Target |
|---|---|---|---|---|---|
| Browse (list, deep page, detail, dashboard) | 20 VUs, 2-4 s think time, 2m30s | 21 / 19 / 19 ms | 0 % (0 of 3,275) | 6.0 req/s (requests ÷ whole run, ramp-up and ramp-down included) | NFR-02 < 300 ms: **met** |
| Upload acknowledgment | 20 uploads at the same moment | 311 / 248 / 290 / 359 ms (after the fix, A/B runs) | 0 % | about 55 uploads/s within the burst | NFR-03 < 500 ms: **met** (1 run of 10 after the fix above 500 ms, see below) |
| Upload burst (stress) | 80 uploads at once (the tenant's rate-limit ceiling) | 0.76-1.3 s on a quiet machine; up to 4.3 s when the host was busy | 0 % | 65-92 uploads/s | above 500 ms: CPU-bound on one API process |
| Q&A | 25 questions at the same moment | 513 / 486 / 583 ms | 0 % | 41-50 questions/s within the burst | no target (fake model) |

No run saw a 429: every script stays under the API's rate limits (ADR 0012) and fails on one 429, so
these numbers measure the backend, not the limiter.

**Bottleneck found:** an upload burst is CPU-bound on the single Node.js event loop of the API, and
most of that CPU goes to the database client (about 15 sequential SQL statements per upload in two
transactions). **Fixed:** the `uploaded -> queued` step now runs in the upload's own transaction:
12 statements in 1 transaction instead of 15 in 2 (counted, below). The latency gain is inside the
noise of this machine (median p95 of 20 uploads 339 → 300 ms over 4 alternating pairs); the
structural fix for big bursts is more than one API process (logged as follow-up).

NFR-03 at 20 uploads was already met before the fix (p95 241-490 ms in 9 of 10 runs; the other one, 998 ms, was the first run after a pause). The fix is a
counted reduction of work per upload, not a measured latency win, and NFR-03 is not met *because*
of it.

## Environment

| | |
|---|---|
| Machine | Laptop, Intel Core i7-8565U (4 cores, 8 threads, 1.8 GHz base with turbo), 10 GB RAM given to WSL2 |
| OS | Windows + WSL2 Ubuntu, kernel 6.6.87.2-microsoft-standard-WSL2, Docker Desktop 28.5.1 |
| Stack | `node load/k6/serve.mjs`: API and worker from `dist/` (Node 24.21), AI service with uvicorn and no reload, `LLM_PROVIDER=fake`, `LLM_RPM=6000`; Postgres 17 + pgvector, Redis 8, Keycloak 26.4 from `pnpm infra:up` |
| Data | acme about 3,500 documents, globex 1,000 (`pnpm db:seed:documents`), all synthetic |
| Load generator | k6 1.4.2 in Docker (`grafana/k6`), through `host.docker.internal` |
| Identities | the 4 users of the dev realm; the consultant counts twice (acme and globex through `X-Tenant`) |

Each scenario ran 3 times or more after a warm-up (a short browse and a few uploads, then a minute's
pause). Every run is reported, not only the best one.

### Two things that distorted the first measurements

1. **The dev stack's watchers.** In `pnpm dev:stack`, `uvicorn --reload` (about 40 % of a core),
   two `nest start --watch` (about 18 % each) and the Next dev server share the CPU with the API.
   Browse then gave p95 315 ms (p50 22 ms), and even `GET /health` sent one at a time had p90 22 ms.
   On `serve.mjs` (built code, no watchers, no web) the same browse run gave p95 97 ms, and 19-21 ms
   on a quiet machine. Load numbers are only meaningful without the watchers.
2. **A cold process.** A burst sent right after the API starts pays for module loading, JIT and the
   first JWKS fetch: 40 uploads took p95 5.3 s on a cold API, about 1 s once warm. Warm up first.

The machine itself stays noisy: the same build and the same burst gave p95 from 0.95 to 4.3 s when
the Windows host was busy (load average 3.25 with the stack idle). Small differences between two
builds therefore need alternating runs (A/B below), not two series measured at different times.

## Results

### Browse (NFR-02)

`load/k6/browse.js`: 20 VUs, each one person reading: page 1 of the list, a random deep page (OFFSET
up to the last page), one document, the extraction dashboard, 2-4 s between pages (about 20 requests
a minute per VU, under the `read` bucket of 120 per user).

| Run | All p50 | All p95 | All p99 | list_first p95 | list_deep p95 | detail p95 | dashboard p95 | Requests |
|---|---|---|---|---|---|---|---|---|
| 1 | 12 ms | 21 ms | 32 ms | 17 ms | 26 ms | 24 ms | 17 ms | 1,090 |
| 2 | 12 ms | 19 ms | 33 ms | 16 ms | 26 ms | 21 ms | 16 ms | 1,100 |
| 3 | 12 ms | 19 ms | 32 ms | 16 ms | 24 ms | 19 ms | 17 ms | 1,085 |

Deep pages cost about 9 ms more at p95 than the first page (OFFSET plus `count(*)` on 1,000-3,500
rows); far from the ADR 0019 revisit point. Max values of 400-530 ms appeared once per run, on a
different endpoint each time, i.e. a pause of the process or the host, not one slow query.

### Upload acknowledgment (NFR-03)

`load/k6/upload-burst.js`: every identity that may upload sends its files at the same moment; each
file is the synthetic XML invoice of `load/k6/fixtures/` with its own invoice number (a new content
hash). The time is the acknowledgment only: file stored, row and job created, 201 returned.

| Burst | Build | p95 per run | Notes |
|---|---|---|---|
| 20 | before the fix | 998 / 327 / 351, 354 / 241 / 246 ms; A/B: 314 / 364 / 490 / 308 ms | 998 ms: first run of the series, after a pause |
| 20 | after the fix | A/B: 311 / 248 / 290 / 359 ms; separate series: 290 / 266 / 471, 271 / 351 / 557 ms | |
| 80 | before the fix | 1.13 / 0.85 / 0.82 s, 0.76 / 0.80 / 0.83 s; A/B: 0.95 / 3.2 / 1.62 / 1.29 s | the A/B pairs 2-4 ran while the host was busy |
| 80 | after the fix | 1.18 / 1.67 / 0.97 s, 1.29 / 0.98 / 0.91 s; A/B: 0.99 / 4.27 / 2.03 / 2.83 s | same |

With 20 uploads, 9 of 10 runs after the fix stayed under 500 ms (the 10th: 557 ms), and 9 of 10
runs before it (the 10th, the first run of a series after a pause: 998 ms). Every run is listed:
none was dropped from either side. With 80 uploads p95 never went under 0.76 s with either build.

### Q&A

`load/k6/qa.js`: 25 questions at the same moment (5 per identity, the `qa` bucket's size), answered
through retrieval and the fake model.

| Run | p50 | p95 | Max | Time to first byte p95 |
|---|---|---|---|---|
| 1 | 383 ms | 513 ms | 516 ms | 513 ms |
| 2 | 390 ms | 486 ms | 486 ms | 486 ms |
| 3 | 508 ms | 583 ms | 592 ms | 582 ms |

The time to first byte equals the total time: the API checks every citation before it streams
(T5.4), and the fake model answers at once. With a real model the provider's latency dominates
(NFR-04).

## Finding the bottleneck

1. **Not the database.** `select 1` from the host: p50 0.7 ms. During a burst, `pg_stat_activity`
   showed the app's connections `idle in transaction` waiting on `ClientRead`: Postgres was waiting
   for Node.js, not the other way round.
2. **CPU on one event loop.** 40 uploads used 1.22 s of the API process's CPU (about 30 ms each, 13-14
   ms in warm 80-upload bursts), while a list read used about 3 ms. Node.js runs JavaScript on one
   thread, so N simultaneous uploads finish after roughly N × CPU per upload: 80 × 13 ms ≈ 1 s, the
   p95 measured. Throughput inside a burst (65-92 uploads/s) is the inverse of that cost.
3. **Where the CPU goes** (CPU profile of a warm 40-upload burst, Chrome DevTools protocol): about 70 %
   in the database client path: Drizzle building SQL (`toQuery` alone about 10 %), `pg` writing and
   parsing the protocol, stream callbacks. No application function was expensive on its own: the
   cost is the number of statements.
4. **How many statements** (`log_statement = all` for the app role for one upload, then reset):

| Upload, API side | Before | After |
|---|---|---|
| SQL statements | 15: tenant lookup 1, `register` transaction 8, `uploaded -> queued` transaction 6 | 12: tenant lookup 1, one transaction 11 |
| Transactions | 2 | 1 |
| Pool checkouts | 3 | 2 |
| Cache-generation `INCR` in Redis | 2 | 1 |

(The worker then runs 21 statements in 5 transactions for each XML document, unchanged.)

### The fix

`DocumentsService.register` now moves a new document from `uploaded` to `queued` through the state
machine inside the same transaction as the insert (`apps/api/src/modules/documents/application/documents.service.ts`).
The row is still born `uploaded` (RLS `initial_state`) and changed only by the state machine, which
still invalidates the cache and pushes the realtime event after COMMIT. If the enqueue fails
afterwards, the row is `queued` with no job and the client's retry sends the job, as before. Tests:
`apps/api/test/documents-create.int-spec.ts` (a failing transition leaves no row, key or audit
entry; one status audit `uploaded -> queued`); the first failed when the step was put back in a
separate transaction.

### Before and after

Two API processes ran side by side on the same database, Redis and worker: the build before the fix
on port 3002 and the one after it on 3001, warmed up with 3 bursts each, then alternated (A B, B A,
...), 4 pairs per burst size, a minute apart so the shared rate-limit buckets refill.

| Burst | Before: p95 per pair | After: p95 per pair | Median before → after |
|---|---|---|---|
| 20 | 314, 364, 490, 308 ms | 311, 248, 290, 359 ms | 339 → 300 ms (−11 %) |
| 80 | 0.95, 3.20, 1.62, 1.29 s | 0.99, 4.27, 2.03, 2.83 s | not comparable: the host became busy during pairs 2-4 and both builds slowed 2-4× |

**Reading:** the fix removes 20 % of the statements and half of the transactions of an upload, which
is certain (counted). Its effect on latency is smaller than this machine's noise: −11 % in the median
of 4 pairs of 20-upload bursts, with overlapping ranges, and no conclusion for 80. It does not change
the shape of the problem: one process acknowledges at most about 65-90 uploads a second, so a burst
of 80 cannot be acknowledged within 500 ms whatever the per-request cost, short of a several-fold
cut.

## Follow-up (logged in `docs/plan/TASKS.md`, "Phát sinh")

- **More than one API process** for upload bursts (Node cluster or several instances behind the
  reverse proxy; realtime already works across instances through the Redis adapter, T6.4). Changes
  deployment: needs an ADR.
- **Cache alias → tenant id** in the API (T1.3 follow-up): one statement less on every request;
  touches tenant resolution, so it needs its own review.
- **Measure on a quiet machine**: this laptop's noise hides changes of 10-20 %. A dedicated runner
  or the Oracle VM would give steadier numbers, but the spec keeps load tests local.

## Scripts changed after the runs

After review, the scripts stopped calling `Math.random()` (static analysis flags it as a weak
generator). `lib/common.js` now draws its uniform numbers (think time, deep page, document) from
k6's Web Crypto, and `upload-burst.js` takes its Idempotency-Key from `crypto.randomUUID()`
(5,000 of 5,000 unique in a check). The first version read one `Uint32Array` value per draw: k6
1.4.2 filled it with values below 256, so every draw was almost 0 (think time always 2 s, the "deep"
page always page 1) and a browse run made 1,609 requests instead of about 1,090. Four bytes from a
`Uint8Array` give a uniform draw (mean 0.501 over 20,000; every tenth of the range about 10 %).
A deterministic choice from the VU and iteration numbers was tried in between and dropped: it gave
a higher p95 than random draws in 2 alternating pairs, and the measured runs used random draws.

Check runs with the final scripts (15:40-16:00, host load average about 2.1 with the stack idle, against
about 1.1 during the runs above):

| Script | Requests | p95 | Errors, 429 |
|---|---|---|---|
| `browse.js` | 1,076 (5.9 req/s; the measured runs had 1,085-1,100) | 157 ms | 0, 0 |
| `upload-burst.js` (20) | 20 | 357 ms | 0, 0 |
| `qa.js` | 25 | 641 ms | 0, 0 |

Same load shape; the latencies follow the busier host (in the same hour, the unchanged `qa.js` gave
3.6 s in one run and 641 ms in the next).

## Reproduce

See [`load/k6/README.md`](../../load/k6/README.md). Raw k6 summaries are written to the git-ignored
`load/k6/results/`.
