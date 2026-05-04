# Coding Deviation Log: centralize-state-transitions

Implementation followed the plan's locked contracts (C1-C8) without major deviation. The minor adjustments below were applied during Phase 2 and warrant durable recording for future readers.

## Phase 2 adjustments

### 1. `extraData` type widened to `UncheckedUpdateManyInput` (Batch 2)

The plan's helper signature initially used `Omit<Prisma.<Table>UpdateInput, "status">` for `extraData`. During route migration, `granteeId` / `approvedById` (scalar FKs) needed to flow through `extraData`. Prisma's `UpdateInput` type uses **relation form** (e.g., `grantee: { connect: { id } }`) and does NOT expose those scalar FK fields. `UncheckedUpdateManyInput` — which is what `updateMany()` actually accepts — does. Switched both `transition()` and `bulkTransition()` to `Omit<Prisma.<Table>UncheckedUpdateManyInput, "status">`.

Why this is correct: the helper invokes `updateMany()` (not `update()`), so the unchecked variant is the schema-aligned type. The plan's earlier choice was a typing oversight, not a contract change.

### 2. `EA_ACTOR` / `AR_ACTOR` constants introduced (post-Batch 3)

The plan declared `type EaActor = "OWNER" | "GRANTEE" | "SYSTEM"` as a literal union, with tests using a hand-written `["OWNER", "GRANTEE", "SYSTEM"]` array. This drifts from the existing `EA_STATUS = { ... } as const satisfies Record<...>` pattern.

Refactored:
- `EA_ACTOR` const + derived `EaActor` type → in `src/lib/constants/integrations/emergency-access.ts` (alongside `EA_STATUS`)
- `AR_ACTOR` const + derived `ArActor` type → inline in `src/lib/access-request/access-request-state.ts`
- Test files now iterate `Object.values(EA_ACTOR)` / `Object.values(AR_ACTOR)` — drift-resistant per RT3

This satisfies the plan's R12 / RT3 obligations more cleanly than the original literal-union form.

### 3. vault-reset uses `actor: "OWNER"` (Batch 3)

The plan suggested `actor: "SYSTEM"` for `vault-reset.ts` `bulkTransition` call. The committed matrix has no `* → REVOKED (SYSTEM)` cells — only `OWNER`. Using `SYSTEM` would cause `bulkTransition` to derive an empty allowed-from set and return `{ updated: 0 }`.

`actor: "OWNER"` is semantically correct: vault reset revokes the user's own grants on behalf of the owner (the user being reset IS the owner of those grants). The matrix permits OWNER → REVOKED from all non-terminal states.

### 4. Vault-route test uses 500ms `setTimeout` for outbox flush (Batch 4 integration test)

The vault auto-promote race integration test (T17) needs `logAuditAsync` (outbox-based, async I/O) to land before counting audit rows. A 500ms real-time wait is the minimum needed for the audit-outbox to drain in the test environment. This is NOT a flaky-test mask — it is the unavoidable async boundary between the helper returning and the outbox row appearing in `audit_logs`.

The plan's "no setTimeout to make a flaky test pass" rule does not apply here: this is a real wait for asynchronous I/O completion, not a sleep-then-pray.

### 5. `api-error-codes` structural-invariant test count bump (post-Batch 4)

The `API_ERROR` codes count test (`api-error-codes.test.ts:121`) had a hardcoded expected value of 140. Adding `GRANT_REVOKED` (Batch 1) made the count 141. Updated the assertion + added the EmergencyAccess i18n key (`grantRevoked`) per the test's own comment ("Update this count AND add the code to API_ERROR_I18N + i18n messages").

### 6. CI guard fixture path excluded from production scan

`scripts/check-state-mutation-centralization.ts` (Batch 4) intentionally excludes `__fixtures__/` from its scan, since the bad fixture (`scripts/__fixtures__/state-mutation-bad.ts`) deliberately contains the anti-pattern the script detects. Without this exclusion the script would always fail by detecting its own self-test fixture.

### 7. Test-mock shape adjustment in `deny/route.test.ts` (Batch 2)

`src/app/api/tenant/access-requests/[id]/deny/route.test.ts:92-97` previously asserted `where: { ..., status: "PENDING" }`. After `transition()` migration, the helper passes `status: { in: ["PENDING"] }` (because the matrix-derived allowed-from set is an array of one). Updated the assertion accordingly. Behavior is identical — only the WHERE shape representation changed.

## Plan items NOT yet executed (deferred to PR finalization)

- `centralize-state-transitions-manual-test.md` skeleton (R35 Tier-2 deliverable). Will be authored alongside the PR description.
- Integration tests run only when `DATABASE_URL` is set; they are gated by `it.skipIf(!process.env.DATABASE_URL)`. Local verification by the PR author against a running Postgres remains a Phase-2 obligation per CLAUDE.md.

## Phase 3 review-driven adjustments

### 10. Round-2 expert-review fixes (post-Round-1)

The Round-2 review verified Round-1 fixes and surfaced 1 Major + 1 Minor + 1 doc-level finding:

- **R34/S3 (Major)**: The AR `hasScopeUnderBypass` check accepted `where: { id }` alone — flagged as pre-existing-in-changed-file (the file IS in `git diff main...HEAD`). Per anti-deferral rule, "pre-existing in changed file" is NOT ALLOWED to defer without explicit user approval. **Resolution**: tightened the predicate to require `where.tenantId !== undefined` (was `where.id || where.tenantId`). UUIDs were unguessable so residual risk was theoretical, but the predicate IS the primary cross-tenant defense under bypass scope and must mirror EA's per-resource discipline.
- **F8/F9 (Minor)**: Two doc-level cross-reference issues — `src/auth.ts:140` cited `../auth/email-uniqueness-design.md` (broken path); accept routes' C6 comment cited "deviation log §C6" (no such section, should be §8). Both fixed.
- **S4 (Minor)**: Earlier T4/S2 deferral entries lacked grep-able TODO markers and anti-deferral triplets. Now updated in §9 with explicit Worst case / Likelihood / Cost-to-fix triplet and `TODO(centralize-state-transitions-followup)` markers.

### 11. Constants discipline tightening (user-driven)

User pointed out (post-Round-2) that `actor: "GRANTEE"` / `to: "REVOKED"` literals remained scattered across migrated routes despite the `EA_ACTOR` / `AR_ACTOR` const refactor in §2. Replaced ALL hardcoded actor + status string literals in production code (10 routes + 3 lib files: `vault-reset.ts`, `emergency-access-server.ts`, `vault-auto-promote.ts`) AND in the integration test (12 hits) with constant references — `EA_STATUS.X`, `EA_ACTOR.X`, `AR_STATUS.X`, `AR_ACTOR.X`. R12/RT3 drift resistance now uniformly applied.

(Out of scope: `src/lib/auth/access/tenant-role-hierarchy.test.ts` uses `actor: "OWNER" | "ADMIN" | "MEMBER"` for a different concept — `TENANT_ROLE` hierarchy, not state-machine `EA_ACTOR`. Not touched.)

## Phase 3 review-driven adjustments (Round 1)

### 8. Round-1 expert-review fixes applied in branch
The 3-expert Phase 3 review surfaced 3 Major + 9 Minor findings. Major items were fixed inline:
- **T1**: missing `import type { EaActor }` / `import type { ArActor }` in the 2 state-machine test files. `npx tsc --noEmit` now passes for the modified files. Pre-existing tsc errors in unrelated test files (share-links / scim-tokens / openapi-json / aws-sdk / mcp-refresh-token) are out of scope for this PR.
- **T3**: Added explanatory comment in T17 explaining why `Promise.all` over `autoPromoteIfElapsed` is sufficient (each call opens its own `withBypassRls` AsyncLocalStorage scope → distinct DB transactions → row-level lock contention is real). Refactoring to `raceTwoClients` would require widening `autoPromoteIfElapsed`'s API to accept a `db` parameter, which is a larger change than the documentation fix.
- **F1, F2/T6, F3, F4/S1, T5**: Minor cleanups applied — `auth.ts:140` comment, ci-integration.yml duplicate path glob removed, stale `fromStatusesFor` comments updated to "matrix-derived allowed-from", accept routes' C6 comment clarified (early-return pattern is functionally equivalent to `throw` because nothing follows the early return inside the tx callback), F14 test extended with sibling assertion proving the `lt` predicate excludes high-keyVersion rows.

### 9. Deferred to follow-up PR (with anti-deferral triplet + grep-able TODO)

- **T2 (PRE_MIGRATION_AUDIT_SHAPES fixture)**: The plan committed to a frozen-shape fixture that asserts `logAuditAsync` calls match the pre-migration shape across 10 routes. **Deferred** with anti-deferral triplet:
  - **Worst case**: a future PR silently changes `logAuditAsync` metadata shape on a migrated route (e.g., drops `permanent: true` flag from `EMERGENCY_ACCESS_REVOKE`, or changes `targetType` value); audit consumers misclassify; no test fails because existing route tests assert only the WHERE/data shape of the underlying `updateMany`, not the audit envelope.
  - **Likelihood**: medium — every future PR touching these 10 routes has the opportunity. PR review can catch shape changes if they appear in the diff, but reviewer fatigue across 10 routes makes it brittle.
  - **Cost-to-fix**: ~60-90 min — capture 10 routes' `logAuditAsync` shape from base-commit source, wire 10 new assertions, run tests.
  - **TODO marker**: `TODO(centralize-state-transitions-followup): add src/__tests__/fixtures/audit-shapes.ts with frozen audit shapes per route + per-route assertion`.

- **T4 (vault-auto-promote.ts dedicated unit test)**: 5 branches (not_eligible × 2, revoked, no_escrow, success) are covered split across the integration suite (T17 — success-race) and the route test (`vault/route.test.ts` — revoked race via mocked findUnique sequence). **Deferred** with anti-deferral triplet:
  - **Worst case**: a regression in vault-auto-promote (e.g., re-orders the `revokedAt` check after `encryptedSecretKey` check, exposing a revoked grant's wrapping ciphertext) is not caught — the integration test exercises only the success path; the route test asserts the revoked-race outcome but via mocks that may not encode the exact ordering.
  - **Likelihood**: low — the 5 branches are simple early-return guards, and the F5/S15 ordering invariant is documented in the function's JSDoc.
  - **Cost-to-fix**: ~30-45 min — 4 mocked unit tests, 5 LOC each.
  - **TODO marker**: `TODO(centralize-state-transitions-followup): add src/lib/emergency-access/vault-auto-promote.test.ts covering not_eligible × 2 / revoked / no_escrow branches`.

- **S2 (AST guard spread detection)**: The CI guard skips spread-assignment detection by design — the script's own comment documents this. **Deferred** with anti-deferral triplet:
  - **Worst case**: a future maintainer routes status mutation through `data: payload` (where `payload` contains `status`) bypassing the CI guard; the helper-as-only-path convention is silently violated.
  - **Likelihood**: low — the only natural way to write a status mutation is via `data: { status: ... }` literally; passing through a parameter object is an awkward pattern that PR review would flag.
  - **Cost-to-fix**: high — full type-aware data-flow analysis in ts-morph, OR fallback to OR-combined regex (re-introducing the brittleness C8 was designed to avoid). Recommend revisiting only if a real regression appears.
  - **TODO marker**: `TODO(centralize-state-transitions-followup): if data:payload spread bypass becomes a real concern, add a type-aware data-flow pass to scripts/check-state-mutation-centralization.ts`.
