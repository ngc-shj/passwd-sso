# Plan Review: vault-attachment-rotation-phase-b
Date: 2026-05-04
Review rounds: 2

## Round summary

### Round 1 — initial review (Functionality / Security / Testing in parallel)
- 41 distinct findings (8 Critical, 20 Major, 15 Minor, 1 Adjacent) across the three experts.
- After dedup (F3↔S9 audit-value casing; F4↔S12 Bearer-bypass; F12↔T14 manual-test plan).
- All Critical + Major (28) addressed via plan edits citing finding IDs.
- Most Minor addressed; remaining Minor either consolidated into Major fixes or deferred per Anti-Deferral rules.

### Round 2 — incremental verification (all three experts in parallel)
- All 41 Round 1 findings verified RESOLVED.
- 21 new findings:
  - 1 Critical: **T15** (`e2e/helpers/redis.ts` does not exist — fictitious helper file).
  - 4 Major: **F19** (Prisma instance count cap contradicts I12.3+I12.5), **T16** (`applyAttachmentMigration` extraction undeclared in C5), **T17** (`pg_locks` polling barrier has no precedent in repo), **T22** (RLS bypass via superuser role in tests).
  - 16 Minor: F20–F23, S13–S18, T18–T21, T23–T24.
- All Round 2 Critical + Major (5) addressed.
- Round 2 Minor addressed: F20 (key prefix), S13 (hash encoding), S14 (teamPasswordEntryId predicate symmetry), S15 (audit field renamed `legacyAttachmentsMigratedClientReported`), S17 (M5 attack vector clarified), S18 (M8 sub-variants), F21 (§C9b dialog dup removed), F22 (user.keyVersion temporal clarity), F23 (CEK zeroization wording), T19 (line-citation drift removed; rely on grep), T20 (`expect.fail` not `ctx.skip`), T21 (production AAD path required in helper), T23 (VARCHAR columns in I12.5), T24 (audit field-presence-then-equality pattern).
- Round 2 Minor NOT addressed (informational only):
  - **S16**: 5000-row updateMany inside one rotation tx is DoS-shaped (informational; post-write check covers correctness).
  - **T18 partial**: rate-limit cap raised to `VAULT_ROTATE_ATTACHMENT_CEK_MAX + 1000` (5000+1000) for retry headroom; the cross-limiter reset coordination concern is documented inline in C5 (the helpers reset specific keys; no shared key prefix).

### Decision
Round 2 confirms the plan's structural soundness. The Critical/Major Round 2 findings were specificity refinements (e.g., naming the extracted pure functions, replacing a fictitious helper file, scoping role choice for RLS-honoring tests) — they do NOT change the architectural shape. Contracts C0–C13 are now stable enough to lock; further rounds would yield diminishing-return refinements only.

## Changes from Previous Round
(Round 1 above is the initial review; Round 2 above is the verification + delta this round.)

## Summary

| Severity  | Functionality | Security | Testing | Total |
|-----------|---------------|----------|---------|-------|
| Critical  | 2 (F1, F2)    | 0        | 6 (T1–T6) | 8 |
| Major     | 8 (F3–F10)    | 6 (S1–S6)| 6 (T7–T12)| 20 |
| Minor     | 7 (F11–F17)   | 6 (S7–S12)| 2 (T13–T14)| 15 |
| [Adjacent]| 1 (F18)       | 0        | 0       | 1 |

After dedup (F3↔S9 audit value casing; F4↔S12 Bearer-bypass auth; F12↔T14 manual-test plan): **41 distinct findings**.

## Functionality Findings

### F1 Critical: prisma.attachment.update with non-unique compound where is invalid in Prisma
- File: plan §C7 ORM call shape (also §C5)
- Evidence: Plan: `prisma.attachment.update({ where: { id, passwordEntry: { userId }, encryptionMode: 2 }, data: {...} })`. Prisma `update` requires UNIQUE where. Existing Phase A code uses `updateMany` for compound filters (route.ts:263–275 `updateMany({ where: { id, userId }, data })` then asserts `count === 1`).
- Problem: As written, the rotation transaction throws `PrismaClientValidationError` on every per-row update. Silent-fix path (drop predicates, use `update({ where: { id } })`) breaks cross-tenant scoping silently.
- Impact: Implementation is unimplementable; integration tests fail immediately, OR tenancy bypass.
- Fix: Rewrite §C5/§C7 — `prisma.attachment.updateMany({ where: { id, passwordEntry: { userId }, encryptionMode: <expected> }, data: {...} })` + assert `result.count === 1`. New invariant: "Per-attachment write is `updateMany` + `count === 1` guard, NOT `update`. Zero-count is fatal."

### F2 Critical: Migration endpoint rate-limit (30/min) incompatible with rotation throughput
- File: plan §C5 rate-limiter
- Evidence: Reuses `attachmentUploadLimiter` (30/min). I6.3 + Risks anticipate vaults with >1000 mode-0; cap is 5000.
- Problem: 1000 attachments → ~33 min; 5000 → ~2.7 hr. Limiter shared with upload path; concurrent uploads consume budget twice.
- Impact: Users with non-trivial attachments locked out mid-rotation; UX unusable; client may abort the rotation.
- Fix: §C5 — separate per-user migrate limiter sized for VAULT_ROTATE_ATTACHMENT_CEK_MAX (e.g. 600/min or 5000/15min); OR bypass during active rotation. Document tradeoff with §S1 (rate-limit is also a security parameter).

### F3 Major: AUDIT_ACTION value naming convention violation (merged with S9)
- File: plan §C10
- Evidence: Plan uses `"attachment.legacy_migration"`. Existing values in `src/lib/constants/audit/audit.ts:34-35` are UPPER_SNAKE matching key (`ATTACHMENT_UPLOAD: "ATTACHMENT_UPLOAD"`). audit-i18n-coverage.test.ts:21-28 enforces value-key match.
- Problem: Lowercase+dot breaks convention; SIEM regex `/^ATTACHMENT_/` won't match.
- Impact: Forensic-tool divergence; SIEM dashboards omit new action.
- Fix: Change to `"ATTACHMENT_LEGACY_MIGRATION"`; update i18n keys.

### F4 Major: Bearer-bypass route classification not reconciled — migrate auth ambiguous (merged with S12)
- File: plan §C5 I5.2
- Evidence: `src/lib/proxy/cors-gate.ts:22` — `EXTENSION_TOKEN_ROUTES` includes `API_PATH.PASSWORDS`; `isBearerBypassRoute` matches prefix. New `/migrate` qualifies. I5.2 references `session.user.id` (assumes session).
- Problem: A Bearer-only request bypasses session gate, arrives with `session = null`. Plan doesn't specify migrate's auth posture.
- Impact: Either extension/CLI can't finish migration, OR implementer adds `authOrToken` permitting SA/MCP tokens to mutate user attachments.
- Fix: Add I5.6+I5.7 — "Authentication uses `auth()` only; Bearer rejected with 401. Forbidden pattern: `authOrToken\(` in migrate route file. Rationale: legacy migration requires OLD secretKey in memory, which only browser-unlocked session has."

### F5 Major: vault-context.tsx update not in plan scope; orphan field risk
- File: plan §C8/§C9
- Evidence: `src/lib/vault/vault-context.tsx:123-127` exports `rotateKey` with `options?: { acknowledgeAttachmentDataLoss?: boolean }`; `RotationEffects` (line 91-100) includes `attachmentsAffected`. Public API. Plan covers `rotate-key-dialog.tsx` but not vault-context.tsx. C9 grep targets miss `attachmentsAffected`.
- Problem: vault-context.tsx contains rotation orchestration (line 818-1011). RotationEffects shape change is C7-implicit, not C8-explicit.
- Impact: PR may leave dangling `attachmentsAffected` orphan fields; new mode2/mode0 shape lands without a typed consumer interface.
- Fix: Add C8-prerequisite — "Update vault-context.tsx: (a) remove `acknowledgeAttachmentDataLoss` from rotateKey options; (b) remove `attachmentsAffected` from RotationEffects; (c) replace inline body (line 818-1011) with C8 mode-0 → migrate → mode-2 rewrap loop." Extend C9 I9.1 grep targets to: `RotationEffects.attachmentsAffected` + dialog references (line 43, 93, 96, 99, 199, 204, 223).

### F6 Major: Defensive guard 2 (manifest count match) creates TOCTOU window
- File: plan §C7 second guard
- Evidence: Manifest assembled by client from GET that ran outside advisory lock; POST guard counts mode-2 rows.
- Problem: A new mode-0 → mode-2 migration (S5 scenario) OR a new mode-2 upload between GET and POST changes the count. The strict equality rejects both legitimate cases. Concurrent uploads cause spurious failures; livelock possible.
- Impact: Spurious rotation failures during normal user activity; retry cost is O(M) rewraps.
- Fix: Choose explicitly: (a) advisory lock in BOTH /data + POST + continuation token tied to data-fetch generation, OR (b) loosen guard to "every id in attachmentCekRewraps exists as mode-2 row owned by user, AND no mode-0 rows exist" — accept extra mode-2 rows. Document chosen mitigation as C7 invariant.

### F7 Major: I7.4 metadata field `legacyAttachmentsMigrated` derivation racy/under-specified
- File: plan §C7 I7.4
- Evidence: I7.4 says "rolled-up since prior rotation, derived from migration audit events". Requires rotation TX to query audit_logs.
- Problem: (a) audit_logs is written by outbox worker — worker-lag undercounts; audit_outbox cross-table read inside rotation TX risks lock-order. (b) No table/window/first-rotation specification.
- Impact: Implementation lands with undercount, deadlock, or zero-on-first-rotation. Audit metadata unreliable.
- Fix: Replace I7.4 — client tells server. POST body adds `legacyAttachmentsMigratedThisCycle: number`. Server records as audit metadata. Defensive guards already enforce integrity. Add invariant: "client-asserted reporting count; does not gate rotation success."

### F8 Major: I8a.2 references nonexistent "session vault state refetch"
- File: plan §C8a I8a.2
- Evidence: Current vault-context.tsx exposes `getKeyVersion()` (line 131) returning in-memory ref. No session-vault-state refetch endpoint.
- Problem: Race protection comes from advisory lock + post-rotation token revocation (line 412), not from "refetch keyVersion before wrap". I8a.2 is unspecified and probably no-op.
- Impact: Implementation either ignores I8a.2 or implements a useless `useSession().update()`.
- Fix: Reword: "Upload uses keyVersion from getKeyVersion() at moment of CEK wrap. Server response carries persisted keyVersion; if it differs the client SHOULD re-upload (rare race). If rotation has invalidated the session, upload 401s." Add server-side: upload route response includes `keyVersion: <persisted>`.

### F9 Major: I7.3 invariant unprovable — count-based assertion underspecified
- File: plan §C7 I7.3
- Evidence: I7.3: "every personal attachment for the user has cek_key_version === newKeyVersion".
- Problem: Conflates two checks. "every attachment for user" is ambiguous wrt team mode-1 attachments (NULL cek_key_version). Mode-0 row makes property vacuously false until guard fires.
- Impact: T12.1 acceptance fails on users owning team attachments.
- Fix: Restate: "After successful POST, every Attachment row scoped by `passwordEntry: { userId } AND encryptionMode: 2` has `cek_key_version === newKeyVersion`. Mode-0/1 rows out of scope."

### F10 Major: /api/v1/* (REST API v1) impact not enumerated
- File: plan "Server route changes"
- Evidence: CLAUDE.md API table lists `/api/v1/passwords/[id]`. v1 is Bearer-key public surface.
- Problem: If v1 returns attachment metadata, it has the same encryptionMode branching obligation; new CEK fields needed in v1 schema.
- Impact: v1 third-party integrations may receive attachment objects without encryptionMode/CEK fields.
- Fix: Add to "Server route changes" — "Audit OpenAPI spec at `src/lib/openapi-spec.ts`; if attachments exposed in v1, extend response schema with new fields and bump OpenAPI version. If not exposed, add explicit out-of-scope note."

### F11 Minor: I0.1 forbidden-pattern misses `1_000` decimal-with-underscore variant
- File: plan §C0
- Evidence: Forbidden pattern `const ATTACHMENT_MANIFEST_CAP\s*=` outside common.ts. common.ts uses `VAULT_ROTATE_HISTORY_MAX = 10_000`.
- Problem: Developer redefining as `const FOO = 1000` (different name) bypasses SSoT.
- Fix: Tighten forbidden pattern to also cover `=\s*1[_]?000\b` outside canonical file. Add CI grep to acceptance.

### F12 Minor: Manual test plan deliverable not co-authored (merged with T14)
- See merged finding T14 below.

### F13 Minor: I9.1 grep allowlist forgets cli/ and extension/
- File: plan §C9 I9.1
- Evidence: I9.1 lists `src/`, `e2e/`, `messages/`. Repo also has `cli/` and `extension/` workspaces.
- Fix: Extend I9.1 grep scope to `src/`, `e2e/`, `messages/`, `cli/src/`, `extension/src/`.

### F14 Minor: ECDH private key wrapping omitted from rotation flow sketch
- File: plan "Rotation flow (revised)"
- Evidence: Current rotate-key route (line 60-62, 327-330) re-wraps `encryptedEcdhPrivateKey`. Plan POST sketch: "{ entries, historyEntries, attachmentCekRewraps, ... existing fields without acknowledgeAttachmentDataLoss }".
- Problem: Reading literally suggests dropping ECDH rewrap.
- Fix: Rewrite POST body sketch as delta: "DROPS: acknowledgeAttachmentDataLoss; ADDS: attachmentCekRewraps; UNCHANGED: all other fields per Phase A schema at src/app/api/vault/rotate-key/route.ts:36-70".

### F15 Minor: AAD scope "AW" missing from file-header docs
- File: plan §C2
- Fix: Add to C2 — "Update file-header comment block at `src/lib/crypto/crypto-aad.ts:11-15` to list `\"AW\" — Attachment CEK Wrap (entryId, attachmentId, cekKeyVersion, cekWrapAadVersion)`. Add SCOPE_ATTACHMENT_WRAP constant to constants block at lines 21-24."

### F16 Minor: Audit target type referencing existing constant unclear
- File: plan §C10
- Fix: Reword: "Target: `AUDIT_TARGET_TYPE.ATTACHMENT` (existing); `targetId = attachment.id`."

### F17 Minor: WebCrypto wrapKey vs export+encrypt convention not specified
- File: plan §C8 I8.1
- Fix: Add C2/C8 sub-invariant: "CEK wrap uses `crypto.subtle.exportKey('raw', cek) → AES-GCM encrypt with secretKey + wrap AAD`, mirroring team ItemKey wrap idiom. Do NOT use `crypto.subtle.wrapKey`."

### F18 [Adjacent] Minor: PRF-stored unlock + recovery wrap interaction with mid-migration abort
- See Adjacent Findings below.

## Security Findings

### S1 Major: Migrate endpoint allows silent ciphertext-body replacement under valid session
- File: plan §C5 I5.4
- Evidence: I5.4 — "replacement encryptedData blob writes to the same blob object id (overwrite); old ciphertext is not retained." Server has no plaintext-integrity check (E2E posture).
- Problem: Session attacker (XSS, stolen device, malware) can issue PUT /migrate to ANY mode-0 attachment with a fully self-consistent payload — fresh CEK, fresh AAD-correct IV/authTag, arbitrary `encryptedData`. Every legacy attachment becomes a one-shot, irreversible body-overwrite oracle. Strictly worse than Phase A.
- Impact: Silent destruction or substitution of legacy attachment bodies under stolen-session attack.
- Fix: Require migrate request to include `oldEncryptedDataHash` (SHA-256 over stored bytes). Server compares inside advisory-locked transaction; mismatch → 409. Binds the request to the specific stored bytes the client claims to have decrypted.

### S2 Major: Mode-2 row written under OLD secretKey extends snapshot-compromise window
- File: plan Rotation flow + S3 scenario
- Evidence: Each migrate is its own DB tx; mode-2 row is written under OLD vault key wrap; user can abort and reopen later.
- Problem: Vault rotation's intent is retiring old secretKey from trust boundary (whitepaper §6.1.c). Aborted migration leaves body-stable mode-2 rows wrapped under OLD secretKey readable from any DB snapshot until rotation commits. Backup tape retains OLD-key wrap forever.
- Impact: Snapshot+key-compromise window expanded vs Phase A's "destroyed at rotation" posture.
- Fix: Add explicit threat-table entry. Constrain S3: dialog SHOULD commit a CEK-only rewrap opportunistically when an aborted-migration state is detected on relogin. If infeasible, document in §6.1.d: "mode-2 wraps written before the corresponding rotation-POST commit are equivalent in trust posture to OLD secretKey."

### S3 Major: AAD wrap-version downgrade not prevented
- File: plan AAD design + §C2
- Evidence: Plan AAD includes `cekWrapAadVersion`. Row stores it as plain int. Server writes from request without cross-check. AES-GCM verifies AAD bytes match wrap/unwrap but cannot bind the AAD-version field VALUE to row-stored field independently.
- Problem: When v2 introduces fields beyond v1, an active attacker who flips `cek_wrap_aad_version` from 2→1 while leaving cekEncrypted/cekIv/cekAuthTag alone could push a v2-strict client into v1-acceptance, weakening cross-tenant transplant resistance.
- Impact: Forward-compatibility weakness; future upgrade rolled back by row-flip.
- Fix: §C2/§C8a — client gates accepted `cekWrapAadVersion` against `MIN_ACCEPTED_CEK_WRAP_AAD_VERSION` constant. Forbidden pattern: client unwrap MUST be paired with `>= MIN_ACCEPTED` check.

### S4 Major: cek_key_version desync hides under "successful" rotation
- File: plan §C7 I7.3
- Evidence: At wrap time, server stores cek_key_version from client request without cross-check against user.keyVersion.
- Problem: Tampering attacker (DB admin) flips one row's `cek_key_version` to keyVersion+1. On next rotation, manifest count check passes; AAD chain breaks for that row only; rotation completes "successfully" but that attachment fails decryption forever. No audit signal.
- Impact: Single-attachment DoS hiding under successful rotation; forensic attribution lost.
- Fix: §C7 — server reconciles `cek_key_version === user.keyVersion` AT WRAP TIME (during rotation per-row update). If pre-rotation row has mismatch, throw `LegacyAttachmentInconsistentVersionError`.

### S5 Major: Migrate endpoint accepts arbitrary cekKeyVersion from client
- File: plan §C5
- Evidence: Migrate request includes `cekKeyVersion` set freely.
- Problem: Session-attacker could PUT migrate with `cekKeyVersion: 999_999`. AAD chain self-consistent but tampered version persists.
- Impact: Forensic attribution lost; tracking cookie across rotations.
- Fix: §C5 — server enforces `cekKeyVersion === user.keyVersion`. Add I5.6: "Server rejects 400 if cekKeyVersion != user.keyVersion."

### S6 Major: Removed affectedAttachmentIds without successor — forensic regression
- File: plan §C7 I7.5 + audit log changes
- Evidence: I7.5 removes `affectedAttachmentIds`, `affectedAttachmentIdsOverflow`. New metadata is counts only.
- Problem: After Phase B, audit row carries only counts. If single attachment fails post-rotation decryption (S4), audit log has no record of which IDs were "expected to be rewrapped".
- Impact: Forensic regression; SIEM/IR cannot reconstruct rotation scope from audit log alone.
- Fix: §C7/§C10 — retain capped ID manifest: `cekRewrappedAttachmentIds` (cap ATTACHMENT_MANIFEST_CAP=1000) + `cekRewrappedAttachmentIdsOverflow: boolean`.

### S7 Minor: attachmentUploadLimiter is the only defense for S1 chosen-ciphertext at scale
- File: plan §C5 rate-limiter
- Problem: Raising the cap (per F2) further weakens this defense; not raising creates F2.
- Fix: §C5 — document that rate-limit cap is BOTH UX tuning knob AND security parameter; if Functionality raises cap (per F2), S1 hash-binding fix becomes mandatory.

### S8 Minor: cek_key_version === user.keyVersion post-condition only enforced by I7.3 prose
- File: plan §C7 I7.3
- Fix: §C7 — add post-write defensive check inside transaction asserting `count of mode-2 rows where cek_key_version != newKeyVersion === 0` for this user. Throw if non-zero.

### S9 Minor: AUDIT_ACTION value casing inconsistent (merged with F3)
- See F3 above.

### S10 Minor: Whitepaper §6.1.c update — caveat needs rewording, not deletion
- File: plan §C11 I11.2
- Problem: Phase B does not re-encrypt file bodies; CEK protects body. The caveat's intent (warn that bodies remain bound to OLD CEK) is still TRUE under Phase B; what changes is OLD CEK is now wrapped under NEW secretKey. A reader who misreads "caveat removed" loses accurate threat model (S2 follows from this).
- Fix: I11.2 — REWORD §6.1.c: "Previous secretKey is removed from trust boundary. File bodies remain encrypted under their stable, freshly-rewrapped CEK (body is not re-encrypted; CEK wrap is). Attacker who recovered old secretKey AND pre-rotation cekEncrypted snapshot would still recover plaintext; freshness is bound to backup hygiene."

### S11 Minor: Manifest mismatch error response can leak attachment count
- File: plan §C7 defensive guard 2
- Evidence: Phase A errorResponse for ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED includes `attachmentsAffected` (route.ts:390).
- Fix: §C7 — explicitly document that ATTACHMENT_CEK_MANIFEST_MISMATCH and LEGACY_ATTACHMENTS_RESIDUAL return NO additional payload (no expected/observed counts). Generic UI message.

### S12 Minor: No CSRF/Bearer-bypass posture confirmation for migrate (merged with F4)
- See F4 above.

## Testing Findings

### T1 Critical: Existing seedAttachment helper produces non-decryptable bytes
- File: e2e/helpers/password-entry.ts:113-159 (on main)
- Evidence: `const encryptedData = randomBytes(64); const iv = ...toString("hex");` with comment "content does not need to be decryptable for the rotation-side count + acknowledge-flow assertions in #433."
- Problem: C8 acceptance requires "original file body still decrypts to the same plaintext" but seedAttachment writes random bytes; AES-GCM verification fails.
- Impact: C8 E2E test cannot verify the load-bearing property; vacuous-pass.
- Fix: Add explicit contract — seedAttachment must take optional (plaintext, encryptionKey) and produce real AES-GCM ciphertext. Vitest test for the helper round-trips plaintext.

### T2 Critical: I10.1 invokes a test that does NOT exist on main
- File: src/__tests__/audit-i18n-coverage.test.ts (i18n-only, not group-membership)
- Problem: Plan I10.1 invokes "group-coverage test that already enumerates AUDIT_ACTION (R12 invariant)" — that test does NOT exist; group-membership is unenforced today.
- Impact: A future contributor could add an AUDIT_ACTION value and forget to register it in any group; nothing fails.
- Fix: Add C10b — author group-coverage test asserting `every AUDIT_ACTION_VALUES entry is registered in at least one PERSONAL or TEAM group`.

### T3 Critical: Existing route.test.ts files reference Phase A names; not enumerated for update
- File: src/app/api/vault/rotate-key/route.test.ts (4 hits), src/app/api/vault/rotate-key/data/route.test.ts (4 hits)
- Problem: §C9 enumerates production code/i18n/E2E removal but NOT route-level unit test files mocking the Phase A response shape.
- Impact: RT1 mock-reality divergence — tests silently pass against removed code OR break the build.
- Fix: Add C9b — explicit list of route-level unit test files needing update with specific actions.

### T4 Critical: §C12 integration test does not specify how the route handler is exercised
- File: existing src/__tests__/db-integration/vault-rotate-key-gaps.integration.test.ts
- Evidence: Existing integration test explicitly excludes "the full POST handler" — exercises subroutines like markGrantsStaleForOwner directly.
- Problem: T12.x assumes end-to-end rotation flow invocation. Existing infrastructure doesn't support it.
- Impact: T12.1–T12.7 untestable in current `test:integration`.
- Fix: Add explicit strategy. Recommended: extract `applyVaultRotation(tx, userId, payload)` pure function from route handler; T12.x calls it with real Prisma transaction. Route becomes thin wrapper.

### T5 Critical: T12.6c contested loop will not contend under integration runner config
- File: vitest.integration.config.ts:11 (`maxWorkers: 1`)
- Problem: `pool: "forks", maxWorkers: 1` — within a file, all tests share one Node process and one PrismaClient with one pg.Pool. "Promise.all of two queries" doesn't translate to genuine concurrent transactions at Postgres level.
- Impact: T12.6c's RT4 vacuous-pass guard fires false positives; "race opened" assertion fails OR passes vacuously due to single-direction wins.
- Fix: I12.3 — T12.6c uses two distinct `createPrismaForRole('superuser')` instances. Verify advisory lock contention via pg_locks query in setup before main loop runs.

### T6 Critical: Migration rate-limiter reuse will collide with E2E test budget
- File: plan §C5; main rotateLimiter `windowMs: 15min, max: 3` (route.ts:34)
- Evidence: Phase A E2E calls `resetRotationRateLimit` 3 times in one test (line 152). Phase B's mixed-mode flow needs at least same; possibly more.
- Problem: Plan does not enumerate which E2E test cases need `resetRotationRateLimit`. Migration of 20+ mode-0 attachments hits attachmentUploadLimiter (30/min) too — needs `resetAttachmentUploadLimit(userId)` helper which doesn't exist.
- Impact: Phase B E2E flaky in CI without explicit reset placements.
- Fix: §C8 acceptance — each E2E test variant calls `resetRotationRateLimit` at start + before each second rotate-key fetch/POST. Add new helper `resetAttachmentUploadLimit(userId)` extending `e2e/helpers/redis.ts` for legacy migration loops with N>20.

### T7 Major: §C0 wording "extracted from inline" is inaccurate
- File: src/app/api/vault/rotate-key/route.ts:74 (already a named constant)
- Fix: Reword §C0: "relocate ATTACHMENT_MANIFEST_CAP from src/app/api/vault/rotate-key/route.ts:74 to src/lib/validations/common.ts". Acceptance: `grep -rn "= 1000\b" src/app/api/passwords src/app/api/vault` returns no Phase B–era literal.

### T8 Major: §C8a Vitest component tests required without scaffolding precedent
- File: src/components/passwords/entry/attachment-section.tsx (no colocated .test.tsx)
- Problem: No existing testing pattern. Risk: tests written against mocked crypto-client (RT1 divergence).
- Fix: §C8a sub-contract — test file uses real `@/lib/crypto/crypto-client` (no module mock), real Web Crypto subtle key fixture. Mocks limited to `useVault({ encryptionKey })` + next-intl. Decrypt assertions compare plaintext, not spy invocations.

### T9 Major: T12.6a/b "deterministic" cases assume specific transaction interleaving not guaranteed
- File: plan §C12 T12.6a/b
- Problem: Without explicit synchronization barrier (transaction A acquires lock, test polls pg_locks for granted=true, THEN starts B), B might execute before A's lock acquisition completes.
- Fix: I12.4 — T12.6a uses two distinct Prisma instances. Sequence: A `BEGIN; pg_advisory_xact_lock(...)`; **wait** for pg_locks via instance C; THEN B fires migrate; assert B enters granted=false; THEN A commits; THEN B unblocks.

### T10 Major: Persist/hydrate process-boundary not specified
- File: plan §C12; vitest.integration.config.ts:9-14
- Problem: Single-process tests don't verify Prisma's bytea encoding / base64 round-trip for the new `cekEncrypted Bytes?` column.
- Fix: I12.5 — for T12.1, T12.2, T12.7: verify via SECOND Prisma instance constructed fresh after rotation tx commits. Reads compare cekEncrypted byte-by-byte against original wrap blob.

### T11 Major: I3.3 "ignored on writes" not asserted by any test
- File: plan §C3 I3.3
- Fix: §C3 acceptance — "Integration test: POST with `keyVersion: 999` → 201 + row's key_version unchanged from server-set default + warning log line asserted via test logger spy."

### T12 Major: Mode-1 negative test missing on attachment endpoints
- File: plan §C5 acceptance
- Fix: §C5 acceptance — "Integration test: migrate against team-attachment id (mode-1) using session with team access → 404. Migrate scopes to `passwordEntryId IS NOT NULL AND teamPasswordEntryId IS NULL` not just `passwordEntry: { userId }`."

### T13 Minor: T12.7 audit metadata test misses mode0Residual assertion
- Fix: T12.7 — assert `mode0Residual: 0` (numeric, not undefined / null); also T12.3 asserts NO `VAULT_KEY_ROTATION` audit row exists on rejection.

### T14 Minor: Manual test plan deliverable not authored (merged with F12)
- File: plan §Testing strategy
- Fix: New contract C13 — Manual test plan listing exact scenarios: fresh-install upload + read-back, mixed mode-0 + mode-2 happy-path rotation, mid-rotation browser close + resume per S3, attacker-with-old-wrap-blob per S4, concurrent migrate + rotate per S5, mode-0 download AFTER Phase B server reject of mode-0 uploads but BEFORE rotation. File exists at named path or PR cannot merge.

## Adjacent Findings

### F18 [Adjacent] Minor: PRF-stored unlock + recovery wrap interaction with mid-migration abort
- File: plan S3 user-operation scenario
- Routing to: Security expert (verified — see S2 which addresses snapshot-compromise window with related reasoning)
- Resolution: Add a paragraph to S3: "PRF wrapping is NOT cleared until the rotation tx commits, so the abort case leaves PRF unlock functional with the OLD secretKey, which still unwraps mode-2 CEKs correctly."

## Quality Warnings
None — all findings include Evidence + concrete Fix.

## Recurring Issue Check

### Functionality expert
- R1: Checked — plan reuses existing buildAADBytes, attachmentUploadLimiter
- R2: Finding F11
- R3: Findings F5, F10
- R4: N/A — no event dispatch added
- R5: Checked — advisory lock + tx specified
- R6: N/A — no cascade delete changes
- R7: Checked — no selector changes
- R8: Checked
- R9: Checked — invalidateUserSessions correctly outside tx
- R10: Checked
- R11: N/A
- R12: Finding F3
- R13: N/A
- R14: Checked — passwd_app role covers attachment writes
- R15: Checked — no env values in migration spec
- R16: Checked
- R17: Findings F5, F8
- R18: N/A
- R19: Finding F5 (RotationEffects shape change)
- R20: N/A
- R21: N/A
- R22: Checked
- R23: N/A
- R24: Checked — I1.1/I1.2 split correctly
- R25: Checked — schema additions persisted; client reads on download
- R26: N/A
- R27: N/A
- R28: N/A
- R29: Checked — no external standards cited
- R30: N/A
- R31: I12.2 explicitly excludes users/tenants/sessions
- R32: N/A
- R33: N/A
- R34: Checked
- R35: Finding F12 (merged with T14)
- R36: N/A

### Security expert
- R1 (Race / TOCTOU): Checked — advisory lock covers migrate vs rotate
- R2 (Re-binding / replay across versions): Findings S3, S4, S5
- R3: N/A — no findings deferred
- R4: N/A — plan-stage
- R5: Finding S5
- R6: Finding S11
- R7: Checked
- R8: Checked — AES-256-GCM continued
- R9: Findings S3, S4
- R10: Checked — I5.3 explicit non-idempotent
- R11: Checked — additive nullable
- R12: Checked with S9 caveat
- R13: Checked
- R14: Checked
- R15: Checked
- R16: Checked
- R17: N/A
- R18: Checked
- R19: Checked
- R20: Checked — I10.2
- R21: Checked
- R22: Checked
- R23: Checked
- R24: Checked
- R25: Checked
- R26: N/A
- R27: Checked
- R28: N/A
- R29: Checked
- R30: Checked
- R31: Checked
- R32: Finding S11
- R33: N/A
- R34 (Cryptographic-material handling): Findings S1-S5 propagation traced
- R35: Checked
- R36: N/A
- RS1: Checked
- RS2: Finding S11
- RS3: Findings S1, S5
- RS4: Checked

### Testing expert
- R1: Checked
- R2: Findings T5, T9
- R3: Finding T3
- R4: Checked — I12.2 limits truncation
- R5: Finding T1
- R6: Finding T13
- R7: N/A
- R8: Finding T10
- R9: Checked
- R10: N/A
- R11: Checked
- R12: Finding T2
- R13: N/A
- R14: Checked
- R15: N/A
- R16: Finding T3 subset
- R17: Findings T11, T12
- R18: Checked
- R19: Checked
- R20: N/A
- R21: Checked
- R22: N/A
- R23: N/A
- R24: Checked
- R25: Finding T10
- R26: N/A
- R27: Checked
- R28: Finding T5
- R29: N/A
- R30: Checked — I12.2 explicit
- R31: N/A
- R32: N/A
- R33: Checked
- R34: Checked
- R35: Finding T14
- R36: N/A
- RT1: Finding T3
- RT2: Finding T4
- RT3: Finding T7
- RT4: Finding T5
