# Failure drill v1 (T6.7)

Date: 2026-11-16. Local stack only. LLM provider: fake (`LLM_PROVIDER=fake`), so no model was called
and no quota was used. Runbook and the invariant check: [`load/drill/`](../../load/drill/README.md).

## Summary

| Scenario | Expected (ARCHITECTURE §9) | Observed | Lost / processed twice | Result |
|---|---|---|---|---|
| A. AI service killed with 18 of 20 jobs waiting | Jobs retried with backoff; circuit breaker holds the queue; no data loss | 5 failures from 5 different jobs in 49 s → circuit open, queue held 60 s; probe failed → held 120 s; AI back → probe passed, 20/20 `needs_review`, 0 `failed`. Reads unaffected; Q&A 503 `AI_SERVICE_UNAVAILABLE` | 0 / 0 | **as expected**; the log never said when the circuit closed → **fixed** |
| B. Redis killed (SIGKILL) with 18 of 20 jobs waiting | Upload and queue endpoints 503; reads keep working; jobs resume after recovery | 503 / reads 200 as expected. After restart **18 of 18 jobs were gone**: Redis only had RDB snapshots and reloaded the one from 4 minutes earlier | **18** / 0 | **deviation → fixed** (AOF) |
| B after the fix (AOF, `everysec`) | same | Same kill: 0 of 18 lost, the running worker reconnected on its own, 20/20 `needs_review` | 0 / 0 | **as expected** |
| C. Worker killed (SIGKILL) while 2 documents were `processing` | Job stalls, is retried; processing is idempotent by (document, version) | New worker found both stalled jobs and finished them 39 s and 68 s after it started; each document entered `processing` once and got one extraction | 0 / 0 | **as expected** |

NFR-08 ("no lost or duplicated jobs when AI service, worker or Redis restarts") is **partly met**.
Met in every run here, after the fix. Two gaps stay open: AOF `everysec` can still lose about the
last second of writes before a crash (the run after the fix killed Redis 29 s after the last upload,
so it did not test that second), and losing Redis's disk (volume or VM) loses every waiting job.
Both are closed only by the reconciler described at the end.

## How "lost" and "processed twice" are measured

`load/drill/check.sh <since> [until]` reads Postgres (the source of truth for a document's status)
and Redis (BullMQ's job keys) for the documents created in the window, and exits 1 on either:

- **lost**: a document still `queued` or `processing` with no live job: the key
  `bull:extraction:<document id>` is gone, or the job has `finishedOn` (it completed or finally
  failed; BullMQ sets the field only then and clears it on a retry). The job id is the document id
  (`bullmq-extraction-queue.ts:61`). Nothing would ever move such a document again.
- **processed twice**: more than one row in `extractions` for one (document, version), or a document
  that reached `needs_review` more often than it has versions (from `audit_logs`). These are a
  backstop: the unique key `extractions_document_version_unique` makes the first impossible, and
  the state machine refuses most of the second. The evidence that matters is elsewhere: how often
  each document entered `processing` (printed by the check, so every retry and redelivery is
  visible) and, for repeated AI calls, the AI service's access log (counted by hand in C).

The check exits 2 instead of answering when Postgres or Redis cannot be read (an empty answer would
otherwise look like "nothing lost"), and was tested against a document whose job had finished and
against a stopped Redis. The dev database holds 227 seeded `queued`/`processing` rows
that never had a job (`pnpm db:seed:documents`), which is why every check is scoped to a window.

## Environment

| | |
|---|---|
| Machine | Laptop, Intel Core i7-8565U, WSL2 Ubuntu (kernel 6.6.87.2), Docker Desktop |
| Stack | `node load/drill/service.mjs ai|api|worker`: one process each, so each can be killed alone. API and worker from `dist/`, uvicorn without reload, `LLM_PROVIDER=fake`. Worker defaults: `LLM_RPM` 10 / `LLM_TPM` 100K → one job start every 12 s (AI_PIPELINE §8), `BREAKER_THRESHOLD` 5, `BREAKER_COOLDOWN_MS` 60 s, 5 attempts |
| Infra | `pnpm infra:up`: Postgres 17, Redis 8 (`redis:8`), Keycloak 26.4 |
| Load | `load/k6/run.sh upload-burst.js`: 20 synthetic XML invoices at once, from 4 identities in 2 tenants (acme 14 or 15, globex 5 or 4) |

The pacing (12 s per job) is on purpose: it keeps jobs waiting in Redis, which is what the drill
needs to hit. All times below are UTC.

**WSL2 quirk that changes one number:** in mirrored networking mode a connection to a closed
`localhost` port hangs instead of being refused (`curl` to a free port: 5 s timeout, exit 28). So
"AI service down" here looks like a hung AI service, and every call waits for its timeout. On Linux
or inside the Compose network a stopped container is refused (or its name stops resolving) at once.

## A. AI service killed mid-burst

| Time | Event |
|---|---|
| 16:55:09 | 20 uploads, all 201 |
| 16:55:30 | AI service SIGKILL (2 documents already `needs_review`, 18 waiting) |
| 16:55:48 → 16:56:37 | 5 jobs fail, one per 12 s (the pace), each from a different document; each goes back to `queued` with `EXTRACTION_RETRY` and uses 1 of its 5 attempts |
| 16:56:37 | `circuit open: AI service or provider failing, queue held 60000 ms` |
| 16:57:50 | Probe fails → `queue held 120000 ms` (cooldown doubles) |
| 16:58:45 | AI service back |
| ~16:59:50 | Probe succeeds, circuit closes (no log line said so: see fix) |
| 17:03:33 | All 20 `needs_review` (18 at 6 a minute) |

While the AI service was down: `GET /documents` 200 in 71 ms. `POST /qa/ask` 503
`AI_SERVICE_UNAVAILABLE` after 10.95 s: the question embedding's 10 s timeout
(`EMBED_QUERY_TIMEOUT_MS`) because of the WSL2 quirk above; refused at once it would be immediate.

```text
== documents created from 2026-11-16T16:55:09Z to 2026-11-16T17:04:12Z, by status
needs_review 20
lost=0 (of 0 unsettled)
duplicate_extractions=0
duplicate_needs_review=0
== attempts: entries into processing, per document (retries and redeliveries)
1 14
2 6
RESULT: OK (no lost job, nothing processed twice)
```

The 6 documents that entered `processing` twice are the 5 failures that opened the circuit and the
failed probe. Nothing else ran while the circuit was open: the breaker held the queue instead of
burning attempts, which is its point (without it, 18 jobs × 5 attempts would all have run into a
dead service and, with a longer outage, ended `failed`).

**Deviation (observability), fixed:** the worker logged `circuit open` twice but never logged the
circuit closing, so the log could not tell an operator when processing resumed.
`ProviderGuard.run` now logs `circuit closed` when a success closes an open circuit: usually the
probe, but with two jobs at once also a job that started before the circuit opened
(`apps/api/src/modules/queue/infra/provider-guard.ts`; unit tests in `provider-guard.spec.ts` for
both, the first fails without the change). Re-run on the real stack with
`BREAKER_THRESHOLD=2 BREAKER_COOLDOWN_MS=5000` and 4 uploads (the message was reworded after this
run to `circuit closed: the AI service answered, the queue runs again`):

```text
17:26:53 WARN [ExtractionWorker] circuit open: AI service or provider failing, queue held 5000 ms
17:27:09 WARN [ExtractionWorker] circuit open: AI service or provider failing, queue held 10000 ms
17:27:20  LOG [ExtractionWorker] circuit closed: the probe succeeded, the queue runs again
RESULT: OK (no lost job, nothing processed twice)
```

## B. Redis killed mid-burst

### Before the fix

Redis ran with the image defaults: `appendonly no`, `save 3600 1 300 100 60 10000` (a snapshot
after 60 s only with 10,000 changes, after 5 min with 100, after an hour with 1). `docker kill`
sends SIGKILL, so Redis writes nothing on the way down and restarts from the last snapshot.

| Time | Event |
|---|---|
| 17:05:14 | Last RDB snapshot (`LASTSAVE`); 372 changes since, 753 after the burst |
| 17:09:14 | 20 uploads, all 201 |
| 17:09:41 | Redis SIGKILL (2 `needs_review`, 18 `queued` with their jobs in `wait`) |
| 17:09:52 | Probes with Redis down (below) |
| 17:09:5x | Worker SIGTERM with Redis down: exited after **63 s** |
| 17:11:10 | Redis back, worker restarted |

With Redis down:

| Request | Answer | Expected |
|---|---|---|
| `POST /documents/upload` | 503 `RATE_LIMIT_UNAVAILABLE` in 23 ms | yes: the upload limiter fails closed (ADR 0012) before any file is stored |
| `POST /qa/ask` | 503 `RATE_LIMIT_UNAVAILABLE` in 3 ms | yes: fails closed, spends the LLM quota |
| `GET /documents?limit=20` | 200 in 12 ms | yes: read limiter and cache fail open, Postgres answers |
| `GET /health/ready` | 503 | yes: Redis is a readiness dependency |

After Redis came back:

```text
== documents created from 2026-11-16T17:09:14Z to infinity, by status
needs_review 2
queued 18
== BullMQ extraction queue
wait         16
LOST a8ec1caf-5162-4afb-8533-f33d12fd66b6 queued
... (18 lines)
lost=18 (of 18 unsettled)
duplicate_extractions=0
duplicate_needs_review=0
RESULT: FAIL (lost=18 duplicate_extractions=0 duplicate_needs_review=0)
```

**Deviation: every job added since the last snapshot was lost.** The 18 documents sat in `queued`
with no job: nothing would ever process them, and the admin's failed-jobs page does not list them
either (it shows `failed` documents only).

The `wait 16` above is the other half of the same story: the old snapshot still held 16 jobs of
scenario C, finished 5 minutes earlier. They ran again. Every one of them found its document
settled and stopped before asking the AI service anything (`extraction.processor.ts`, `SETTLED`):
**0 calls to `/extract`, 0 duplicates.** That is the idempotency of the processor doing its job
under a real resurrection, not only a theoretical double delivery.

**Recovery with what exists today** (all 20 then reached `needs_review`, check OK at 17:19:25):

- 14 acme documents: `POST /admin/jobs/:id/retry` as the tenant admin → 202 each. A `queued`
  document whose job is not found is enqueued again (`admin-jobs.service.ts`, `retry`).
- 4 globex documents (the dev realm has no globex admin): the same file uploaded again by an
  accountant → 200, same document id, `queued`. A duplicate of a `queued` document re-sends its job
  (`documents.service.ts`, `dispatch`); the job id is the document id, so this can never make two.

Both need someone to know which documents are stuck; nothing finds them automatically.

### The fix: append-only file

`compose.yaml` and `infra/prod/compose.prod.yaml` now start Redis with
`--appendonly yes --appendfsync everysec`: every write goes to the append-only file, which is
fsynced once a second. A killed Redis replays it on start, so it loses at most about one second of
writes instead of everything since the last snapshot. Enabled on the running dev Redis first with
`CONFIG SET appendonly yes` (which writes the current data into the new file), then the container
was recreated: 1,295 keys before and after, and on start Redis reported
`DB loaded from base file appendonly.aof.1.base.rdb` and `... from incr file appendonly.aof.1.incr.aof`.

**The order matters.** Redis started with `--appendonly yes` on a volume that has only `dump.rdb`
does not load it: it starts empty (found by the code review with a throwaway container). Changing
the Compose file and recreating the container on a volume with data would have lost every waiting
job, the very failure this fixes. So on any existing volume (the demo VM included): `CONFIG SET
appendonly yes`, wait for `aof_rewrite_in_progress:0`, then recreate. Both Compose files say so
next to the setting.

`everysec` and not `always`: `always` fsyncs every command, which costs on every queue operation
for a window of one second; `everysec` is Redis's own recommended default for AOF.

### After the fix

| Time | Event |
|---|---|
| 17:20:37 | 20 uploads, all 201 |
| 17:21:06 | Redis SIGKILL (2 `needs_review`, 18 waiting); worker and API left running |
| 17:21:38 | Redis back; the worker reconnected by itself |
| 17:25:04 | All 20 `needs_review` |

```text
# 5 s after Redis came back
queued 16
wait   16
lost=0 (of 16 unsettled)

# when the queue was empty
== documents created from 2026-11-16T17:20:37Z to infinity, by status
needs_review 20
lost=0 (of 0 unsettled)
duplicate_extractions=0
duplicate_needs_review=0
== attempts: entries into processing, per document (retries and redeliveries)
1 20
RESULT: OK (no lost job, nothing processed twice)
```

While Redis was down the worker logged 66 `ERROR` lines in 33 s (connection errors of the extraction
and index workers, names only, no job content) and failed no job (each document entered
`processing` once). One second after Redis returned, 3 realtime events
were not published (`Realtime publish failed (REALTIME_UNAVAILABLE)`): the publisher was still
reconnecting. That is the case ARCHITECTURE §9 already covers (the web polls every 30 s while a
document is in flight); the browser side of it was not timed in this drill.

## C. Worker killed mid-job

The fake provider answers at once, so a job is normally `processing` for a few milliseconds. To kill
the worker *inside* a job, the AI service was frozen with `SIGSTOP`: the worker's call waits, the
document stays `processing`.

| Time | Event |
|---|---|
| 17:04:12 | AI service SIGSTOP; 20 uploads, all 201 |
| 17:04:26 | 2 documents `processing` (the worker's 2 concurrent slots); worker SIGKILL |
| 17:04:28 | AI service SIGCONT |
| 17:04:40 | New worker started |
| 17:05:19 | First stalled document `needs_review` (39 s after the new worker started) |
| 17:05:48 | Second one (68 s): BullMQ's stalled check runs every 30 s, then the 12 s pace |
| 17:08:47 | All 20 `needs_review` |

```text
== documents created from 2026-11-16T17:04:12Z to 2026-11-16T17:09:14Z, by status
needs_review 20
lost=0 (of 0 unsettled)
duplicate_extractions=0
duplicate_needs_review=0
== attempts: entries into processing, per document (retries and redeliveries)
1 20
RESULT: OK (no lost job, nothing processed twice)
```

The two redelivered jobs found their documents still `processing` and carried on from there
(`extraction.processor.ts`: `processing` is not moved again), so each document entered `processing`
once. The AI service logged 38 `POST /extract` from its restart in A to the end of C: 18 for the
rest of A and 20 for C, so the two calls the dead worker had open never reached the extraction code
(the client's connection was gone when the frozen process resumed). Had they run, the unique
(document, version) key would have dropped the second insert: a repeated AI call is accepted under
at-least-once delivery, a repeated write is not.

## Findings on earlier follow-ups ("Phát sinh" rows that named T6.7)

| Row | What the drill showed | Recommendation |
|---|---|---|
| T2.4: a worker whose Redis is dead may not shut down | It does exit, after 63 s: the extraction and index workers each wait their 30 s grace one after the other. Under `docker stop` (10 s default) it is killed first; its running jobs are then redelivered as stalled, which scenario C shows is safe | New follow-up: close both workers in parallel, or shorten the grace when Redis is unreachable |
| T2.9 / T6.2: circuit breaker pauses the queue | Confirmed (A) | — |
| T5.3: Q&A could fall back to full-text when embedding fails | Q&A answers 503 while the AI service is down; lists, details and dashboard keep working | Keep the 503. A fallback would answer from fewer documents without telling the user, and the answer itself needs the same AI service, so it would fail one step later anyway |
| T5.4 / T5.6: retry Q&A on a temporary 503; API and AI timeouts | Not exercised: they are about a real, slow or overloaded model, and the drill uses the fake one | Left open; needs a real-model run (eval), not a drill |
| T6.4: how fast the UI catches up after a lost event | 3 events lost right after Redis returned (B). Server side only | Bounded by the 30 s poll by design; browser timing left to the end-of-milestone check |
| T4.1b: PDFium not isolated | Not exercised (the fake path does not decode PDFs) | Left open |

## What is still not covered

- **Losing Redis's disk**, not only its process (volume deleted, VM reclaimed): every waiting job is
  gone and nothing notices. AOF cannot help there; the fix is a reconciler that finds documents
  `queued`/`processing` for too long without a job and enqueues them again (safe: the job id is the
  document id). It must read across tenants, which this codebase deliberately avoids (migration
  0002 replaced the last `SECURITY DEFINER` lookup), so it needs its own ADR. Logged as follow-up.
- **The last second before a crash**: `everysec` can still lose about one second of writes; this
  drill did not hit that window (one run after the fix, Redis killed 29 s after the last upload).
  The same reconciler closes it.
- **Stuck `queued` documents are invisible to the admin**: the failed-jobs page lists `failed` only.
  Logged as follow-up with the reconciler.
- **Postgres down** was not part of this drill (spec: AI service, Redis, worker).
