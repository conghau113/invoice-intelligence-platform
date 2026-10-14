#!/usr/bin/env bash
# Fails if apps/ai/app/schemas/generated.py is stale relative to the Zod schemas.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build >/dev/null
TMP="$(mktemp --suffix=.py)"
trap 'rm -f "$TMP"' EXIT
bash scripts/generate-python.sh "$TMP"
if ! diff -u ../../apps/ai/app/schemas/generated.py "$TMP"; then
  echo "DRIFT: generated.py is stale. Run: pnpm --filter contracts generate:python" >&2
  exit 1
fi
echo "No drift."
