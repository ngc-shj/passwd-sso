# Coding Deviation Log: security-audit-remediation

## Phase 1 process deviations

- Ollama `merge-findings` skipped in plan-review rounds; orchestrator deduplicated manually (raw-output re-emission to temp files cost more orchestrator tokens than the merge saved; manual fallback is the documented alternative). Dedup pairs recorded in the review log per round.
- Step 1-3 pre-review first ran with `PLAN_FILE` outside TRUSTED_ROOT (worktree path not under the hook's trusted root) producing a vacuous "No issues"; re-run via stdin produced the real seed findings, which were dispositioned in the review log.

## Phase 2 process deviations

- Step 2-1 scanners (`scan-shared-utils.sh`, `build-codebase-fingerprint.sh`) not run. Justification: the reuse inventory was already pinned per-contract during Phase 1 fact-gathering + 6 review rounds (every contract names the exact shared helper/constant to use and carries forbidden patterns banning re-implementation); the scanners would re-derive a superset of this at no additional safety. R1/R2 remain enforced via the contract conformance grep and the Phase 2-5 mechanical hooks.
- CI gate parity: known gaps vs scripts/pre-pr.sh are the DB+Redis integration CI job (mitigated — plan mandates local `npm run test:integration` before push) and the Extension CI job (N/A — this PR touches no `extension/` files).

## Phase 2 implementation deviations

- C2: `REDIS_PASSWORD` registered ONLY in the Zod schema + env-descriptions sidecar, NOT in env-allowlist.ts (plan listed both) — the drift checker rejects double registration (a var is either Zod-schema-owned or allowlist-owned). `npm run check:env-docs` green confirms the correct single home.
- C5: Auth.js `Nodemailer()` hardcodes `maxAge` in its return value, so the option cannot be passed as provider config; implemented as spread-override `{ ...Nodemailer(...), maxAge: MAGIC_LINK_TTL_SEC }` (send-token.js reads `provider.maxAge` — verified effective).
- C5: `failClosedOnRedisError: true` on `magicLinkEmailLimiter` is a module-scope closure not directly assertable from tests; sub-agent substituted a constant-export assertion. ORCHESTRATOR NOTE: a `vi.mock` on `@/lib/security/rate-limit` capturing `createRateLimiter` call options would assert it properly — carried to Phase 2 verification/Phase 3 as an open improvement.
- C5: `magic-link.ts` now imports `MAGIC_LINK_TTL_MINUTES` from `@/auth.config` — potential R10 circular-import risk if auth.config (sendVerificationRequest) imports the template module; MUST be verified in Phase 2-4 build/runtime check.
- C6: db-integration test exercises deleteMany-then-count semantics via direct Prisma transaction, NOT through the register route handler (route requires live Redis for rate limiting). RT5 trade-off: route-level order/args are covered by unit tests with mocks; SQL semantics by the direct-tx integration test. Carried to Phase 3 for evaluation.
- C13: `api-key.test.ts` previously had no `validateApiKey` coverage at all — file substantially rewritten rather than fixture-patched. `scripts/checks/check-bypass-rls.mjs` allowlist updated for the three validators' new `tenantMember` access (R18 sync done in-batch).
- C12: hibp route tests use fresh prefixes (00000/11111/22222) to dodge the route's in-memory cache — functional equivalence, no plan conflict.

## Phase 2 verification notes

- Parallel-sub-agent `git stash` races left two stashes holding most batch modifications; recovered by snapshot-commit + `git stash apply stash@{1}` (superset) with worktree auth-gate.test.ts retained. Lesson recorded: red-green stash verification MUST NOT run concurrently in a shared worktree.
- R10 circular import found and fixed post-merge: magic-link.ts imported MAGIC_LINK_TTL_MINUTES from @/auth.config while auth.config imports the template; constants moved to src/lib/constants/auth/magic-link.ts.
- C13 mock propagation (R19) extended to consumer route tests (extension/token, passwords routes) and to the duplicate suites under src/__tests__/api (folders/history/history-restore) which had half-edited 404 titles with 403 asserts.
- C6 db-integration test merged into dcr-cleanup-worker-sweep.integration.test.ts: both suites mutate the global unclaimed-DCR namespace (tenant_id IS NULL) and vitest file-parallelism otherwise interleaves them.
- Full `npm run test:integration` on the shared dev DB shows 4-6 failures (audit-anchor manifest count, audit-sentinel backfill actor, mobile cache-rollback 401s, dcr sweep audit-row count, outbox partial batch) — ALL reproduce on an origin/main baseline worktree against the same DB (verified twice), i.e. pre-existing stale-data/parallel-contention noise, not introduced by this PR. Authoritative gate: CI integration job on a fresh DB. Our two new integration scenarios pass in isolation (2 consecutive runs).
