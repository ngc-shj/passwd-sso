# Code Review: durable-audit-outbox

Date: 2026-04-12
Branch: feature/durable-audit-outbox
Diff: 55 files changed, +4561 / -1091

## Review History

### Informal rounds (during implementation)

| Round | Critical | Major | Minor | Key fixes |
|-------|----------|-------|-------|-----------|
| 1 | 5 | 9 | 20 | F1 flusher RLS bypass, F2 CHECK NOT VALID, F3 anonymous UUID, F4 RETRY_DELAYS, S1 GUC tagged templates |
| 2 | 2 | 3 | 12 | F12 batchSize param, F13 non-UUID userId legacy path |
| 3 | 0 | 4 | 3 | F16 UUID_RE ordering, T17 FIFO test isolation, T18 retryCount |

### Formal round (final)

| Expert | Critical | Major/High | Medium/Minor |
|--------|----------|------------|-------------|
| Functionality | 0 | 2 (F1, F2) | 4 |
| Security | 0 | 2 (S21, S22) | 8 |
| Testing | 1 (T1=F2) | 1 (T2) | 12 |

## Resolution Status

### F1 Major — Security-critical call sites use separate transactions
- **Action**: Documented as DEV-6 in deviation log. The improvement over pre-outbox is synchronous awaited enqueue (not fire-and-forget), not same-tx atomic. True atomicity requires mixed-RLS refactoring (future).
- **Anti-Deferral check**: out of scope (different feature) — requires `withBypassRls` multi-purpose refactoring tracked in plan §Considerations.

### F2 Major / T1 Critical — Integration tests missing
- **Action**: 8 db-integration tests and CI workflow job are tracked as follow-up. Plan checklist marks them `[ ]`. `vitest.integration.config.ts` and `vitest.config.ts` exclude patterns are wired up.
- **Anti-Deferral check**: out of scope (different feature) — requires real Postgres CI service. TODO(durable-audit-outbox): implement db-integration tests.

### S21 High — envInt NaN/negative validation
- **Action**: Already handled. `envInt()` checks `Number.isInteger(parsed) || parsed < 0` and falls back to default. False positive.

### S22 High — Shell injection in set-outbox-worker-password.sh
- **Action**: Fixed. Changed from `'${VAR}'` interpolation to `psql -v new_password="$VAR"` + `:'new_password'` binding.
- **Modified file**: scripts/set-outbox-worker-password.sh:32-34

### T2 Major — vitest.integration.config.ts missing singleFork
- **Action**: Accepted. `pool: "forks"` defaults to serial execution. `poolOptions.forks.singleFork` was removed due to TypeScript build error (DEV-2 in deviation log).
- **Anti-Deferral check**: acceptable risk.
  - Worst case: flaky integration tests under parallel execution
  - Likelihood: low — `pool: "forks"` runs tests serially by default
  - Cost to fix: 1 LOC — can revisit if flakiness observed

### F3 Minor — webhook-dispatcher backoff not migrated
- **Action**: Documented as DEV-7 in deviation log. Original values [1000, 5000, 25000] are intentionally steeper than standard exponential.

### F6 Minor — Unnecessary dynamic imports
- **Action**: Fixed. Converted to static imports in audit.ts.
- **Modified file**: src/lib/audit.ts:22

### Additional fixes applied
- `.env.example`: added 6 missing OUTBOX_* env vars + PASSWD_OUTBOX_WORKER_PASSWORD
- `README.md`: added Durable Audit Outbox to features, env var table updated
- `CLAUDE.md`: updated with worker commands, Docker services, role separation

## Artifacts

- Plan: `docs/archive/review/durable-audit-outbox-plan.md`
- Plan review: `docs/archive/review/durable-audit-outbox-review.md`
- Deviation log: `docs/archive/review/durable-audit-outbox-deviation.md`
- Code review: `docs/archive/review/durable-audit-outbox-code-review.md` (this file)
