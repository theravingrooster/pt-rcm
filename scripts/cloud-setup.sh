#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node is required" >&2
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then
  echo "Node 22 or newer is required, found $(node -v)" >&2
  exit 1
fi

# Cloud containers have no Docker daemon. Do not run docker compose or db:migrate here.
corepack pnpm install --store-dir "${TMPDIR:-/tmp}/pt-rcm-pnpm-store"
corepack pnpm --filter @pt-rcm/domain test

echo "cloud setup ok"
