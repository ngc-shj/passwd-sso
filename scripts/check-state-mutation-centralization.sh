#!/usr/bin/env bash
# CI guard: ensure emergencyAccessGrant / accessRequest status mutations are
# routed through the centralized state helpers (C8 — AST-based, always-on).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec npx tsx scripts/check-state-mutation-centralization.ts "$@"
