#!/usr/bin/env bash
# Regenerate apps/ai/app/schemas/generated.py from dist/invoice-draft.schema.json.
# Usage: generate-python.sh [output-path]   (default: the committed file)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$(realpath -m "${1:-$ROOT/apps/ai/app/schemas/generated.py}")"
cd "$ROOT/apps/ai"
uv run datamodel-codegen \
  --input "$ROOT/packages/contracts/dist/invoice-draft.schema.json" \
  --input-file-type jsonschema \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.12 \
  --class-name InvoiceDraft \
  --strict-types str int float \
  --custom-file-header "# GENERATED from packages/contracts - DO NOT EDIT. Run: pnpm --filter contracts generate:python" \
  --disable-timestamp \
  --formatters ruff-format ruff-check \
  --output "$OUT"
