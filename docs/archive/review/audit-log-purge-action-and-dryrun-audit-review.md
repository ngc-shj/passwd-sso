# Plan Review: audit-log-purge-action-and-dryrun-audit
Date: 2026-04-27
Review rounds: 2

## Round 2 Summary

All Round 1 findings (Critical T3, Major F1/F2/F3/T1/T2/T4, Minor S1/S5/T7) verified RESOLVED. No new actionable findings.

Testing expert spotted an informational corroboration (T8): `src/lib/audit/audit-query.test.ts:43-44` asserts `VALID_ACTIONS.size === AUDIT_ACTION_VALUES.length`. This is a passive canary that catches `AUDIT_ACTION` ↔ `AUDIT_ACTION_VALUES` divergence at runtime. Plan's step 2 already instructs adding to both, so no plan update needed.

Plan is stable. Proceeding to Phase 2.

## Round 1 Findings Catalog

## Functionality Findings

### F1 — Major: `AUDIT_ACTION_VALUES` has no compile-time guard against `AuditAction`
- **File**: `src/lib/constants/audit/audit.ts:163-301`
- **Problem**: `AUDIT_ACTION_VALUES` is a manually maintained array. Unlike `AUDIT_ACTION` (constrained by `satisfies Record<AuditAction, AuditAction>`), forgetting to add `AUDIT_LOG_PURGE` here causes only a runtime test failure (at `audit.test.ts:212`), not a build-time error.
- **Fix**: Plan must call out that `AUDIT_ACTION_VALUES` is enforced by `npx vitest run` (not `npx next build`); both must be run before declaring step 2 complete.

### F2 — Major: `TENANT_WEBHOOK_EVENT_GROUPS.ADMIN` references `AUDIT_ACTION_GROUPS_TENANT.ADMIN` by direct reference
- **File**: `src/lib/constants/audit/audit.ts:608`
- **Problem**: Adding `AUDIT_LOG_PURGE` to `AUDIT_ACTION_GROUPS_TENANT.ADMIN` automatically propagates into `TENANT_WEBHOOK_EVENT_GROUPS.ADMIN` (intended), but plan does not state this explicitly. Future maintainers might add a separate webhook group update by mistake.
- **Fix**: Note in plan's "Constants module" section that no separate webhook group update is needed.

### F3 — Major: `totalPurged` variable name is misleading in dryRun branch of `purge-audit-logs`
- **File**: `src/app/api/maintenance/purge-audit-logs/route.ts:84` (variable definition reused for both modes)
- **Problem**: In dryRun mode, `totalPurged` actually holds the matched count (from `auditLog.count(...)`), not a deletion count. Functionally correct, but the name suggests deletion.
- **Fix**: Plan should explicitly note this naming tension so the implementer doesn't introduce confusion. No rename required in this PR's scope.

### F4 — Minor [Adjacent — pre-existing in unchanged file]: `purge-history` audit attribution uses operator's tenant for cross-tenant operation
- **File**: `src/app/api/maintenance/purge-history/route.ts:78`
- **Anti-Deferral check**: pre-existing in unchanged file
- **Routing**: [Adjacent → Security expert] — this is a pre-existing audit attribution pattern (operator's tenant for system-wide operation). Not introduced by this plan; may be revisited in the F2 (operator validation) bundle that already shipped in PR #400.
- Out of this plan's scope.

## Security Findings

### S1 — Minor: Pre-merge `HISTORY_PURGE` rows from `purge-audit-logs` are forensically ambiguous (acceptable)
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: SIEM analyst cannot distinguish historic entry-history vs audit-log purges by action label alone for rows before the boundary date.
  - Likelihood: low — `purge-audit-logs` requires `ADMIN_API_TOKEN` (limited operators); the boundary window is bounded by the merge date.
  - Cost to fix: high — would require backfilling historical rows, which violates audit-log immutability (chain hash invalidation).
- **Decision**: Accepted with mitigation (SIEM-orientation comment in plan). No backfill.

### S5 — Minor: Rate limiter shares dryRun + real key intentionally (correct posture, undocumented)
- **File**: `src/app/api/maintenance/purge-audit-logs/route.ts:39`, `purge-history/route.ts:41`
- **Problem**: Existing rate limiter uses fixed key (`max: 1, windowMs: 60_000`) covering both dryRun and real calls. This is the correct security posture (prevents probe→exploit racing) but undocumented. A future "fix" might separate the keys without realizing the intent.
- **Fix**: Plan should add a one-line comment noting the shared key is intentional. No code change required.

## Testing Findings

### T3 — Critical: Existing i18n exhaustiveness test files will fail between steps 2 and 3
- **Files**:
  - `src/__tests__/audit-i18n-coverage.test.ts:21-28`
  - `src/__tests__/i18n/audit-log-keys.test.ts:19-31`
- **Problem**: Both files iterate `AUDIT_ACTION_VALUES` / `Object.values(AUDIT_ACTION)` and assert every value has en/ja labels. Adding `AUDIT_LOG_PURGE` to `AUDIT_ACTION` (step 2) without adding the i18n keys (step 3) fails both tests. Plan does not list these files in test enumeration.
- **Fix**: Add explicit warning in plan: "Step 2 + Step 3 must complete before running full test suite. Both `audit-i18n-coverage.test.ts` and `i18n/audit-log-keys.test.ts` enforce i18n exhaustiveness against `AUDIT_ACTION`."

### T1 — Major: Plan's "line 302 only" wording misleading for `purge-audit-logs/route.test.ts`
- **File**: `src/app/api/maintenance/purge-audit-logs/route.test.ts:299-313`
- **Problem**: `"HISTORY_PURGE"` literal at line 302 is inside a multi-line `expect.objectContaining(...)` block (lines 299-313). Plan implies a one-line edit; in practice the full block needs review.
- **Fix**: Reword plan to "Update the full `expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({...action: 'AUDIT_LOG_PURGE'...}))` block."

### T2 — Major: `purge-history/route.test.ts` line range precision
- **File**: `src/app/api/maintenance/purge-history/route.test.ts:280-294, 297-308`
- **Problem**: Real-mode audit assertion is at lines 280-294 (string `"HISTORY_PURGE"` at line 283 inside the block — to be preserved). Plan stated "line 283" which is correct but adjacent to the multi-line block.
- **Fix**: Confirm line 283 is the literal location within `expect.objectContaining`; annotate plan to make clear this line stays unchanged while the real-mode test as a whole is preserved.

### T4 — Major: dryRun assertion shape must use `expect.objectContaining`
- **File**: Plan's Testing Strategy table — affects test rewrites in `purge-audit-logs/route.test.ts:327` and `purge-history/route.test.ts:307`
- **Problem**: Plan describes dryRun assertion as `mockLogAudit.toHaveBeenCalledWith({ action, metadata: { dryRun: true, matched: <count> } })`. This omits `scope`, `userId`, `actorType`, `tenantId`, `ip`, `userAgent` — all set by `tenantAuditBase`. Without `expect.objectContaining`, the assertion fails on the extra fields.
- **Fix**: Specify in plan: `expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: <const>, metadata: expect.objectContaining({ dryRun: true, matched: <n> }) }))`.

### T5 — Minor: Confirmed correct (audit.test.ts:25 + :212 coverage analysis)
- No action needed; plan's reasoning is verified.

### T6 — Minor: `audit-bypass-coverage.test.ts:105` is not an AuditAction enumerator
- The file's exhaustiveness coverage is over `ACTOR_TYPE`, not `AUDIT_ACTION`. No update needed.

### T7 — Minor: dryRun test names must be renamed
- **Files**:
  - `src/app/api/maintenance/purge-audit-logs/route.test.ts:316` — `"does not log audit on dryRun"`
  - `src/app/api/maintenance/purge-history/route.test.ts:297` — same
- **Problem**: After inverting the assertion, the test name asserts the opposite of its actual behavior.
- **Fix**: Rename to e.g. `"emits audit log with dryRun: true metadata on dryRun"`.

## Adjacent Findings

- F4 → Security expert (audit attribution for cross-tenant ops) — pre-existing, deferred.

## Quality Warnings

None. All findings include file:line evidence and concrete fixes.

## Recurring Issue Check

### Functionality expert
- R3 (pattern propagation): Checked — only `purge-history` and `purge-audit-logs` emit `HISTORY_PURGE`; no other routes.
- R9 (async dispatch tx boundary): Confirmed clean — dryRun count query is outside any `$transaction`.
- R12 (enum/action group coverage): TENANT.ADMIN inclusion satisfies the audit.test.ts:212 exhaustiveness check.
- R13 (re-entrant webhook): N/A — `WEBHOOK_DELIVERY_FAILED` already in `OUTBOX_BYPASS_AUDIT_ACTIONS`.
- R24 (additive+strict migration): N/A — pure `ALTER TYPE ADD VALUE`, no NOT NULL flip.

### Security expert
- R3: Checked.
- R9: Confirmed clean (S3-equivalent finding: no finding).
- R13: Confirmed via OUTBOX_BYPASS guard.
- R29 (citation accuracy): SOC 2 / ISO 27001 framing is paraphrase-only, acceptable.
- RS1 (timing-safe): N/A — no new credential comparison.
- RS2 (rate limit): Existing limiter unchanged; S5 documents shared-key intent.
- RS3 (input validation): No new input surface; existing Zod schema unchanged.

### Testing expert
- R3: Checked — only purge-history and purge-audit-logs routes use `HISTORY_PURGE`.
- R19 (mock alignment): `proxy.test.ts` does NOT mock `@/lib/constants/audit/audit`; no stub update needed.
- R21 (subagent verification): N/A at plan stage.
- R24: Same as Functionality — N/A.
- R25 (persist/hydrate): N/A — no new persisted-state field.
- RT1 (mock-reality divergence): Flagged as T4.
- RT2 (testability): All affected paths are unit-testable.
- RT3 (shared constants): Plan correctly uses constants in test assertions.
