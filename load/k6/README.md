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
