#!/usr/bin/env bash
# Regenerate the pydantic models of apps/ai from the JSON Schemas in dist/:
#   invoice.schema.json -> apps/ai/app/schemas/generated.py     (class Invoice)
#   qa.schema.json      -> apps/ai/app/schemas/qa_generated.py  (QaRoute, QaAnswer; T5.4)
# Usage: generate-python.sh [output-dir]   (default: the committed folder)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT_DIR="$(realpath -m "${1:-$ROOT/apps/ai/app/schemas}")"
cd "$ROOT/apps/ai"
generate() { # <schema name> <root class name> <output file>
  uv run datamodel-codegen \
    --input "$ROOT/packages/contracts/dist/$1.schema.json" \
    --input-file-type jsonschema \
    --output-model-type pydantic_v2.BaseModel \
    --target-python-version 3.12 \
    --class-name "$2" \
    --strict-types str int float \
    --custom-file-header "# GENERATED from packages/contracts - DO NOT EDIT. Run: pnpm --filter contracts generate:python" \
    --disable-timestamp \
    --formatters ruff-format ruff-check \
    --output "$OUT_DIR/$3"
}
generate invoice Invoice generated.py
generate qa QaModelOutputs qa_generated.py
