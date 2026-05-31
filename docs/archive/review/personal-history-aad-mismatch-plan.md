# Plan: Fix personal entry history decryption (AAD scope mismatch)

## Project context

- **Type**: web app (Next.js 16 + Prisma + E2E client-side encryption)
- **Test infrastructure**: unit (vitest) + integration (real Postgres) + CI/CD
- **Security-sensitive**: yes — changes the AAD (Additional Authenticated Data) used for AES-256-GCM decryption of personal vault history. E2E encryption: the server never sees plaintext.

## Objective

Two parts:
- **Part A (C1–C10)** — Fix the bug where viewing a personal entry's change history shows "Failed to decrypt history version". Restore the *correct* (ideal) cryptographic model — personal history records are server-side verbatim snapshots of the entry blob, so they MUST be decrypted with the **entry** AAD, exactly as the team path already does. Remove all dead code unwound by the fix (incl. the `ENTRY_HISTORY_REENCRYPT` Prisma enum value).
- **Part B (C11–C16)** — Eliminate the AAD-drift recurrence *class* by mechanism: consolidate AAD construction into one registry, declare the AEAD-primitive boundary, and add a CI gate that fails the build on any ad-hoc AAD/AEAD site or any scope missing parity/round-trip coverage. This is what makes the 3×-recurring bug structurally unable to recur — memory is only a backstop.

## Root cause (verified in code)

Personal history records are **created** and **decrypted** under different AAD scopes:

- **Create (server, E2E — cannot re-encrypt)**: `src/app/api/passwords/[id]/route.ts:149-159` copies `existing.encryptedBlob` + `existing.aadVersion` verbatim into `PasswordEntryHistory`. That blob was encrypted by the client with the **PV "blob"** scope `buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.BLOB)` (see `personal-entry-save.ts:38`).
- **Decrypt (personal)**: `src/components/passwords/entry/entry-history-section.tsx:226-227` uses the **PH** scope `buildPersonalHistoryAAD(userId, entryId, h.id)`. `"PV" ≠ "PH"` ⇒ the AES-GCM additional-data does not match ⇒ `crypto.subtle.decrypt` rejects (`crypto-client.ts:415`) ⇒ "Failed to decrypt history version".
- **Decrypt (team) — the correct model**: same file `:208-209` uses `buildTeamEntryAAD(teamId, entryId, "blob", itemKeyVersion)` = the **entry** AAD, which matches the verbatim team snapshot and works.
- **Key rotation**: `src/lib/vault/vault-context.tsx:1062-1075` re-encrypts personal history with the **PH** scope too. Because every persisted personal-history blob is PV-scoped, this decrypt-with-PH throws on the first history row, and the rotation loop has **no per-row try/catch** and runs **before** the persist `POST /api/vault/rotate-key` (`:1173`). Therefore rotation of any personal vault that has history currently fails entirely, and — critically — **no PH-encrypted personal-history blob can ever have been persisted** (the only PH writer aborts before persisting).

Introduced by #482 (`d50c5fb5`, plan `owasp-batch-3-plan.md` contract "C2"). The PH scope was intended to bind `historyId` for rollback resistance, but that binding is **unachievable in a server-snapshot model**: the server copies the client's existing ciphertext and (being E2E) cannot re-encrypt it under a per-history-id AAD. The intent was sound; the mechanism was incompatible with how snapshots are actually produced.

## The ideal model (what "should be")

A personal history record is a byte-for-byte snapshot of the entry's `encryptedBlob` at the moment of an edit. Its authenticated context is therefore identical to the entry blob's: `(userId, entryId, "blob")`. The team vault already implements exactly this (entry AAD for history). The fix makes the personal path match the team path and the server-side reality.

`historyId` rollback-resistance is **not** provided by AAD in a server-snapshot design (and never was — no PH data exists). It is out of scope here; if it is ever wanted, it requires a different mechanism (e.g. a server-side authenticated binding), tracked separately.

## Scope decisions (confirmed with user)

- **No data migration / no backward-compatibility fallback.** Past-data migration is explicitly out of scope (user direction: 「過去データの移行は考えなくて良い」「あるべき、で。本質を」). This is reinforced by the proof above that no PH-encrypted personal-history blob can exist. The decrypt path is changed outright — no "try PV then fall back to PH". Pre-1.0 breaking-change policy applies (cf. the same policy already applied to the 2-field→3-field PV change in #503).
- **`buildPersonalHistoryAAD` and the `"PH"` scope are removed entirely**, not deprecated. They have no remaining producer or consumer after this change.
- **Full dead-code removal (user direction: 「dead code は削除」「全dead code削除」).** The #482 per-history re-encryption mechanism (`PATCH /api/passwords/[id]/history/[historyId]` and the team counterpart) was superseded by the bulk `POST /api/vault/rotate-key` rotation path and has **no client/CLI/extension/v1 caller** (verified). It is pre-existing dead code and is removed in full: the PATCH handlers (GET handlers, used by the history View, are kept), the `historyReencryptSchema` / `teamHistoryReencryptSchema` validators, the `ENTRY_HISTORY_REENCRYPT` audit action, and all of their tests.
- **The `ENTRY_HISTORY_REENCRYPT` audit action is removed from the Prisma `AuditAction` enum too** (user direction: 「enum値も完全削除（マイグレーション伴う）」). The TS `AUDIT_ACTION` const is declared `as const satisfies Record<AuditAction, AuditAction>`, so the Prisma enum and the TS const are **lockstep** — neither can drop the value alone without a type error. A Prisma migration is therefore required; PostgreSQL cannot `DROP VALUE` from an enum, so the migration is the standard recreate-type form (new enum without the value → swap every column of the type → drop old type). It is safe because no row uses the value in practice (no client ever invoked the PATCH emitters).

## Cross-codebase / blast-radius findings (verified)

- `buildPersonalHistoryAAD` / `SCOPE_PERSONAL_HISTORY` / scope `"PH"` exist **only** in the app: `crypto-aad.ts` (definition), `entry-history-section.tsx` (decrypt), `vault-context.tsx` (rotation), and `crypto-aad.test.ts` / `entry-history-section.test.tsx` (tests). **Not** in `extension/`, **not** in `ios/`, **not** in `aad-parity.test.ts`. Removal has no cross-codebase (golden-vector) impact. (`project_aad_three_implementations` checked and cleared.)
- iOS has **no** history UI (`fd`/`rg` for history in `ios/` → none). Out of scope.
- Emergency-access grantor vault (`emergency-access/[id]/vault/page.tsx`) stores `data.passwordHistory` in state (`:254`) but **never decrypts it** — there is no history-decrypt path there. No change needed.
- Personal restore (`history/[historyId]/restore/route.ts`) is server-side and copies blobs verbatim (entry↔history, same `entryId`, both PV "blob"). Consistent; no change needed.
- The per-history re-encrypt `PATCH` endpoints (personal `/api/passwords/[id]/history/[historyId]` and team `/api/teams/[teamId]/passwords/[id]/history/[historyId]`) are **not called by any client/CLI/extension/v1** (verified: no `method:"PATCH"` to a history path anywhere; only the GET handlers and `restore` are reachable). They are pre-existing dead code and are removed (C6-C9). Not PH producers (the only persisted-PH writer was rotation, which aborts before persist — see Root cause).
- The **only** column typed `AuditAction` is `AuditLog.action` (schema.prisma:1080). `audit_outbox.payload` is `Json` (schema.prisma:1128) — the action string lives inside the JSON blob, not a typed enum column (verified by Functionality + Security reviewers). So the recreate migration touches exactly one column (`audit_logs.action`) and recreates its `@@index([action])`. Confirm the generated SQL does NOT reference `audit_outbox`.
- **Audit-outbox drain window (theoretical)**: a `PENDING` `audit_outbox` row carrying `action: "ENTRY_HISTORY_REENCRYPT"` drained *after* the enum migration would fail the `audit_logs` INSERT (unknown enum value). No such row can exist (the PATCH emitters were never reachable), so this is theoretical only — note it as a pre-migration sanity check, do not build machinery for it.

## Contracts

### C1 — Personal history decryption uses the entry AAD
- **File**: `src/components/passwords/entry/entry-history-section.tsx`
- **Change**: in `handleView`'s personal branch, replace
  `buildPersonalHistoryAAD(userId, entryId, h.id)` with
  `buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.BLOB)`.
  Update the import (drop `buildPersonalHistoryAAD`, add `buildPersonalEntryAAD`, `VAULT_TYPE`). Update the `// C2: ...` comment to describe the snapshot-equals-entry-AAD rationale.
- **Signature touched**: none (call-site change only).
- **Invariant**: the personal history decrypt AAD equals the AAD the entry blob was encrypted with (`personal-entry-save.ts:38` `buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.BLOB)`).
- **Guard**: `h.aadVersion >= 1 ? <entry AAD> : undefined` is preserved (aadVersion 0 = no AAD, unchanged).
- **Acceptance**: viewing any personal history version decrypts successfully; the value passed as AES-GCM additionalData byte-equals the entry-blob AAD for the same `(userId, entryId)`.

### C2 — Rotation re-encrypts personal history under the entry AAD
- **File**: `src/lib/vault/vault-context.tsx:1062-1075`
- **Change**: replace `buildPersonalHistoryAAD(userId, histEntry.entryId, histEntry.id)` with `buildPersonalEntryAAD(userId, histEntry.entryId, VAULT_TYPE.BLOB)`. The same `histAad` is used for both the decrypt-with-old-key and encrypt-with-new-key calls (unchanged structure). Update the import (drop `buildPersonalHistoryAAD`).
- **Invariant**: rotation reads each history blob with the AAD it was actually written with (entry "blob" AAD) and rewrites it with the same AAD under the new key — so a rotated history row remains decryptable by C1's path.
- **Acceptance**: a personal vault that has ≥1 history row can complete key rotation without a decrypt failure; post-rotation, history view (C1) still decrypts.

### C3 — Remove `buildPersonalHistoryAAD` and the `"PH"` scope
- **File**: `src/lib/crypto/crypto-aad.ts`
- **Change**: delete `export function buildPersonalHistoryAAD(...)` (`:130-143`), delete the `SCOPE_PERSONAL_HISTORY = "PH"` constant (`:24`), and remove the `"PH" — Personal Vault history ...` line from the module docblock (`:13`).
- **File**: `src/lib/crypto/crypto-aad.test.ts` — remove the `buildPersonalHistoryAAD` import and the PH-scope tests (`:47-48`, `:216-217`, `:222-223`), keeping the surrounding PV/cross-scope tests intact (re-target any cross-scope distinctness test that paired PV against PH to a still-existing scope pair, or drop it if redundant).
- **Ledger (Test T9 — CI-breaking if missed)**: `docs/security/crypto-domain-ledger.md:32` has a `| 'PH' | SCOPE_PERSONAL_HISTORY | ... |` row. `check-crypto-domains.mjs` (CI + `pre-pr.sh:130`) cross-checks ledger↔code bidirectionally, so removing the code constant **without** removing this row fails `npm run check:crypto-domains`. Delete the `PH` row in the same change.
- **Forbidden patterns** (must NOT appear in `git diff` result anywhere under `src/`):
  - `pattern: buildPersonalHistoryAAD` — reason: function removed; any remaining reference is a missed consumer.
  - `pattern: SCOPE_PERSONAL_HISTORY` — reason: constant removed.
  - `pattern: "PH"` (as an AAD scope literal in `crypto-aad.ts`) — reason: scope retired.
- **Acceptance**: `rg -n "buildPersonalHistoryAAD|SCOPE_PERSONAL_HISTORY" src/` returns nothing; `npx next build` and `npx vitest run` pass.

### C4 — Unit test reflects the entry-AAD model (and would have caught the bug)
- **File**: `src/components/passwords/entry/entry-history-section.test.tsx`
- **Change**: remove `buildPersonalHistoryAAD` from the `@/lib/crypto/crypto-aad` mock (`:53-55`) and its stale `// C2: ... PH scope` comment; keep `buildPersonalEntryAAD` mocked (returns `"test-aad"`).
- **Coupled assertion (Test T1 — Critical, anti-vacuous)**: the existing personal-decrypt test asserts only `expect(mockDecryptData).toHaveBeenCalled()`, which passes vacuously even if the wrong AAD is passed. The fix MUST add BOTH:
  1. `expect(buildPersonalEntryAAD).toHaveBeenCalledWith("user-1", "entry-1", "blob")`, AND
  2. `expect(mockDecryptData).toHaveBeenCalledWith(expect.anything(), expect.anything(), "test-aad")` (i.e. the builder's mocked return value IS the `additionalData` arg to `decryptData`).
  Both are required: (1) alone passes even if the component computes the right AAD then passes the wrong variable to `decryptData`.
- **Note (RT1 honesty)**: `decryptData` and the AAD builders are mocked in this jsdom test, so this unit test verifies only the *AAD scope selection + wiring*, not real AES-GCM. The mock-reality gap is why the original test passed while production failed. Real-crypto verification is C5's job. State this limitation in the test comment.
- **Acceptance**: the test fails if the personal branch selects any AAD other than the entry "blob" AAD, OR fails to forward it to `decryptData`.

### C5 — Integration test: edit → history snapshot → view decrypts (real DB + real crypto)
- **File**: new real-DB integration test under `src/__tests__/db-integration/` (run via `npm run test:integration`, requires Postgres). The harness already supports **real** Web Crypto in Node — `vault-rotate-key-attachments.integration.test.ts` uses `crypto.subtle` + `encryptData`/`decryptData`/`encryptBinary` from `@/lib/crypto/crypto-client` directly (Test T2 confirmed testability).
- **Walkthrough (real producer → real consumer round-trip)**: generate a real `CryptoKey` → `encryptData(payload, key, buildPersonalEntryAAD(userId, entryId, "blob"))` → seed a `PasswordEntry` row with that blob AND a `PasswordEntryHistory` row holding the **same** blob verbatim (mirrors the server snapshot at `route.ts:153`; seed via the existing RLS-bypass helper `setBypassRlsGucs`) → read the history row back → `decryptData(blob, key, buildPersonalEntryAAD(userId, entryId, "blob"))` → assert the plaintext equals the original payload.
- **Anti-vacuous negative (Test T2 — Critical)**: also assert that decrypting the same blob with a **wrong** AAD rejects — e.g. `await expect(decryptData(blob, key, buildPersonalEntryAAD(userId, entryId, "overview"))).rejects.toThrow()`. (Use a still-existing wrong scope, NOT `buildPersonalHistoryAAD`, which is deleted by C3.) Without this, the positive assertion could pass under a key/AAD coincidence.
- **Why integration**: this is the only layer that exercises real AES-GCM with real AAD bytes end to end; the unit layer cannot (C4 note). Directly implements the "boundary round-trip" class-fix and mirrors `project_integration_test_gap`.
- **Acceptance**: positive decrypt round-trips the payload; negative decrypt rejects. The test fails if C1's AAD does not byte-match the server-snapshotted blob's AAD.

### C6 — Delete the dead per-history PATCH re-encrypt handlers (keep GET)
- **Files**: `src/app/api/passwords/[id]/history/[historyId]/route.ts`, `src/app/api/teams/[teamId]/passwords/[id]/history/[historyId]/route.ts`.
- **Change**: delete `handlePATCH`, `export const PATCH = withRequestLog(handlePATCH)`, the `reencryptLimiter` const, and the now-unused imports (`historyReencryptSchema` / `teamHistoryReencryptSchema`, `parseBody`, `createHash`, `createRateLimiter` — drop each only if it has no other use in the file). Keep `handleGET` + `export const GET` and everything the GET path needs.
- **Invariant**: the history **View** path (`GET`) is untouched and still works; only the unreachable re-encrypt entry point is removed.
- **Acceptance**: both route files still export `GET`, no longer export `PATCH`; `npx next build` resolves with no dangling imports; the history View (C1/C5) still passes.

### C7 — Remove the dead re-encrypt validators + the now-orphaned `HISTORY_BLOB_MAX`
- **File**: `src/lib/validations/entry.ts` (`historyReencryptSchema` `:88`, `teamHistoryReencryptSchema` `:96`) and any re-export barrel (`@/lib/validations`).
- **Change**: delete both schema definitions and their re-exports, and the `HISTORY_BLOB_MAX` import in `entry.ts`.
- **Dead constant (Func F2 / Sec S1)**: `HISTORY_BLOB_MAX` (`src/lib/validations/common.ts:101`, comment `// history reencrypt allows larger blobs`) is used **only** by the two removed schemas. Delete the `common.ts:101` export. Update the only test consumers: `common.test.ts` (the `CIPHERTEXT_MAX < HISTORY_BLOB_MAX` assertion + its import) and remove the `HISTORY_BLOB_MAX` import in `entry.test.ts` if the max+1 boundary tests were part of the removed schema describes.
- **Forbidden pattern (extends C8 list)**: `pattern: HISTORY_BLOB_MAX` must not appear in `src/` after the change.
- **Acceptance**: `rg -n "historyReencryptSchema|teamHistoryReencryptSchema|HISTORY_BLOB_MAX" src/` returns nothing.

### C8 — Remove the `ENTRY_HISTORY_REENCRYPT` audit action (TS const + Prisma enum, lockstep)
- **Files**:
  - `src/lib/constants/audit/audit.ts` — delete the `ENTRY_HISTORY_REENCRYPT` key from the `AUDIT_ACTION` const (`:131`), and remove its three references: the **`AUDIT_ACTION_VALUES`** flat array (definition at `:215`; entry near `:318`), and the `AUDIT_ACTION_GROUP.HISTORY` arrays in `AUDIT_ACTION_GROUPS_PERSONAL` `:489` and `AUDIT_ACTION_GROUPS_TEAM` `:567`. The `HISTORY` group remains non-empty (`ENTRY_HISTORY_RESTORE`, `HISTORY_PURGE`). (`TEAM_WEBHOOK_EVENT_GROUPS` derives from `AUDIT_ACTION_GROUPS_TEAM` by spread, so it drops the action automatically.)
  - `prisma/schema.prisma` — delete `ENTRY_HISTORY_REENCRYPT` from `enum AuditAction` (`:102`).
  - `messages/en/AuditLog.json` (`:86`), `messages/ja/AuditLog.json` (`:86`) — delete the `ENTRY_HISTORY_REENCRYPT` label key.
  - `docs/operations/audit-log-reference.md` (Func F3) — remove the `ENTRY_HISTORY_REENCRYPT` action row (`:180`) and its entry in the two `group:history` tables (`:392`, `:410`). This is **live operational doc** (not archive), so it must stay accurate.
  - Generate the migration via `npm run db:migrate` (Prisma emits the recreate-type enum migration). **Do NOT hand-edit historical migration files**; the past `ALTER TYPE ... ADD VALUE 'ENTRY_HISTORY_REENCRYPT'` migration stays as immutable history.
- **Invariant (lockstep)**: the `as const satisfies Record<AuditAction, AuditAction>` constraint holds only if the TS const keys exactly equal the Prisma enum members — so both edits land in the same change.
- **Forbidden patterns** (must NOT appear after the change, scoped to `src/`, `messages/`, `prisma/schema.prisma` — **NOT** `prisma/migrations/`, which is history):
  - `pattern: buildPersonalHistoryAAD` — reason: removed (C3).
  - `pattern: SCOPE_PERSONAL_HISTORY` — reason: removed (C3).
  - `pattern: ENTRY_HISTORY_REENCRYPT` — reason: audit action removed.
  - `pattern: historyReencryptSchema|teamHistoryReencryptSchema` — reason: validators removed (C7).
  - `pattern: reencryptLimiter` — reason: handlers removed (C6).
- **Acceptance**: `npx next build` type-checks (the `satisfies Record<...>` passes); the recreate migration applies cleanly on the dev DB; `rg` for each forbidden pattern in the scoped paths returns nothing.

### C9 — Update / delete the affected tests
- **Delete (whole-file, they test only the removed PATCH; GET coverage is a superset in the co-located `route.test.ts`, verified by Test T10)**: `src/__tests__/api/passwords/history-reencrypt.test.ts`, `src/__tests__/api/teams/team-history-reencrypt.test.ts`.
- **Edit (remove the PATCH describe blocks, keep GET) + delete the now-dead locals (Test T5)**: `src/app/api/passwords/[id]/history/[historyId]/route.test.ts` — drop the `PATCH ...` describe at `:145+`, the `PATCH` named import (`:41`), the `updateMany` field of the prisma mock, the `createHash` import, and the PATCH-only fixtures (`validPatchBody`, `OLD_BLOB_HASH`, `OLD_BLOB`, `BLOB_IV`, `BLOB_AUTH_TAG`). These become unused after the describe removal and would fail lint / strict TS. Same trim for the team `route.test.ts` (it imports only `GET`, so lighter).
- **Edit (remove the dead-schema describe blocks + imports)**: `src/lib/validations/validations.test.ts` (`historyReencryptSchema` `:782`, `teamHistoryReencryptSchema` `:812` + imports `:36-37`), `src/lib/validations/entry.test.ts` (`historyReencryptSchema` `:320`, `teamHistoryReencryptSchema` `:377` + imports `:9-10`, and the `HISTORY_BLOB_MAX` import if it was only used by these describes). Leaving any import is a hard `npx next build` TS error (Test T8).
- **Crypto-aad tests (C3 companion)**: `src/lib/crypto/crypto-aad.test.ts` — remove `buildPersonalHistoryAAD` import + PH tests (`:47-48`, `:216-217`, `:222-223`); re-target any PV-vs-PH distinctness test to a still-existing scope pair (PV "blob" vs PV "overview") or drop if redundant.
- **i18n coverage gate is grep, not the coverage test (Test T3)**: `audit-log-keys.test.ts` / `audit-i18n-coverage.test.ts` only check `AUDIT_ACTION(_VALUES) → label` (every action has a label); they do **not** detect an **orphan** label (a JSON key with no matching action). So after removing the action, a forgotten `AuditLog.json` key would NOT fail these tests. The actual gate for the label deletion is the C8 forbidden-pattern grep (`rg ENTRY_HISTORY_REENCRYPT messages/`). **Optionally** (recommended, closes the class permanently) add an orphan-key assertion to `audit-i18n-coverage.test.ts`: every action-shaped key in `AuditLog.json` (excluding `group*`/meta keys) must be in `AUDIT_ACTION_VALUES`.
- **C2 rotation-with-history regression guard (Test T6)**: add a jsdom unit test for the `vault-context.tsx` rotation loop (mocking `crypto-aad`/`crypto-client`/`fetch`, same pattern as `entry-history-section.test.tsx`) asserting that for each history entry `buildPersonalEntryAAD(userId, histEntry.entryId, "blob")` (NOT `buildPersonalHistoryAAD`) is used, and that the **same** AAD value is passed to both the old-key `decryptData` and the new-key `encryptData`. This is the only automated guard for C2 (integration tests exercise the server `applyVaultRotation`, not the client loop).
- **Acceptance**: `npx vitest run` green with no skipped/orphaned references to the removed symbols; the C2 guard fails if the rotation loop reverts to a non-entry AAD.

### C10 — Migrate the dev DB and verify end to end
- **Steps**: run `npm run db:migrate` against the dev Postgres (per `feedback_run_migration_on_dev_db`), confirm the recreate-type enum migration applies (no row uses the value, so it succeeds). Then run the full gate (Testing strategy below).
- **Acceptance**: migration applies; `npx vitest run`, `npx next build`, `npm run test:integration`, `bash scripts/pre-pr.sh` all pass.

---

## Part B — Eliminate the AAD-drift recurrence *by mechanism* (not by memory)

**Why**: AAD mismatches have shipped 3× (#503 codebase drift; this history bug producer↔consumer + path drift; #507 boundary-strip). One root cause: AAD is a *distributed contract* (producer↔consumer, codebase↔codebase, version↔version) but is built by ad-hoc calls scattered across files, with scope chosen per call-site, no SSoT, and the crypto boundary mocked in tests. A memory note does not prevent recurrence — only a **mechanical gate that fails CI** does. (User direction: 「memoryもそうですが仕組みで排除したい」「あるべき・本質的でないと意味がない」.) See `project_aad_distributed_contract_rootcause`.

**Reframe (round-2 review + user decision)**: the "仕組み" already partially EXISTS — `docs/security/crypto-domain-ledger.md` (scope + HKDF-info ledger) is cross-checked against code by `scripts/checks/check-crypto-domains.mjs`, wired into CI + `pre-pr.sh:130`. Part B **extends/hardens this existing infra** rather than inventing a parallel gate. The mechanism is **unify-to-one-format + enforce coverage**: since migration is not a concern (user), all AAD is reformatted to the single binary `buildAADBytes` format (C11), which *eliminates* the format-proliferation axis rather than merely gating it. The string-delimited stragglers (round-2 found 3 distinct format families) become a hard violation the gate forbids.

**Current scattered surface (verified — 3 format families today; C11 collapses them to 1)**:
- **Binary length-prefixed** (`buildAADBytes`, scope codes in the ledger): PV, OV, IK, AT, AW (crypto-aad.ts), AR (admin-reset-token-crypto.ts — *imports* `buildAADBytes`, byte-safe to relocate), and **OK** (`crypto-team.ts:186` `buildTeamKeyWrapAAD` — a third *inline re-implementation* of the encoder, byte-identical to `buildAADBytes("OK",4,…)` → consolidating is byte-safe).
- **Pipe-delimited UTF-8** (`.join("|")`): `crypto-emergency.ts:96` (escrow wrap), `webhook-aad.ts:64`. **Colon-delimited** (`a:b:c`): `account-token-crypto.ts:76`. → C11 reformats all three to binary (breaking the 3 server-side data types listed in C11; vault data unaffected).
- **AEAD via Node `crypto` `setAAD` (not Web Crypto `additionalData`)**: `envelope.ts`, `crypto-server.ts` (used by admin-reset, account-token, webhook). An `additionalData`-only gate regex misses these — C13 scans `setAAD` too.
- **Web Crypto `crypto.subtle` + `additionalData`** outside crypto-client: `crypto-team.ts` (4 wrap sites: `wrapTeamKeyForMember`/`unwrapTeamKey`/`wrapItemKey`/`unwrapItemKey` — NOT `encrypt/decryptTeamEntry`, which delegate to crypto-client), `crypto-emergency.ts` (2).
- **Intentional NO-AAD subtle sites** (must NOT be flagged): `export-crypto.ts`, `crypto-recovery.ts`, `wrap/unwrapSecretKey` in crypto-client.ts, `extension/session-crypto.ts`.
- **Parity coverage today**: `aad-parity.test.ts` covers only PV (app↔ext); iOS `AADParityTests.swift` pins full bytes for PV only, struct-probes OV/AT/IK (header bytes, not full vector).

### C11 — Unify ALL AAD to the single binary format (one format, one registry)
**Decision (user): migration is not a concern → eliminate the format-proliferation axis entirely, don't just gate it.** All AAD becomes the length-prefixed binary `buildAADBytes` format with a registered 2-char scope. There is exactly ONE AAD format and ONE encoder afterward.
- **Byte-identical relocations (no data impact)**: move `SCOPE_ADMIN_RESET` + `buildAdminResetAAD(...)` into `crypto-aad.ts` (already uses `buildAADBytes`); consolidate `crypto-team.ts:186` `buildTeamKeyWrapAAD` (scope `OK`) to call the shared `buildAADBytes` — **verified byte-identical** to `buildAADBytes("OK",4,[teamId,toUserId,keyVersion,wrapVersion])` (same header + length-prefix), so team-key-wrap data is unaffected.
- **Reformat to binary (breaking, accepted pre-1.0, no migration)**: give `crypto-emergency.ts`, `webhook-aad.ts`, `account-token-crypto.ts` named registry builders with new scopes (e.g. `EM`/`WH`/`AC`) emitting `buildAADBytes` binary, replacing their `join("|")` / `:`-concat. **Bonus**: length-prefixing natively prevents delimiter-collision, so the hand-rolled defenses become removable — account-token's `":"`-rejection and webhook's UUID-format validation are obsoleted by the format (keep validation only if it serves a non-AAD purpose).
- **Make `buildAADBytes` module-private** (drop the `:224` re-export). After this, any AAD encoding outside `crypto-aad.ts` is a compile error; the gate (C13) is defense-in-depth.
- **Invariant**: every AAD value in the codebase is `buildAADBytes` binary, produced by a *named* builder in `crypto-aad.ts`. No string-delimited AAD exists anywhere.

**Breaking changes (acceptable per user — no migration; pre-1.0 policy as in #503)**. Client E2E vault data (PV/OV/IK/OK/AT/AW — entries, passwords, team data) is **unaffected** (already binary; `OK` is byte-identical). Reset to server-side recovery/integration data only:
| Data | Effect | Recovery |
|------|--------|----------|
| `Account` OAuth tokens (account-token AAD) | decrypt fails on next read | **self-healing** — re-OAuth auto-rewrites the row (existing documented behavior) |
| `TenantWebhook`/`TeamWebhook` secrets | delivery-signature verify fails | admin regenerates the webhook secret |
| `EmergencyAccessKeyPair/KeyExchange` escrows | existing emergency-access grants invalidated | grantor re-establishes the grant |

### C12 — Declared AEAD-primitive allowlist (allowlist, not rewrite)
- Enumerate the files permitted to perform AEAD with AAD, across BOTH primitives: Web Crypto `additionalData` — `crypto-client.ts`, `crypto-team.ts` (4 wrap sites), `crypto-emergency.ts`; Node `crypto` `setAAD` — `envelope.ts`, `crypto-server.ts`. **Decision (cost/risk, not architecture)**: allowlist these working, verified, security-critical primitives rather than rewrite them through one module — the SSoT goal is "AAD bytes come from a registered named builder + every scope is parity+round-trip tested", not "one file holds all subtle calls". The gate forbids any **new** AEAD-with-AAD site outside the allowlist.

### C13 — Harden the EXISTING gate `check-crypto-domains.mjs` (extend, don't duplicate)
- Extend the existing checker (CI + `pre-pr.sh:130`), failing the build when:
  1. The encoder appears outside `crypto-aad.ts` — detect `buildAADBytes` references, inline re-implementations (the `DataView`/`setUint16(...,false)` header idiom), AND **string-delimited AAD feeding AEAD** (a `.join("|")` / template-concat value passed to `additionalData`/`setAAD`) — the latter is now a hard violation since all AAD is binary. Comment-stripped to avoid doc-line false positives.
  2. An AEAD-with-AAD site (`additionalData` OR Node `setAAD`) appears outside the C12 allowlist (scan `src/` **and** `extension/src/`). Intentional no-AAD subtle sites are not flagged.
  3. Every ledger/manifest scope lacks a parity test or a round-trip test — checked **at vitest level**, not shell grep: the parity test imports the C16 manifest and asserts each entry has its `GOLDEN_*` vector + a named round-trip test (file-path `existsSync`, not name-string grep — round-2 T4/F5).
- **Self-test (round-2 T3)**: ship `scripts/checks/__tests__/check-crypto-domains.test.mjs` fixtures (a known-bad scratch string for each rule) so the gate itself is regression-protected, not "verified once".
- **This is the structural elimination**: a new scope / ad-hoc encoder / unguarded AEAD site / untested scope fails CI. Drift becomes unmergeable.

### C14 — Golden-vector parity for every cross-codebase scope (full bytes)
- **app ↔ extension** (`aad-parity.test.ts`): add frozen `GOLDEN_*` hex + cross-decrypt for **OV** (blob+overview), **IK**, **OK** (the scopes the extension implements beyond PV). Server-only scopes (`AW`/`AR`/`EM`/`WH`/`AC`) have no ext/iOS counterpart → frozen app-side golden vector only (pins the now-binary bytes; also the regression guard against accidental re-fragmentation).
- **iOS** (`AADParityTests.swift`): upgrade OV/AT/IK from header-byte struct-probes to **full-byte** `XCTAssertEqual` against frozen vectors matching the PV pattern.
- **Acceptance**: every scope present in ext/iOS has a full-byte pinned assertion; C13 confirms presence via the manifest.

### C15 — Boundary round-trip tests per producer↔consumer scope (real crypto)
- Real-producer-seal → real-consumer-open, no mocks. History = C5. Add for **every** scope: PV blob/overview, OV blob/overview, IK, OK, AT, AW, and the newly-binary server scopes EM (emergency escrow), WH (webhook secret), AC (account token) — each seals with the named builder and opens with the same, asserting round-trip + an anti-vacuous wrong-AAD rejection.
- **Acceptance**: each scope has a round-trip; C13 confirms presence.

### C16 — Machine-checkable AAD registry manifest (bidirectional)
- A typed manifest (in `crypto-aad.ts` or `aad-registry.ts`) with **only mechanically-checkable** fields per scope: `{ scope, parityTestFile, roundTripTestFile }` (no `format` field — all AAD is now binary, so a non-binary format is simply forbidden by C13; drop prose `sealer`/`opener` — not enforceable, round-2 T10).
- **Bidirectional enforcement (round-2 S7/T4)**: a vitest test asserts (a) every named builder/scope in code has a manifest entry (no unregistered scope), AND (b) every manifest entry maps to an existing builder + existing test files (no stale entry). This closes the bootstrap gap where a new scope silently skips the gate.

**Deferred (anti-gold-plating)**: persisting the scope as stored metadata alongside ciphertext (self-describing-at-rest) is NOT in scope — the scope is already in the AAD bytes, now built in one registered place (C11) and enforced (C13/C16); a stored field would touch every write path and the on-disk shape for defense-in-depth only.

## Testing strategy

1. `npx vitest run` — full app unit suite green (C3, C4 changes).
2. `cd extension && npm test` — extension suite green (no extension change expected; sanity only).
3. `npm run test:integration` (real Postgres) — C5 round-trip green; also exercise a rotation-with-history path if a fixture exists (C2).
4. `npx next build` — production build green (TypeScript: removed export has no dangling references).
5. `bash scripts/pre-pr.sh` — CI-only gates before push.
6. Manual (real dev DB): edit a personal entry, open its change history, View an old version → decrypts; then rotate the vault key and re-view → still decrypts.

## Considerations & constraints

- **Out of scope**: data migration / backward-compat fallback (user direction + no PH data exists); `historyId` rollback-binding (incompatible with server-snapshot, deferred — no current data relies on it); iOS (no history UI); extension (no history AAD).
- **Risk — rotation regression**: C2 is on the key-rotation path (security-sensitive). Because the previous PH-based rotation provably could not persist when history existed, C2 cannot make a currently-working case worse; it makes a currently-broken case work. Still, the rotation+history path must be exercised (testing step 3/6) before merge.
- **Risk — incomplete removal**: a stray reference to any removed symbol would fail the build (removed export / type error). The forbidden-pattern grep in C8 is the explicit gate.
- **Risk — enum recreate migration**: the `AuditAction` recreate migration rebuilds the column type and its `@@index([action])`. It is dev-safe because no row uses `ENTRY_HISTORY_REENCRYPT` (no client ever invoked the PATCH emitters). If a dev DB *does* contain such a row (e.g. from prior manual API exercise), the recreate `USING (...::text::"AuditAction_new")` cast fails — surface that as a precondition rather than silently deleting rows. Confirm the generated SQL swaps every column of the type (incl. any `audit_outbox` action column) within one transaction.
- **R12/R11 (audit action group coverage)**: removing the action from both the display group and any subscription/webhook group is required and sufficient — there is no re-add, since the action is gone. Verify no webhook-event group enumerates it post-removal.
- **Webhook subscription rows hold action names as `String[]` (Func F5, Sec R13)**: `TeamWebhook.events` / `TenantWebhook.events` are plain `String[]`, not typed enum columns. Any existing row that subscribed to `ENTRY_HISTORY_REENCRYPT` keeps the stale string after the migration — harmless (the emitter is gone, so the dispatcher's `events: { has: ... }` never matches), and no data cleanup is needed. Note it; do not migrate it.
- **Pre-existing, out of scope (Sec S2)**: the restore route copies a history blob into the live entry without asserting `history.aadVersion === entry.aadVersion`. Not reachable today (snapshots share the entry's aadVersion) and not worsened by this change; noted for future hardening, not fixed here.

## User operation scenarios

1. Personal login entry, edited twice → open "変更履歴 (2)" → View each version → both decrypt and display (sensitive fields masked).
2. Personal card/identity entry (non-login type) with history → View → decrypts (type-agnostic; aadVersion≥1).
3. Personal entry with history → change master passphrase / rotate key → rotation completes → re-open history → View → decrypts under the new key.
4. aadVersion 0 legacy entry history (pre-AAD) → View → decrypts with `undefined` AAD (guard preserved, unchanged).

## Go/No-Go Gate

| ID  | Subject                                                        | Status  |
|-----|----------------------------------------------------------------|---------|
| C1  | Personal history decrypt uses entry AAD (PV "blob")            | locked |
| C2  | Rotation re-encrypts personal history under entry AAD          | locked |
| C3  | Remove `buildPersonalHistoryAAD` + `"PH"` scope                | locked |
| C4  | Unit test asserts entry-AAD selection (RT1 limitation noted)   | locked |
| C5  | Integration test: edit→snapshot→view decrypts (real crypto)    | locked |
| C6  | Delete dead per-history PATCH handlers (keep GET)              | locked |
| C7  | Remove dead `historyReencryptSchema`/`teamHistoryReencryptSchema` | locked |
| C8  | Remove `ENTRY_HISTORY_REENCRYPT` (TS const + Prisma enum + i18n) | locked |
| C9  | Update/delete affected tests                                   | locked |
| C10 | Migrate dev DB + full verification gate                        | locked |
| C11 | Unify ALL AAD to one binary format (breaking 3 server scopes)  | locked |
| C12 | Declared AEAD-primitive allowlist (Web Crypto + Node setAAD)   | locked |
| C13 | Harden existing `check-crypto-domains.mjs` gate + self-test    | locked |
| C14 | Full-byte golden-vector parity for OV/IK/OK (+iOS) scopes      | locked |
| C15 | Round-trip tests per scope (+ pin pipe/colon current bytes)    | locked |
| C16 | Bidirectional machine-checkable manifest                       | locked |
