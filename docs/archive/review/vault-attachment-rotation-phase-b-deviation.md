# Coding Deviation Log: vault-attachment-rotation-phase-b

## Batch 3 (client) — recorded 2026-05-04

### D1 — §C6 response shape: `mode0AttachmentIds: string[]` insufficient

**Plan said**: `mode0AttachmentIds: string[]` capped at `ATTACHMENT_MANIFEST_CAP`.

**Implementation deviated to**: `mode0Attachments: Array<{ id: string; entryId: string }>`, with the overflow boolean renamed `mode0AttachmentsOverflow`.

**Reason**: the client cannot migrate a mode-0 attachment without `entryId` because:
1. The download/migrate endpoints are scoped under `/api/passwords/{entryId}/attachments/{id}` — `entryId` is part of the URL path.
2. The data AAD per §C2 is `buildAttachmentAAD(entryId, attachmentId)` — `entryId` is part of the AAD bytes.

A bare `id[]` made the §C8 migration loop impossible to implement; B3's first pass shipped a stub returning `legacyAttachmentsMigrated: 0`, which is **not acceptable** since the rotation POST then 409s on residual mode-0 rows. Plan §C6 acceptance test ("vault with 3 mode-0 + 2 mode-2 → response has `mode0AttachmentIds.length === 3`") is updated in spirit to verify the array length AND that each element exposes `id` + `entryId`.

**Impact**:
- `src/app/api/vault/rotate-key/data/route.ts` selects `passwordEntryId` and emits `mode0Attachments`.
- `src/lib/vault/vault-context.tsx` consumes the new shape and runs a real migration loop with pagination (re-fetches data after each batch to drain overflow).
- Plan §C6 + §C8 are deviated; subsequent test/manual-test artifacts (B4/B5) MUST refer to the implemented shape, not the plan's stub field name.

### D2 — i18n string corrections (user feedback during implementation)

The user reviewed three translation entries in real time and corrected jargon / non-actionable wording. The fixes are applied and recorded here so review/PR-cadence reflects the rationale, not just the text:

| Key | Before | After (en/ja) | Reason |
|---|---|---|---|
| `ATTACHMENT_LEGACY_MIGRATION` (AuditLog.json) | "Legacy attachment migrated to mode-2" / "レガシー添付ファイルを mode-2 に移行" | "Upgraded attachment encryption format" / "添付ファイルの暗号化形式を更新" | `mode-2` is internal jargon; users have no mental model. (See `feedback_no_internal_jargon_in_user_strings.md`.) |
| `rotateKeyMigratingLegacyAttachments` (Vault.json) | "Upgrading {count} legacy attachments…" / "{count} 件のレガシー添付ファイルを更新中…" | "Upgrading {count} attachments to new format…" / "{count} 件の添付ファイルを新しい形式に更新中…" | "レガシー" katakana jargon; aligned with `legacyAttachmentHint`'s "以前の形式" phrasing. |
| `outdatedAttachmentFormat` (Vault.json) | "...Contact support." / "...サポートにお問い合わせください。" | "...Restore from a backup or re-upload the original file." / "...バックアップから復元するか、元のファイルを再アップロードしてください。" | passwd-sso is a personal-use project — there is no support team to contact. The replacement is actionable. |

### D3 — `rotate-key-client.ts` extraction not done

The plan §C8 said extraction is OPTIONAL. The B3 sub-agent kept the rotation flow inline in `vault-context.tsx`. Reason: the flow needs closure access to `session`, `oldEncryptionKey`, `oldKeyVersion`, `ecdhPrivateKeyBytesRef`, and the `onProgress` callback; threading these through an extracted module added more friction than it saved. Re-evaluation deferred to a Phase B+ refactor.

**Impact on testability**: integration tests (§C12) target `applyVaultRotation` (server-side helper) directly, so the client-side flow is exercised only by E2E. This matches the plan's testing strategy table — no test-coverage regression.

### D4 — `attachmentId` AAD constraint at upload time (open question)

§C8a upload path requires `buildAttachmentAAD(entryId, attachmentId)` at encryption time, but `attachmentId` is server-assigned. The B3 sub-agent did NOT explicitly address how the existing mode-0 upload path resolves this. Two possibilities:

1. The existing code uses some placeholder ID and the AAD does NOT include `attachmentId` at upload time; it's set on first read. (Inspect `attachment-section.tsx` to confirm.)
2. The client generates a UUID at upload time and submits it alongside the body, server respects it.

This is a Phase 3 review check item (T8 / RT1) — make sure the production AAD path is actually exercised in the new test fixtures. To be re-verified during B4 (tests).

## Self-R-Check Findings (Step 2-5) — recorded 2026-05-04

Three sub-agents (functionality / security / testing) ran a focused R1-R36 + RS1-RS4 + RT1-RT4 check on the Phase B diff. 7 findings surfaced; 6 fully addressed in Phase 2, 1 partially addressed.

### Resolved in Phase 2

- **F1 / T1 (HIGH, R7)** — `e2e/tests/settings-key-rotation.spec.ts` still ran the Phase A "Acknowledge data loss" flow. **Fix**: dropped the Phase A test case and added a Phase B replacement that exercises auto-migration → rotation → asserts `encryption_mode = 2` post-commit. Option A (DB-row assertion only, no plaintext round-trip from Playwright) chosen because the vault `CryptoKey` is browser-bound; round-trip coverage already lives in C12 integration tests.
- **F2 (MEDIUM, R19/R25)** — `cekRewrapsFailed` was missing from the rotation POST JSON response (interface said `number`, response sent `undefined`). **Fix**: added `cekRewrapsFailed: txResult.cekRewrapsFailed` to the response block at `route.ts:255`.
- **S2 (Minor)** — `vault-context.tsx`'s rewrap path did not gate `cekWrapAadVersion` against `MIN_ACCEPTED_CEK_WRAP_AAD_VERSION` before AES-GCM unwrap (plan I8a.3 compliance gap). **Fix**: added a floor check at the rewrap loop entry; below-floor rows are skipped and the server's manifest mismatch surfaces them.
- **S1 (Minor)** — `cekWrapAadVersion: 1` was hardcoded as a literal in 3 emission sites (vault-context.tsx upload + rewrap, attachment-section.tsx upload). **Fix**: introduced `CURRENT_CEK_WRAP_AAD_VERSION = 1` in `crypto-aad.ts` and replaced all 3 literals.
- **T2 (MEDIUM, R16)** — describe-level `appInstance` setup but never used. **Fix**: removed the unused setup block; T12.6c creates its own per-test app-role instances.
- **R36 cleanup** — removed an unused `eslint-disable-next-line` directive in `webauthn/credentials/[id]/prf/route.test.ts:83` flagged during Step 2-4 lint pass.
- **Crypto-domain ledger** — added the new `"AW"` AAD scope to `docs/security/crypto-domain-ledger.md` to satisfy `scripts/checks/check-crypto-domains.mjs` (a CI-only gate the local lint pass surfaced via the pre-existing-failure report).

### Partially addressed — deferred to follow-up

- **T4 (MEDIUM, RT4)** — race-test (T12.6c) per-side win assertions and meaningful contention probe.
  - **What was applied**: `expect(migrateWonCount).toBeGreaterThan(0)` (catches "migrate path always errors" regression).
  - **What was deferred**: `expect(rotationWonCount).toBeGreaterThan(0)` and a strict `expect.fail` on probe failure. Discovered during fixing: the integration test calls `applyAttachmentMigration` and `applyVaultRotation` directly (helpers), but the `pg_advisory_xact_lock` is acquired in the route handlers (`migrate/route.ts:119`, `rotate-key/route.ts:165`), NOT in the helpers. The test does NOT exercise the lock at all; mutual exclusion in the loop comes from rotation's `encryption_mode !== 2` early-exit, not from advisory-lock contention. A strict `rotationWonCount > 0` requires the rotation to actually win the race, which the structure makes rare on fast machines.
  - **Why deferred**: a full RT4 fix requires either (a) restructuring `applyAttachmentMigration` / `applyVaultRotation` to acquire the advisory lock internally, or (b) rewriting T12.6c to invoke the route handlers via `fetch`. Both are larger changes than fits in a Step 2-5 closeout.
  - **Mitigation in place**: the test file's probe block carries an explicit `KNOWN LIMITATION` comment naming the gap and the two fix options, so future readers don't mistake the partial guard for a complete one.
  - **Severity post-mitigation**: Major → Minor (the production code is correct; the gap is in the test's coverage claim, not in the production lock implementation; route-level coverage of the lock IS exercised by `vault-rotate-key-gaps.integration.test.ts`).
  - **TODO marker**: search `KNOWN LIMITATION (T4 follow-up)` in the integration test to find the entry point for the follow-up PR.

### Not addressed — deferred per disposition rules

- **T3 (LOW, R25)** — persist/hydrate symmetry tests (T12.2/T12.7) read DB rows after rotation via the same `pg.Pool` instance, not via a freshly-reopened connection. Plan I12.5 calls for a "SECOND PrismaClient instance constructed AFTER commit". Severity LOW because driver-level buffer cache bugs that don't flush to disk are extremely rare in `node-postgres`. Per skill disposition rules, LOW findings carry to Phase 3.
