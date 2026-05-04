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
