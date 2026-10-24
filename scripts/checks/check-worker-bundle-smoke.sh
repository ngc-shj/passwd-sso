#!/usr/bin/env bash
# R32 boot smoke test for the esbuild-bundled worker artifacts.
#
# Production runs the workers as esbuild CJS bundles (`node dist/<worker>.js`),
# NOT via tsx. esbuild's default CommonJS output replaces `import.meta.url` with
# `undefined`, which previously made `createRequire(import.meta.url)` in
# src/lib/blob-store/runtime-module.ts throw ERR_INVALID_ARG_VALUE at module
# load — crashing the retention-gc worker on boot. The existing
# --validate-env-only unit tests run the tsx SOURCE (ESM, import.meta.url
# defined) and never exercised the shipped bundle, so the crash shipped green.
#
# This gate requires the workers ECS runs, the worker-policy manifest's
# entrypoints, the Dockerfile's esbuild invocations and its dist/ COPYs to be
# one set, then boots each bundle — built with the EXACT esbuild arguments
# extracted from the Dockerfile, or, with WORKER_BUNDLE_SMOKE_RUNNER=docker:<image>,
# the one inside a built image — with --validate-env-only and only the env its
# ECS task gives it, and requires its positive markers. The logic, and every
# override variable, is documented in scripts/checks/lib/worker-bundle-smoke.mjs.
#
# It needs only node, so the container-scan job can run the docker runner
# without installing the repo's dependencies; the host runner also needs
# node_modules (esbuild, and the packages the bundles keep external).
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"
cd "$REPO_ROOT"

exec node --input-type=module -e '
  import { main } from "./scripts/checks/lib/worker-bundle-smoke.mjs";
  process.exitCode = main(process.cwd());
'
