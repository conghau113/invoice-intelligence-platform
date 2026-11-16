# k6 scripts

Load and limit checks against a **local** stack (never the public demo). k6 runs from its official
Docker image, so nothing is installed (AGPL-3.0, dev tool only: `docs/LEGAL.md`).

## `rate-limit.js` (T6.1)

Drives one user over the API's rate limits (ADR 0012) and checks every 429: `RATE_LIMITED`,
`Retry-After` and the `RateLimit` header. Calls no LLM: run it with the AI service **stopped**, so
the questions that pass the limiter fail behind it with 503 instead of using the provider quota.

```bash
pnpm infra:up
pnpm dev:api            # another terminal; leave the AI service off

# A token for the demo accountant from the dev realm's `dev-cli` client (dev realm only).
TOKEN=$(curl -s -X POST localhost:8080/realms/invoice/protocol/openid-connect/token \
  -d grant_type=password -d client_id=dev-cli -d scope=openid \
  -d username=accountant@acme.example -d password=demo-dev-only \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])')

docker run --rm -e TOKEN="$TOKEN" -e API_BASE_URL=http://host.docker.internal:3001 \
  -v "$PWD/load/k6:/scripts:ro" grafana/k6:1.4.2 run /scripts/rate-limit.js
```

The token is fetched on the host so its issuer is `localhost:8080`, the one the API accepts; k6 in
the container reaches the API through `host.docker.internal` (Docker Desktop on WSL2 does not pass
`--network host` through to WSL's `localhost`). Run it again only after a minute: the buckets of the
same user must refill first, or fewer requests pass than the thresholds expect.

Load testing with many users (T6.6) has to spread requests over several users and tenants, or count
429 as an expected answer: a single user hits the `read` limit at 120 requests.

## Load test v1 (T6.6): `browse.js`, `upload-burst.js`, `qa.js`

Measures NFR-02 (reads) and NFR-03 (upload acknowledgment) and reports Q&A, on the local stack
with the fake LLM provider: no model is called. Results and method:
[`docs/reports/load-test-v1.md`](../../docs/reports/load-test-v1.md).

```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed
pnpm db:seed:documents acme 1000 && pnpm db:seed:documents globex 1000   # deep pages to read
# (the v1 report's database also held about 2,800 earlier acme documents: deep pages go deeper)
pnpm --filter api build
node load/k6/serve.mjs                 # another terminal: API, worker, AI (fake), no watchers, no web

load/k6/run.sh browse.js               # 20 VUs for 2m30s, NFR-02
load/k6/run.sh upload-burst.js         # 20 uploads at the same moment, NFR-03
load/k6/run.sh upload-burst.js -e PER_IDENTITY=20   # 80 at once: the stress run (rate-limit ceiling)
load/k6/run.sh qa.js                   # 25 questions at the same moment
```

- **Why `serve.mjs` and not `pnpm dev:stack`**: the watchers of the dev stack (`nest --watch`,
  `uvicorn --reload`, Next dev) keep CPU busy on their own; under them even single requests showed
  a tail (p90 100 ms for a list served from cache). `serve.mjs` runs the built API and worker and
  uvicorn without reload, always with `LLM_PROVIDER=fake`.
- **Warm up first**: the first requests after a start pay for loading modules, JIT and the first
  JWKS fetch (a burst on a cold API took 4-5 s). Run a short `browse.js -e DURATION=20s` and a small
  `upload-burst.js -e PER_IDENTITY=2`, then wait a minute.
- **Identities**: `run.sh` signs in the four users of the dev realm; the consultant counts twice
  (acme and globex through `X-Tenant`), so five identities share the load. Every script keeps under
  the API's rate limits (ADR 0012) and fails on a single 429: a 429 is answered before any
  database work and would make latency look better than it is.
- **Wait a minute between upload or Q&A runs**: their buckets (20 uploads and 5 questions a minute
  per user) must be full again.
- **Tokens live 300 s**: a run must end within about four minutes.
- **Uploads stay**: every `upload-burst.js` run adds its documents to the dev database (and the
  worker processes them), so lists grow from run to run.
- **Docker Engine on Linux** (no Docker Desktop): `host.docker.internal` does not exist there; add
  `--add-host=host.docker.internal:host-gateway` to the `docker run` line of `run.sh`.
- **Profiling the API**: `API_NODE_FLAGS=--inspect=127.0.0.1:9230 node load/k6/serve.mjs`, open
  `chrome://inspect` and record a CPU profile (Performance tab) while the burst runs.
