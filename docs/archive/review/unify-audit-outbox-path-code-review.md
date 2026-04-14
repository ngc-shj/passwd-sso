# Code Review: unify-audit-outbox-path
Date: 2026-04-14
Review round: 1 (final — all findings resolved)

## Changes from Previous Round
Initial review of branch `refactor/unify-audit-outbox-path`.

Pre-branch context: the large logAudit → logAuditAsync migration was already merged to main. This branch is a follow-up addressing the external reviewer's note that non-outbox paths remain in logAuditAsync. The fix changes `userId: "anonymous"` sentinel strings to type-safe `userId: null + actorType: SYSTEM`, which bypasses the outbox via direct write (matching the audit_logs CHECK constraint that allows `user_id IS NULL AND actor_type = 'SYSTEM'`).

## Functionality Findings

### F1 Major: structured JSON emit inconsistent with DB write when caller omits actorType — RESOLVED
- Action: `buildOutboxPayload` now forces `actorType = SYSTEM` when `userId === null`, keeping structured log and DB write consistent regardless of caller input.
- Modified file: src/lib/audit.ts

### F2 Major: 4 callers passing non-UUID string fallbacks ("system"/"unknown") — RESOLVED
- Action: Changed `?? "system"` / `?? "unknown"` → `?? null` in 4 callers. These now flow through the null userId direct-write path.
- Modified files:
  - src/app/api/mcp/token/route.ts:138
  - src/lib/directory-sync/engine.ts:205
  - src/lib/access-restriction.ts:159
  - src/lib/team-policy.ts:204

### F3 Minor: logAuditInTx accepts null userId but outbox rejects — ACCEPTED (latent, no current caller)
- Anti-Deferral check: acceptable risk
- Worst case: A future caller using logAuditInTx with userId:null will enqueue a row the worker rejects. Manifests as worker dead-letter, not app error.
- Likelihood: low — all current logAuditInTx callers pass authenticated UUID userIds
- Cost to fix: ~5 LOC but adding a second code path to logAuditInTx (direct write inside tx) has architectural implications (atomicity semantics). Better addressed when a real caller needs it.
- TODO(unify-audit-outbox-path): Consider tightening logAuditInTx signature to `userId: string` (non-null) or adding a null-userId branch if needed.

### F4 Minor: file-level JSDoc stale — RESOLVED
- Action: Updated JSDoc to describe both routing paths (UUID → outbox, null → direct write) and design consequences (no chain, no SIEM fan-out for null path).
- Modified file: src/lib/audit.ts (header comment)

## Security Findings

### S1 Info: SIEM/webhook fan-out bypass for SYSTEM+null events — DOCUMENTED
- Action: Added explicit design note in JSDoc: `SHARE_ACCESS_VERIFY_*` events do NOT flow through audit_delivery fan-out (no outboxId → no delivery rows). This matches worker-emitted meta-events.
- Rationale: anonymous share access is not a SIEM-level security event in the current threat model. If external SIEM forwarding is required later, move these actions to the outbox path with a sentinel user record.
- Modified file: src/lib/audit.ts

### S5 Minor: test fixture uses stale "anonymous" string — RESOLVED
- Action: Renamed test "dead-letters non-UUID userId without tenantId" → "dead-letters UUID userId when user lookup returns null", and changed fixture from `userId: "anonymous"` to a real UUID string. Test now matches the current code path (resolveTenantId → user.findUnique returns null → dead-letter).
- Modified file: src/__tests__/audit-fifo-flusher.test.ts

## Testing Findings

### T1 High: null userId test only verified negatives — RESOLVED
- Action: Added positive assertion `expect(mockAuditLogCreate).toHaveBeenCalledWith(...)` verifying that prisma.auditLog.create is called with `userId: null, actorType: "SYSTEM", tenantId, action`. Captured `mockAuditLogCreate` via vi.hoisted for direct inspection.
- Modified file: src/__tests__/audit-fifo-flusher.test.ts

### T2 Medium: null userId + no tenantId dead-letter untested — RESOLVED
- Action: Added test "dead-letters null userId when tenantId is absent" asserting `tenant_not_found` reason + no direct write.
- Modified file: src/__tests__/audit-fifo-flusher.test.ts

### T3 Medium: null userId + DB error never-throws untested — RESOLVED
- Action: Added test "catches direct write failure and logs to dead letter (null userId path)" mocking `auditLog.create` rejection and asserting `resolves.toBeUndefined()` + dead-letter call.
- Modified file: src/__tests__/audit-fifo-flusher.test.ts

### T4 Info: test name no longer matches code path — RESOLVED (merged with S5)
- See S5.

### T5 Low: metadata.ip assertion missing — RESOLVED
- Action: Extended `expect.objectContaining({ anonymousAccess: true })` to also require `ip: expect.any(String)` in both SHARE_ACCESS_VERIFY_FAILED and SUCCESS assertions.
- Modified file: src/app/api/share-links/verify-access/route.test.ts

### Also added (T1 follow-up): actorType forcing test
- Action: Added test "forces actorType to SYSTEM when userId is null (even if caller omits it)" verifying F1 invariant in both structured log emit and DB write.
- Modified file: src/__tests__/audit-fifo-flusher.test.ts

## Recurring Issue Check

### Functionality expert
- R1-R16: Checked — no issues introduced. R8 (stale magic strings) resolved by F2. R10 (actorType default mismatch) resolved by F1. R14 (stale JSDoc) resolved by F4.

### Security expert
- R1-R13, RS1-RS3: Checked — no issues. Direct-write path preserves RLS via withBypassRls. No spoofing risk (actorType forced to SYSTEM). Dead-letter sanitization intact.

### Testing expert
- R1-R16, RT1-RT3: Checked. RT1 (mock-reality divergence) resolved by T1 fix. RT2 (positive assertion coverage) resolved by T1/T2/T3 additions.

## Resolution Status

All Major and Critical findings resolved. One Minor (F3) accepted with documented Anti-Deferral justification (latent, no current caller, cost-benefit unfavorable for preemptive fix).

Verification:
- 563 test files / 7120 tests pass (+3 new tests)
- Production build succeeds
- No residual non-UUID userId strings in production code
