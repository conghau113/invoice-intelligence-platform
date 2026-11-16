#!/usr/bin/env bash
# T6.6: run one k6 script of this folder against the LOCAL stack (never the public demo).
#
#   load/k6/run.sh browse.js [k6 args...]       e.g. load/k6/run.sh browse.js -e VUS=40
#
# Signs in the dev realm's demo identities on the host (issuer localhost:8080, the one the API
# accepts; dev realm only, password from infra/keycloak/realm-invoice.json), passes them to k6 as
# IDENTITIES, and keeps the end-of-test summary in load/k6/results/ (git-ignored). Access tokens
# live 300 s: keep a run under four minutes.
set -euo pipefail

script="${1:?usage: load/k6/run.sh <script.js> [k6 args...]}"
shift
here="$(cd "$(dirname "$0")" && pwd)"
keycloak="${KEYCLOAK_URL:-http://localhost:8080}"
api="${API_BASE_URL:-http://host.docker.internal:3001}"
k6_image="grafana/k6:1.4.2"

token() {
  local user="$1" scope="$2"
  curl -sf -X POST "$keycloak/realms/invoice/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=dev-cli --data-urlencode "scope=$scope" \
    -d "username=$user" -d password=demo-dev-only |
    python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])'
}

# One token per user; the consultant's carries both tenants (`organization:*`, T1.1).
admin="$(token admin@acme.example openid)"
accountant="$(token accountant@acme.example openid)"
viewer="$(token viewer@globex.example openid)"
consultant="$(token consultant@demo.example 'openid organization:*')"

identities="$(
  ADMIN="$admin" ACCOUNTANT="$accountant" VIEWER="$viewer" CONSULTANT="$consultant" python3 -c '
import json, os
print(json.dumps([
  {"name": "admin@acme", "tenant": "acme", "token": os.environ["ADMIN"], "roles": ["tenant_admin"]},
  {"name": "accountant@acme", "tenant": "acme", "token": os.environ["ACCOUNTANT"], "roles": ["accountant"]},
  {"name": "consultant@acme", "tenant": "acme", "token": os.environ["CONSULTANT"], "roles": ["accountant"]},
  {"name": "viewer@globex", "tenant": "globex", "token": os.environ["VIEWER"], "roles": ["viewer"]},
  {"name": "consultant@globex", "tenant": "globex", "token": os.environ["CONSULTANT"], "roles": ["accountant"]},
]))'
)"

mkdir -p "$here/results"
stamp="$(date +%Y%m%dT%H%M%S)"
name="${script%.js}"

# The tokens go in through the environment of `docker run`, never on its command line.
IDENTITIES="$identities" docker run --rm --user "$(id -u):$(id -g)" -e IDENTITIES -e API_BASE_URL="$api" \
  -v "$here:/scripts:ro" -v "$here/results:/results" \
  "$k6_image" run --summary-export "/results/$name-$stamp.json" "$@" "/scripts/$script"
