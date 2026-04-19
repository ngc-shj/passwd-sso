# Plan Review: enforce-audit-base-helper-usage
Date: 2026-04-19
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

[F1] **Major**: Pattern 5 dual-emit drops explicit `tenantId` from PERSONAL-scope event, changing `auditLogger` JSON shape and breaking existing test
- Problem: `vault/delegation/route.ts:204-216` original `auditBase` includes `tenantId` for BOTH PERSONAL+TENANT emits. Migration to `personalAuditBase(request, userId)` drops it from the params object. Existing test `vault/delegation/route.test.ts:350-359` explicitly asserts `tenantId: TENANT_ID` on the PERSONAL emit.
- Impact: Test fails on Batch 4. Downstream JSON-log aggregation queries grouping by PERSONAL-scope `audit.tenantId` break.
- Fix: Plan must show `{ ...personalAuditBase(request, userId), tenantId, ...auditBody }` for the PERSONAL emit.

[F2] **Major**: `internal/audit-emit/route.ts` migration recipe missing — no `tenantId` available at call site
- Problem: Current code passes only `userId` and relies on `resolveTenantId()` for tenant lookup. `tenantAuditBase(request, userId, tenantId)` requires `tenantId` as the third arg; `checkAuth` here returns `userId` only. No helper variant exists for "TENANT scope, lookup tenantId later".
- Impact: Implementation ambiguity — implementer may invent an unreviewed extra DB lookup, or the file silently fails to compile.
- Fix: Move `internal/audit-emit/route.ts` to Bucket C with documented exception ("TENANT-scope route where tenantId requires DB resolution by userId — no helper applies"). Document the new Bucket C category.

[F3] **Major**: `share-links/route.ts` Pattern 6 recipe leaves orphan `extractRequestMeta` variables
- Problem: `share-links/route.ts:186` calls `extractRequestMeta(req)` BEFORE the `withBypassRls(prisma, async (tx) => …)` block. Plan's Pattern 6 "after" example uses the helper INSIDE the tx callback. Both variables (`ip`/`userAgent`) become unused, triggering lint failures (zero-warning policy).
- Impact: Lint failure; dead code.
- Fix: Add explicit Pattern 6 step: "delete the pre-tx `const { ip, userAgent } = extractRequestMeta(req)` line when its only consumer was the migrated audit call."

[F4] **Minor**: `mcp/authorize/consent/route.ts:152` — current `MCP_CLIENT_DCR_CLAIM` emit omits `userAgent` (only `ip: claimIp`); helper would re-add it
- Problem: After migration, `userAgent` becomes populated where it was absent.
- Impact: Behavior change — additive forensic field on persisted audit row.
- Fix: Treat as deliberate forensic upgrade (per S1); document explicitly in plan that this site, along with `admin/rotate-master-key/route.ts:123`, intentionally CORRECTS the omission.

[F5] **Minor**: Override-field enumeration not exhaustive for Batches 2/5
- Problem: Plan's "additional fields" guidance is general. Implementer may forget required fields (`actorType`, `serviceAccountId`, `metadata`) per call site.
- Fix: For Batches 2/5, pre-list every non-helper field per call site (action, targetType, targetId, metadata, actorType, serviceAccountId).

[F6] **Minor**: Batch 6 (docs) implicitly depends on Batches 1-5
- Problem: Plan claims batches are independently reviewable; Batch 6 documents helpers that the prior batches must already use.
- Fix: Reorder Batch 6 to "Final docs after Batches 1-5 land" or merge into Batch 7.

## Security Findings

[S1] **Major**: `admin/rotate-master-key/route.ts:113-124` migration is a forensic UPGRADE (current code OMITS `userAgent`)
- Problem: Plan states "behavior preservation" but migration adds `userAgent` to a previously-null field. This is a desired upgrade, but plan currently labels it as forbidden.
- Impact: Over-cautious implementer might add `userAgent: null` after the helper spread to "preserve behavior", losing the forensic upgrade.
- Fix: Plan §Functional 2 must add an exception clause: "EXCEPTION: pre-existing forensic-field omissions (ip OR userAgent) at any Bucket B call site are intentionally CORRECTED by the migration." Enumerate affected sites: `admin/rotate-master-key/route.ts:123`, `mcp/authorize/consent/route.ts:152`.

[S2] **Minor**: Plan does not enumerate Bucket B sites that use `extractClientIp(...)` directly instead of `extractRequestMeta(...)`
- Problem: `vault/delegation/check/route.ts:98` and `vault/delegation/route.ts:210` use `extractClientIp(request)` directly. Implementer may mis-recognize these as "not Bucket B" and skip them.
- Fix: Add note under "Migration patterns" that `extractClientIp(req)` (without `extractRequestMeta`) is also a Bucket B antipattern — the helper replaces both forms.

[S3] **Minor**: SCIM endpoint actor attribution undocumented
- Problem: SCIM endpoints authenticate via SCIM token; the bound user's id IS the audit actor. This is non-obvious convention.
- Fix: Add sentence to Batch 5 description: "SCIM endpoints authenticate via SCIM token bound to a tenant admin user; that user's id is the audit actor (preserved from pre-migration behavior)."

[S4] **Minor**: Audit chain integrity — document hash continuity at migration boundary
- Problem: When a previously-null `userAgent` becomes populated post-migration, the chain has a one-event hash continuity transition (not a chain break — chain links to previous hash, not previous schema).
- Fix: Document in plan §Risks: "Pre/post migration boundary creates a one-event userAgent populated/non-populated transition. The hash chain links each event to the previous event's hash, so this is a hash continuity event, not a chain break."

## Testing Findings

[T1] **Minor**: Replace "console.log + revert" manual verification with Vitest inline snapshots
- Problem: Plan's Manual Verification section recommends `console.log` then revert — exactly the pattern that gets accidentally committed.
- Fix: Replace with Vitest `expect(payload).toMatchInlineSnapshot()` for one representative call per pattern. Snapshot lives in PR diff and breaks loudly on shape drift.

[T2] **Major**: `vault/delegation/route.test.ts:350-359` will FAIL after F1 migration unless tenantId preserved on PERSONAL emit
- Problem: Test asserts `tenantId: TENANT_ID` on PERSONAL emit (line 355). Plan's "after" example would yield `tenantId: undefined` in params.
- Impact: Test failure on Batch 4.
- Fix: Apply F1 fix — keep `tenantId` after the helper spread on the PERSONAL emit.

[T3] **Minor**: Document that existing `extractRequestMeta` mocks transparently apply to helpers
- Problem: Many tests mock `extractRequestMeta`. Helpers internally call it, so mocks transparently apply.
- Fix: Add one-line note to plan §Testing strategy: "Existing `extractRequestMeta` mocks transparently apply to helper-using sites — no mock updates required."

[T4] **Minor**: Specify priority integration tests
- Problem: Plan says `npm run test:integration` but doesn't highlight which tests are sensitive to audit-payload changes.
- Fix: Add to Testing strategy: "Priority integration tests for this refactor: `src/__tests__/integration/audit-and-isolation.test.ts`, `src/__tests__/db-integration/audit-logaudit-non-atomic.integration.test.ts`."

## Adjacent Findings

[F-Adjacent (→ Testing)] Minor: "console.log + revert" manual verification fragility — routed to T1 (already covered).

## Quality Warnings
None — all findings have evidence and concrete fixes.

## Recurring Issue Check

### Functionality expert
R1 N/A — no concurrency/transaction race introduced; tx scope unchanged.
R2 Checked — finding F1 (data-shape change for PERSONAL emit's tenantId).
R3 Checked — finding F2 (missing tenantId source for audit-emit).
R4 N/A — no error-handling code path changed.
R5 N/A — no new validation logic.
R6 N/A — no schema change.
R7 N/A — no new API endpoints.
R8 N/A — no auth/authz change.
R9 N/A — no encryption code touched.
R10 Checked — override ordering rule confirmed correct via audit.ts inspection.
R11 Checked — finding F4 (incidental userAgent population on consent line 152).
R12 Checked — finding F3 (dead-variable risk from extractRequestMeta orphans).
R13 N/A — no UI changes.
R14 N/A — no i18n strings.
R15 Checked — Bucket C list explicitly frozen with reasons; F2 will add `internal/audit-emit` to the list.
R16 N/A — no pricing/billing code.
R17 N/A — no logging level/sink change.
R18 Checked — JSON log emit shape change (F1) is the only structured-log impact.
R19 Checked — exact-shape test risk noted in plan §Test red flags; F4 may trigger it.
R20 N/A — no migration scripts.
R21 N/A — no env var changes.
R22 N/A — no new external deps.
R23 N/A — no caching behavior.
R24 N/A — no rate-limit change.
R25 Checked — finding F6 (Batch 6 doc-only depends on prior batches).
R26 N/A — no feature flags.
R27 N/A — no scheduled jobs.
R28 N/A — no Prisma generate/migrate impact.
R29 N/A — no SSR/CSR boundary change.
R30 Checked — Pattern 6 in-tx behavior verified: `enqueueAuditInTx` ignores params.tenantId.

### Security expert
R1 N/A — helpers pre-existing.
R2 N/A — no constants change.
R3 Checked — F1/F4/S1 covered specific propagation gaps for ip/userAgent.
R4 N/A — no event dispatch added or removed.
R5 N/A — tx scope unchanged.
R6 N/A — no schema cascade.
R7 Checked — no E2E references audit module's internal field shape.
R8 N/A — no UI changes.
R9 Checked — no fire-and-forget in tx; Pattern 6 is awaited.
R10 N/A — no new module imports.
R11 N/A — no display/subscription grouping.
R12 N/A — no new audit actions.
R13 N/A — no event delivery loop change.
R14 N/A — no DB roles changed.
R15 N/A — no migrations.
R16 N/A — no DB role tests.
R17 N/A — no new helper introduced.
R18 N/A — no privileged-op file movement.
R19 Checked — verified test assertions use `objectContaining`, helper additions don't break.
R20 N/A — manual per-file edits, no mechanical insertions.
R21 Checked — per-batch verification mandated in plan.
R22 Checked — perspective inversion verified (also `extractClientIp` direct sites — S2).
R23 N/A — no UI input handlers.
R24 N/A — no schema migrations.
R25 N/A — no persisted state changes.
R26 N/A — no UI disabled-state.
R27 N/A — no user-facing strings.
R28 N/A — no toggle/switch labels.
R29 N/A — no external spec citations in plan.
R30 N/A — no Markdown citations in plan/PR body yet.
RS1 N/A — no credential/token comparison.
RS2 N/A — no new API endpoints.
RS3 N/A — no new request parameters.

### Testing expert
R1 N/A — no shared utility introduced.
R2 N/A — no hardcoded constant changes.
R3 Checked — Bucket B enumeration validated.
R4 N/A — no event dispatch.
R5 N/A — no new tx or read-then-write sequences.
R6 N/A — no schema cascades.
R7 N/A — no E2E selectors.
R8 N/A — no UI changes.
R9 N/A — no fire-and-forget in tx.
R10 N/A — no module dependency change.
R11 N/A — no display/subscription grouping.
R12 N/A — no new audit actions.
R13 N/A — no event delivery loop.
R14 N/A — no DB roles.
R15 N/A — no migrations.
R16 N/A — no DB role tests.
R17 N/A — no new helper.
R18 N/A — no privileged-op changes.
R19 Checked — verified Bucket B test files use `objectContaining`. Exception: `vault/delegation/route.test.ts` asserts `tenantId: TENANT_ID` on PERSONAL emit — see T2.
R20 N/A — no mechanical inserts.
R21 N/A — no subagent-driven changes yet (planning phase).
R22 Checked — both perspectives covered: forward AND inverted (`extractClientIp` direct sites — S2).
R23 N/A — no UI input handlers.
R24 N/A — no schema migrations.
R25 N/A — no persisted-state changes.
R26 N/A — no UI disabled-state.
R27 N/A — no user-facing strings.
R28 N/A — no toggle/switch labels.
R29 N/A — no spec citations.
R30 N/A — no Markdown autolinks.
RT1 Checked — mock return shapes match real `extractRequestMeta` shape; migration preserves alignment.
RT2 N/A — no new tests recommended that aren't testable.
RT3 N/A — no shared constants in test assertions (audit module is mocked).

---

# Plan Review: enforce-audit-base-helper-usage
Date: 2026-04-19
Review round: 2

## Changes from Previous Round
Round 1 added: Functional 2 forensic-upgrade EXCEPTION (S1/F4); Pattern 5 mandatory tenantId preservation (F1/T2); Pattern 6 explicit pre-tx variable deletion (F3); Pattern 7 for `extractClientIp` direct-use (S2); Bucket C move for `internal/audit-emit/route.ts` (F2); Batch 5 SCIM actor attribution note (S3); Batch 6 reorder (F6); per-call-site override checklist for Batches 2/5 (F5); Risk 5 hash-continuity note (S4); manual-verification snapshot recipe (T1); test-strategy notes for mocks + priority integration tests (T3/T4).

Sub-agent quotas exhausted; Round 2 was performed via local LLM pre-screening (gpt-oss:120b) plus inline orchestrator analysis.

## Functionality Findings
No new findings.

## Security Findings
[S5] **Minor**: User-Agent string sensitivity at audit-write boundary
- Problem: Adding `userAgent` to `MASTER_KEY_ROTATION` and `MCP_CLIENT_DCR_CLAIM` events introduces no new fingerprintable data — the same strings are already captured for HUMAN-actor events.
- Impact: Threat surface unchanged. `audit_logs.userAgent` is tenant-scoped (RLS) and exposed only via tenant-admin-gated read endpoints.
- Fix: Documented in plan §Risks/Risk 6 for incident-response clarity.

## Testing Findings
No new findings.

## Adjacent Findings
None.

## Quality Warnings
None.

## Round 2 Rejected Findings (False Alarms — Documented Reason)

[R-rejected-1] [Major] R1 "Missing audit.ts in shared-utility inventory" — REJECTED. The plan explicitly cites `src/lib/audit.ts` and shows the helper signatures throughout. No reimplementation risk.

[R-rejected-2] [Major] R3 "Missing logAuditBulkAsync coverage" — REJECTED. Verified by grep — every `logAuditBulkAsync` call site (`src/app/api/{passwords,teams/[teamId]/passwords}/bulk-*/route.ts` + `empty-trash/route.ts`) is already in Bucket A (uses `personalAuditBase`/`teamAuditBase`). No Bucket B site uses bulk variant.

[R-rejected-3] [Minor] R2 "Leftover AUDIT_SCOPE imports" — REJECTED. Already addressed in plan §"Import updates (mandatory per file)".

[R-rejected-4] [Minor] R4 "Missing per-file actorType override checklist" — REJECTED. Already addressed in plan §"Per-call-site override checklist (Batches 2 and 5)".

## Resolution Status
- Round 1: All 13 Round-1 findings (4 Major + 9 Minor) are reflected in the plan revisions above.
- Round 2: 1 new Minor finding (S5) reflected in §Risks/Risk 6. 4 false alarms documented as rejected.

## Recurring Issue Check
Round 2 used the same R1-R30 / RS / RT framework. No new R items triggered beyond those already covered in Round 1.

