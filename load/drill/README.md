# Failure drill (T6.7)

Kill one dependency while jobs are waiting, bring it back, and prove that no job was lost and none
was processed twice. Local stack only, always the fake LLM provider. Run by hand: there is no
automatic chaos here (out of scope). Results of the first run:
[`docs/reports/failure-drill-v1.md`](../../docs/reports/failure-drill-v1.md).

## Setup

```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed
pnpm --filter api build
node load/drill/service.mjs ai       # terminal 1
node load/drill/service.mjs api      # terminal 2
node load/drill/service.mjs worker   # terminal 3
```

`service.mjs` runs one service per process with the same environment as `load/k6/serve.mjs`
(built `dist/`, uvicorn without reload, `LLM_PROVIDER=fake`), so each can be killed on its own. The
worker keeps the default provider pace (`LLM_RPM` 10 → one job start every 12 s), which keeps jobs
waiting in Redis while you kill things. Pass `BREAKER_THRESHOLD` / `BREAKER_COOLDOWN_MS` to the
worker for a shorter breaker run.

## The check

```bash
T0=$(date -u +%FT%TZ)                    # before the uploads of a scenario
load/k6/run.sh upload-burst.js           # 20 synthetic invoices (wait a minute between two runs)
# ... kill, wait, bring back, wait until the queue is empty ...
load/drill/check.sh "$T0"                # or: check.sh "$T0" "$T1" for one scenario's window
```

`check.sh` exits 1 when a document is `queued`/`processing` without a live BullMQ job (key gone,
or the job already finished: **lost**) or was extracted / reached `needs_review` more than once per
version (**processed twice**, a backstop: the unique key and the state machine already prevent
it). It exits 2 when Postgres or Redis cannot be read. It also prints the statuses, the queue
counts, and how often each document entered `processing`: that table and the AI service's access
log (`POST /extract` lines) are where retries and repeated AI calls show. A document still `queued`
*with* a live job is in flight: wait and run it again. Always pass a window: the dev seed
(`pnpm db:seed:documents`) leaves `queued`/`processing` rows that never had a job.

## Killing things

Find pids with a bracket in the pattern (`[u]vicorn`), so the pattern does not match your own shell:
`pkill -f "uvicorn app.main"` also kills the shell that runs it.

| Scenario | Kill | Bring back |
|---|---|---|
| AI service down | `kill -KILL $(pgrep -f "[u]vicorn app.main")` | `node load/drill/service.mjs ai` |
| Redis down | `docker kill invoice-intelligence-redis-1` (SIGKILL: nothing is saved on the way down) | `docker start invoice-intelligence-redis-1` |
| Worker killed mid-job | `kill -STOP` the AI service first, so the worker's call hangs and the document stays `processing`; then `kill -KILL $(pgrep -f "[d]ist/worker.js")` and `kill -CONT` the AI service | `node load/drill/service.mjs worker` (stalled jobs come back within about 30 s) |

What to look at while it is down: the worker log (`circuit open` / `circuit closed`, `failed`),
`GET /documents` (must stay 200), `POST /documents/upload` and `POST /qa/ask` (503 with a code),
`GET /health/ready`.

On WSL2 in mirrored networking mode a closed `localhost` port hangs instead of refusing, so calls to
a dead AI service wait for their timeout here; on Linux they fail at once.
