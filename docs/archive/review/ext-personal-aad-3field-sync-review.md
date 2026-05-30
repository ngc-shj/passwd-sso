# Plan Review: ext-personal-aad-3field-sync

Date: 2026-05-30
Review round: 1

## Changes from Previous Round

Initial review.

## Functionality Findings

- **F1 [Critical]** — Call-site inventory incomplete. Plan says "8 sites"; there are **11** production sites. Missing: `index.ts:1347` (`performAutofillForEntry` — decrypts BOTH blob and overview with one AAD; this is the handler `AUTOFILL_CREDIT_CARD`/`AUTOFILL_IDENTITY`/`AUTOFILL` invoke, so the user's actual goal stays broken), `index.ts:1945` (COPY_PASSWORD), `index.ts:2023` (COPY_TOTP). Verified by orchestrator.
- **F2 [Critical]** — `UPDATE_LOGIN` (`login-save.ts:213-227`) uses one `aad` for blob decrypt, overview decrypt, blob re-encrypt, AND overview re-encrypt. C3 mentions it vaguely ("if present"); C4 (the cross-field-AAD contract) does not list it. Must split into blobAad/overviewAad. Verified.
- **F4 [Minor]** — Plan's "8 sites across 3 files" count is wrong (11 actual). Fix count.
- (Adjacent→Func from Sec) aadVersion promotion: UPDATE_LOGIN writes `aadVersion: data.aadVersion ?? 1`; a 0-version legacy entry gets promoted to 1 on update. Acceptable under no-migration, but document.

## Security Findings

- **S1 [Major]** — (same root cause as F1) 3 undocumented call sites; after C1's 2→3-arg signature change TypeScript forces a compile error at each (good backstop), but the plan gives no vaultType guidance, and `index.ts:1347` needs the same blob/overview split as the create paths. Verified.
- **S2 [Major]** — (same root cause as F2) UPDATE_LOGIN has the identical cross-field shared-AAD bug; must be added to C4. Verified.
- **S3 [Minor]** — Server-controlled `aadVersion` downgrade: all personal decrypt paths except passkey (`passkey-provider.ts:233` rejects `<1`) silently fall back to `undefined` AAD when the server returns `aadVersion: 0`. **No plaintext-exposure vector** (the ciphertext was encrypted WITH AAD, so GCM auth-tag verification fails on the no-AAD decrypt; attacker would need the key to forge a no-AAD ciphertext). Worst case = decryption failure (UX/DoS), likelihood = requires server compromise, cost-to-fix = low but touches legacy-read behavior. Pre-existing in changed files. See orchestrator disposition.
- **S4 [Minor → confirmed safe, no action]** — 2-field vs 3-field AAD cannot collide: the `nFields` byte (2 vs 3) is a structural discriminator even though the version byte stays `1`. Confirmed safe.
- **S5 [Minor]** — C5 parity test covers only personal AAD; team/history/itemkey AADs (duplicated in `crypto-team.ts`) are not guarded. Document that C5 ≠ full AAD coverage so reviewers don't over-read it.

## Testing Findings

- **T1 [Critical]** — `extension/src/__tests__/lib/crypto.test.ts:243` asserts `expect(aad[3]).toBe(2)` (field count). C1 makes it 3 → extension CI red. Must update (and flip to `3`, becoming a co-equal structural guard — T5).
- **T2 [Critical]** — `background-login-save.test.ts` (≈8 sites) encrypts fixtures with 2-arg `buildPersonalEntryAAD`; post-C1 fixtures mismatch production AAD → vacuous-pass or false-fail. Must update to 3-arg with matching vaultType; UPDATE tests must use separate blobAad/overviewAad.
- **T3 [Critical]** — `background-passkey-provider.test.ts` (≈8 sites) — same class as T2.
- **T4 [Major]** — `background.test.ts:488` asserts `toHaveBeenCalledWith("user-1","pw-1")` (2 args) → fails post-C1; needs 3rd arg. Audit `background-commands.test.ts` and `background/totp-handlers.test.ts` mocks too.
- **T6 [Major]** — (same as F1/S1) 3 missing index.ts sites; `:1347` is a C4-class dual-field site.
- **T5 [Major]** — C5 should also flip the extension's own `lib/crypto.test.ts:243` field-count assertion as an in-extension-suite structural guard.
- **T9 [Minor → elevated by orchestrator for recurrence-prevention intent]** — CI: `app-ci` (runs the root parity test) triggers on the `app` path filter, which lacks `extension/**`. An extension-only AAD regression triggers only `extension-ci`, so the root parity test never runs → C5's recurrence-prevention purpose is defeated for the most likely future regression. Must wire CI.
- **T7 [Minor]** — Verify `extension/src/lib/crypto.ts` (the imported module) compiles/loads under root tsconfig in the root suite. (Orchestrator: `crypto-aad.ts` has zero imports; `crypto.ts` AAD functions use only TextEncoder/DataView; root tsconfig includes dom lib. Low risk; add a verification step.)
- **T8 [Minor]** — Name explicit import sources for the cross-decrypt regression test.
- **T10 [Minor]** — `extension/src/__tests__/crypto-encrypt.test.ts` (5 sites) uses 2-arg calls → update.

## Adjacent Findings

- [Adjacent] (Sec→Func) aadVersion promotion on UPDATE_LOGIN — documented under F-disposition.
- [Adjacent] (Func→Sec) `index.ts:1347` dual-field decrypt = read-side analogue of the C4 create-path replay-protection gap.

## Recurring Issue Check

### Functionality expert
R3: **Finding F1/F4** (missed call sites). R17/R22: Finding F2 (UPDATE overview not named). R25: create paths write both fields (Finding F2 for UPDATE). R1,R2,R4–R16,R18–R37: N/A or Checked-no-issue. C5 import feasibility: confirmed.

### Security expert
R3: **Finding S1/S2**. RS2 (AAD binding completeness): Checked — userId+entryId+vaultType sufficient; no protection weakened. RS3 (aadVersion downgrade): **Finding S3**. RS4 (cross-field replay): **Finding S1/S2** (autofill + update paths). RS1: N/A. R25 security-downgrade: S3. R31 (broken crypto): Checked — random IV preserved, GCM throughout. All others N/A.

### Testing expert
RT1 (mock-reality): **Finding T2/T3/T4**. RT2 (testability): Checked — parity cross-import feasible. R19 (mock alignment): **T2/T3/T4**. R33 (CI cross-config): **Finding T9**. RT4/RT5: T2/T3/T9. Others Checked/N-A.

## Orchestrator disposition (Round 1 → plan revision)

- **F1/S1/T6 (Critical/Major)** → ADOPT. Expand C2 (add index.ts:1945, 2023), add new dual-field contract coverage for index.ts:1347 in C4.
- **F2/S2 (Critical/Major)** → ADOPT. Add UPDATE_LOGIN (login-save.ts:215) to C4.
- **T1/T2/T3/T4/T10/T5 (Critical/Major)** → ADOPT. New contract **C6**: update all existing extension test fixtures/mocks/assertions to the 3-arg form + flip the field-count assertion.
- **T9 (recurrence-prevention)** → ADOPT. Add `extension/src/lib/crypto.ts` + `crypto-team.ts` to the CI `app:` path filter so the root parity test runs on extension-side AAD changes. New contract **C7**.
- **T7/T8 (Minor)** → ADOPT into C5 text (verification step + explicit import sources).
- **S5 (Minor)** → ADOPT into C5 considerations (scope note).
- **S3 (Minor, security)** → **DOCUMENT as accepted risk, do NOT add reject-guard.** Anti-Deferral: Worst case = decryption failure only (no plaintext exposure — GCM tag fails without the key); Likelihood = low (requires server compromise); Cost-to-fix = low but changes legacy aadVersion-0 read behavior, which is migration-adjacent and explicitly out of scope per the user's "no data migration" constraint. Adding a reject-guard is speculative defensive scaffolding for a non-exploitable path; deferred with this justification. Tracked: `TODO(ext-personal-aad-3field-sync): consider rejecting aadVersion<1 on personal LOGIN decrypt paths if legacy 0-version entries are confirmed absent`.
- **F4 (Minor)** → ADOPT (correct count to 11).

---

## Round 2

Changes reviewed: expanded C2 (index.ts:1945/2023), C3 (index.ts:977), C4 (all 4 dual-field paths incl index.ts:1347 + login-save.ts:215), new C6 (test updates), new C7 (CI wiring), S3 disposition.

All Round-1 Critical/Major confirmed RESOLVED. New findings:
- **F5/T11 [Major]** — C6 under-scoped `lib/crypto.test.ts` (8 calls, not 1) → ADOPT: C6 now covers the whole describe block; grep is authoritative.
- **F6 [Minor]** — C4 `??` wording wrong (`??` doesn't fire on 0) → ADOPT: corrected.
- **T15 [Major]** — C6 "not vacuous" was a principle, not structural → ADOPT: per-field BLOB/OVERVIEW distinct-variable rule + required anti-vacuous throw test.
- **T13 [Major] + S6 [Minor]** — C7 CI-filter coupling triggers full 15-min app-ci on extension-only changes + hardcodes files → ADOPT REDESIGN: C7 replaced with an extension-suite golden-vector guard (no ci.yml change). Root C5 catches app-side drift under app-ci (the #482 direction — the regression that actually happened); C7 extension golden test catches extension-side drift under extension-ci.
- **T12 [Minor]** — background.test.ts stub-mock paths don't validate vaultType → ACCEPTED (pre-existing; real validation in round-trip + anti-vacuous tests).
- **T14 [Minor]** — cross-decrypt test key unspecified → ADOPT (generateKey).

## Round 3

Changes reviewed: C4 wording fix, C5 golden vectors + generateKey, C6 full-file scope + structural per-field rule + anti-vacuous test, C7 redesign.

- **Functionality**: No findings. All 11 production sites reconfirmed mapped to C2/C3/C4; C4/C6 corrections verified.
- **Security**: No findings. Dual-suite golden-vector design closes both recurrence directions without ci.yml coupling; S3 + C4 still sound; cross-decrypt regression provides real-world decrypt signal beyond golden vectors.
- **Testing**: 3 Minor doc/process notes → ALL ADOPTED:
  - **T16** — add symmetric cross-field throw to C5 root suite.
  - **T17** — derive golden hex from the byte spec and cross-verify both impls before pinning (don't copy one side).
  - **T18** — cross-field throw coverage lives in crypto.test.ts (+C5); note so it isn't orphaned.

**Convergence**: Functionality + Security clean at Round 3; Testing's residual items were Minor documentation notes, now incorporated. All 7 contracts locked. Plan ready for Phase 2.
