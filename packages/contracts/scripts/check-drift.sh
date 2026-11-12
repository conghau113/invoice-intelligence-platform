#!/usr/bin/env bash
# Fails if a generated module of apps/ai/app/schemas is stale relative to the Zod schemas.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build >/dev/null
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
bash scripts/generate-python.sh "$TMP"
status=0
for name in generated.py qa_generated.py; do
  if ! diff -u "../../apps/ai/app/schemas/$name" "$TMP/$name"; then
    echo "DRIFT: $name is stale. Run: pnpm --filter contracts generate:python" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "No drift."
exit "$status"
