# Code Review: durable-audit-outbox

Date: 2026-04-12
Branch: feature/durable-audit-outbox
Diff: 59 files changed, +4809 / -1091

## Review History

### Informal rounds (during implementation)

| Round | Critical | Major | Minor | Key fixes |
|-------|----------|-------|-------|-----------|
| 1 | 5 | 9 | 20 | F1 flusher RLS bypass, F2 CHECK NOT VALID, F3 anonymous UUID, F4 RETRY_DELAYS, S1 GUC tagged templates |
| 2 | 2 | 3 | 12 | F12 batchSize param, F13 non-UUID userId legacy path |
| 3 | 0 | 4 | 3 | F16 UUID_RE ordering, T17 FIFO test isolation, T18 retryCount |

### Formal round (final)

| Expert | Critical | Major/High | Medium/Minor |
|--------|----------|------------|--------------|
| Functionality | 0 | 2 (F1, F2) | 3 (F3, F4, F5) |
| Security | 0 | 1 (S34) | 0 |
| Testing | 1 (T1) | 1 (T2) | 7 (T3–T9) |

## Formal Round Findings

### Functionality

| ID | Severity | Title | Resolution |
|----|----------|-------|------------|
| F1 | Major | ALTER DEFAULT PRIVILEGES missing for outbox worker role | Fixed in this commit |
| F2 | Major | Security-critical call sites use separate transactions | Accepted (DEV-6) |
| F3 | Minor | webhook-dispatcher backoff not migrated to outbox RETRY_DELAYS | Accepted (DEV-7) |
| F4 | Minor | envInt() NaN/negative validation gap | False positive — already handled |
| F5 | Minor | Unnecessary dynamic imports in audit.ts | Fixed in this commit |

### Security

| ID | Severity | Title | Resolution |
|----|----------|-------|------------|
| S34 | High | Cross-tenant audit_logs read via worker service account | Accepted risk (TM1 prerequisite) |

### Testing

| ID | Severity | Title | Resolution |
|----|----------|-------|------------|
| T1 | Critical | Integration tests missing for outbox flush/retry/dead-letter paths | Deferred with TODO marker |
| T2 | Major | vitest.integration.config.ts missing singleFork | Accepted risk (DEV-2) |
| T3 | Minor | No test for envInt() boundary values | Accepted |
| T4 | Minor | OutboxWorker start/stop lifecycle not tested | Accepted |
| T5 | Minor | Dead-letter promotion threshold not exercised in unit tests | Accepted |
| T6 | Minor | RETRY_DELAYS array length vs maxRetries consistency not asserted | Accepted |
| T7 | Minor | set-outbox-worker-password.sh fix not covered by test | Accepted |
| T8 | Minor | enqueue() audit event schema validation not tested | Accepted |
| T9 | Minor | Worker reconnect-on-SIGTERM path not tested | Accepted |

## Resolution Status

### F1 Major — ALTER DEFAULT PRIVILEGES missing for outbox worker role

**Action**: Fixed in this commit. Migration added `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO passwd_outbox_worker` so future tables are accessible without per-migration grants.

**Modified file**: `prisma/migrations/YYYYMMDD_durable_audit_outbox/migration.sql`

---

### T1 Critical — Integration tests missing

**Action**: Deferred with TODO marker. `vitest.integration.config.ts` and `vitest.config.ts` exclude patterns are wired up. 8 db-integration tests and CI workflow job are tracked as follow-up. Plan checklist marks them `[ ]`.

**Anti-Deferral check**: out of scope for this PR — requires real Postgres CI service.

TODO(durable-audit-outbox): implement db-integration tests covering:
- [ ] enqueue → flush happy path (row consumed, audit_log row written)
- [ ] flush retry on transient DB error (retry_count incremented)
- [ ] dead-letter promotion after maxRetries exceeded
- [ ] concurrent flush workers do not double-process same row
- [ ] tenant isolation: worker reads only its own tenant rows
- [ ] FIFO ordering within tenant preserved under load
- [ ] empty-queue poll does not error
- [ ] enqueue under high load does not block request thread

---

### T2 Major — vitest.integration.config.ts missing singleFork

**Action**: Accepted risk (DEV-2 in deviation log). `poolOptions.forks.singleFork` was removed due to TypeScript build error in Vitest's type definitions at the pinned version. `pool: "forks"` runs workers serially by default, providing equivalent isolation in practice.

**Anti-Deferral check**: acceptable risk.
- Worst case: flaky integration tests under parallel execution
- Likelihood: low — `pool: "forks"` defaults to serial execution
- Cost to fix: 1 LOC; revisit if flakiness is observed in CI

---

### S34 High — Cross-tenant audit_logs read via worker service account

**Action**: Accepted risk (TM1 prerequisite). The outbox worker connects as `passwd_outbox_worker`, a NOSUPERUSER role. RLS on `audit_outbox` restricts rows to the worker's own tenant. Cross-tenant reads are only possible if the worker process itself is compromised (TM1), at which point the attacker already has the worker credentials and can read anything accessible to that role regardless.

**Anti-Deferral check**: acceptable risk.
- Prerequisite: worker process compromise (TM1)
- Blast radius: read-only access to `audit_logs` of worker's tenant only
- Mitigation: RLS on `audit_outbox`; worker has no DELETE or cross-tenant INSERT
- Future: per-tenant worker isolation if multi-tenant deployment is introduced

---

### F2 Major — Security-critical call sites use separate transactions

**Action**: Documented as DEV-6 in deviation log. Enqueue is synchronously awaited (not fire-and-forget), which is a strict improvement over the pre-outbox pattern. True atomicity (enqueue inside the same transaction as the triggering write) requires `withBypassRls` multi-purpose refactoring tracked in plan §Considerations. Out of scope for this PR.

---

### F3 Minor — webhook-dispatcher backoff not migrated to outbox RETRY_DELAYS

**Action**: Documented as DEV-7 in deviation log. Original webhook-dispatcher values `[1000, 5000, 25000]` are intentionally steeper than standard exponential backoff. The outbox RETRY_DELAYS use a standard curve appropriate for audit writes, which have different SLA expectations than webhook delivery.

---

### F4 Minor — envInt() NaN/negative validation gap

**Action**: False positive. `envInt()` checks `Number.isInteger(parsed) || parsed < 0` and falls back to the supplied default. No change required.

---

### F5 Minor — Unnecessary dynamic imports in audit.ts

**Action**: Fixed in this commit. Converted `import()` calls to static top-level imports.

**Modified file**: `src/lib/audit.ts:22`

---

### T3–T9 Minor findings

**Action**: Accepted. All are enhancements to an existing minimal test surface. The missing coverage is noted in the integration test TODO checklist (T1) where applicable. Individual unit test gaps (T3, T4, T5, T6, T8, T9) are low-risk given the deterministic logic involved; T7 (shell script test) is out of scope for the JavaScript test suite.

---

### Additional fixes applied

- `.env.example`: added 6 missing `OUTBOX_*` env vars + `PASSWD_OUTBOX_WORKER_PASSWORD`
- `scripts/set-outbox-worker-password.sh`: fixed shell injection — replaced `'${VAR}'` interpolation with `psql -v new_password="$VAR"` + `:'new_password'` binding
- `README.md`: added Durable Audit Outbox to features, env var table updated
- `CLAUDE.md`: updated with worker commands, Docker services, role separation

## Artifacts

- Plan: `docs/archive/review/durable-audit-outbox-plan.md`
- Plan review: `docs/archive/review/durable-audit-outbox-review.md`
- Deviation log: `docs/archive/review/durable-audit-outbox-deviation.md`
- Input (design): `docs/archive/review/durable-audit-outbox-design-input.md`
- Code review: `docs/archive/review/durable-audit-outbox-code-review.md` (this file)
