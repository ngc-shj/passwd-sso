# Plan: Sync extension personal-vault AAD to the app's 3-field scheme

Date: 2026-05-30
Branch: `fix/ext-personal-aad-3field-sync`

## Project context

- **Type**: web app + browser extension (mixed). This change is scoped to the **browser extension** (`extension/`) plus one new cross-implementation parity test under the app test root (`src/__tests__/`).
- **Test infrastructure**: unit + integration (Vitest). Two **separate** suites:
  - Root: `npx vitest run` — collects `src/**/*.test.{ts,tsx}` only (per `vitest.config.ts`). This is a CLAUDE.md mandatory gate.
  - Extension: `cd extension && npm test` (`vitest run`, no separate config) — collects `extension/**/*.test.ts`.
  - Builds: `npx next build` (root, mandatory) and `cd extension && npm run build` (`tsc && vite build`).

## Objective

The browser extension cannot decrypt any **personal-vault** entry (login, credit card, identity, passkey — blob *or* overview) that was encrypted by the current web app. As a result such entries silently vanish from the extension (popup list, inline suggestions, manual fill). Restore decryptability by bringing the extension's personal-vault AAD to byte-parity with the app, and add a structural guard so the two implementations cannot silently diverge again.

### Root cause (confirmed, byte-level)

The web app migrated the **personal-vault** AAD from a 2-field shape to a 3-field shape in PR #482 (`d50c5fb5`, OWASP batch 3):

- App `buildPersonalEntryAAD(userId, entryId, vaultType)` → `buildAADBytes("PV", 3, [userId, entryId, vaultType])` where `vaultType ∈ {"blob","overview"}` (`src/lib/crypto/crypto-aad.ts:122-128`, `VAULT_TYPE` at `:38-42`).
- App encrypts the blob with `VAULT_TYPE.BLOB` and the overview with `VAULT_TYPE.OVERVIEW` (`src/lib/vault/personal-entry-save.ts:38-39`; read side `src/lib/vault/vault-context.tsx:1019-1022`).

The extension was last touched on its crypto layer in PR #312 (`e11d4b87`) — **before** #482 — and still uses the old 2-field shape: `buildPersonalEntryAAD(userId, entryId)` → `buildAADBytes("PV", 2, [userId, entryId])` (`extension/src/lib/crypto.ts:255-260`). The `buildAADBytes` byte format is otherwise identical between the two codebases (scope[2] + version[1]=1 + nFields[1] + length-prefixed fields), so the **only** divergence is the `nFields` byte (2 vs 3) and the absence of the `vaultType` field. AES-256-GCM authentication fails on any AAD mismatch, so the extension's `decryptData` throws and the entry is silently dropped (`extension/src/background/index.ts:1014-1016`).

The same #482 migration **was** propagated to the extension's **team** AAD (`extension/src/lib/crypto-team.ts:110-126`, 4-field with `vaultType`) — only the **personal** AAD was left behind. This is the exact gap the recurrence-prevention guard must close.

### Second bug found alongside (in scope): dual-field paths share one AAD

Four extension paths apply a **single** AAD object to **both** the blob and the overview field (encrypt and/or decrypt):

- `extension/src/background/login-save.ts:139` (SAVE_LOGIN **create** — encrypts both fields with one `aad`)
- `extension/src/background/passkey-provider.ts:366` (passkey **create** — encrypts both fields with one `aad`)
- `extension/src/background/index.ts:1347` (`performAutofillForEntry` — **decrypts** both blob and overview with one `aad`; this is the handler `AUTOFILL` / `AUTOFILL_CREDIT_CARD` / `AUTOFILL_IDENTITY` invoke)
- `extension/src/background/login-save.ts:215` (UPDATE_LOGIN — **decrypts** blob+overview and **re-encrypts** blob+overview, all with one `aad`)

The app uses **distinct** AADs per field (BLOB vs OVERVIEW) precisely to prevent cross-field ciphertext replay. Even after the 3-field fix, sharing one AAD would (a) defeat the cross-field replay protection and (b) make exactly one of the two fields undecryptable by the app (and by the extension, for app-written entries). Each of these paths must compute `blobAad` (BLOB) and `overviewAad` (OVERVIEW) separately. `index.ts:1347` is the most user-impactful: it is the path that actually fills the credit card, so without fixing it the reported symptom is only half-resolved (card appears in the list but fill fails).

## Requirements

### Functional
1. After the fix, the extension decrypts personal-vault **overviews** (popup list) and **blobs** (copy / fill / passkey assertion) that were produced by the current web app, for all personal entry types it supports (`LOGIN`, `CREDIT_CARD`, `IDENTITY`, `PASSKEY`).
2. Entries the extension **creates** (`SAVE_LOGIN`, passkey registration) and **updates** (`UPDATE_LOGIN`) must be decryptable by the web app — i.e., the extension must write the blob with the BLOB AAD and the overview with the OVERVIEW AAD, `aadVersion: 1`.
3. The `aadVersion`-gating behavior is preserved exactly: `aadVersion >= 1` → use the (now 3-field) AAD; `aadVersion` 0/absent → `undefined` (legacy no-AAD path), matching the app (`vault-context.tsx:1018-1022`).

### Non-functional
4. **No data migration** (explicit user constraint): the extension does **not** need to decrypt entries written by the *old* extension under the 2-field scheme. We adopt the app's current scheme wholesale; pre-existing 2-field-only data is out of scope (and is already unreadable by the app itself, per the #482 "BREAKING (pre-1.0)" note at `crypto-aad.ts:119-120`).
5. **Recurrence prevention**: a test in the **root** suite (so it runs under the mandatory `npx vitest run`) asserts byte-identical AAD output between the app and extension personal builders across a representative input matrix, so a future one-sided change fails CI.

## Technical approach

- Mirror the app's personal AAD shape in `extension/src/lib/crypto.ts` exactly: add a `VAULT_TYPE` const object + `VaultType` type, and change `buildPersonalEntryAAD` to take `vaultType` and emit `buildAADBytes(SCOPE_PERSONAL, 3, [userId, entryId, vaultType])`. The existing extension `buildAADBytes` is already byte-identical to the app's, so no change there.
- Thread the correct `vaultType` through **all 11** personal call sites across 3 files. Decrypt/encrypt of `encryptedBlob` → BLOB; decrypt/encrypt of `encryptedOverview` → OVERVIEW.
- Split every dual-field path's single `aad` into separate `blobAad`/`overviewAad` (2 create + 1 autofill-decrypt + 1 update).
- Update the extension test suite's fixtures/mocks/assertions that currently use the 2-arg builder.
- Add the parity test importing both implementations' pure AAD builders, and wire CI so it runs on extension-side AAD changes too.

This is deliberately a **minimal, in-place** change (no module extraction / refactor) — the extension already isolates team AAD in `crypto-team.ts`; the personal builder lives in `crypto.ts` and we keep it there.

## Contracts

### C1 — Extension personal AAD builder adopts the 3-field shape
- **File**: `extension/src/lib/crypto.ts`
- **Signature**:
  - `export const VAULT_TYPE = { BLOB: "blob", OVERVIEW: "overview" } as const`
  - `export type VaultType = (typeof VAULT_TYPE)[keyof typeof VAULT_TYPE]`
  - `export function buildPersonalEntryAAD(userId: string, entryId: string, vaultType: VaultType): Uint8Array` → returns `buildAADBytes(SCOPE_PERSONAL, 3, [userId, entryId, vaultType])`
- **Invariant**: byte output equals `src/lib/crypto/crypto-aad.ts`'s `buildPersonalEntryAAD` for identical `(userId, entryId, vaultType)`. The literal values `"blob"`/`"overview"` and `SCOPE_PERSONAL="PV"` and the AAD version byte `1` must match the app.
- **Acceptance**: C5 parity test passes; `buildPersonalEntryAAD` has no remaining 2-arg overload.

### C2 — All **blob-only** call sites pass `VAULT_TYPE.BLOB`
Sites that decrypt and/or re-encrypt **only** `encryptedBlob`:
  - `extension/src/background/index.ts:917` (COPY_PASSWORD / COPY_USERNAME blob decrypt)
  - `extension/src/background/index.ts:1945` (EXT_MSG.COPY_PASSWORD blob decrypt) **(was missing — R1 finding)**
  - `extension/src/background/index.ts:2023` (EXT_MSG.COPY_TOTP blob decrypt) **(was missing — R1 finding)**
  - `extension/src/background/passkey-provider.ts:236` (assertion blob decrypt **and** the assertion-counter re-encrypt at ~268-271 — both BLOB)
  - `extension/src/background/passkey-provider.ts:427` (replace-target blob decrypt)
  - `extension/src/background/login-save.ts:92` (SAVE_LOGIN existing-entry blob decrypt)
- **Acceptance**: every `buildPersonalEntryAAD(...)` on a blob-only path passes `VAULT_TYPE.BLOB`.

### C3 — All **overview-only** call sites pass `VAULT_TYPE.OVERVIEW`
  - `extension/src/background/index.ts:977` (`decryptOverviews` — the popup-list path; the user-reported symptom)
- **Acceptance**: `decryptOverviews` passes `VAULT_TYPE.OVERVIEW`; popup list shows app-created CREDIT_CARD/IDENTITY/LOGIN/PASSKEY entries.

### C4 — All **dual-field** paths use distinct blob/overview AADs
Every path that touches **both** fields must compute two AADs — `blobAad = buildPersonalEntryAAD(id..., VAULT_TYPE.BLOB)` and `overviewAad = buildPersonalEntryAAD(id..., VAULT_TYPE.OVERVIEW)` — and never cross them:
  - `extension/src/background/login-save.ts:139` (SAVE_LOGIN **create**: `encryptData(fullBlob, …, blobAad)`, `encryptData(overviewBlob, …, overviewAad)`)
  - `extension/src/background/passkey-provider.ts:366` (passkey **create**: same split)
  - `extension/src/background/index.ts:1347` (`performAutofillForEntry`: `decryptData(encryptedBlob, …, blobAad)`, `decryptData(encryptedOverview, …, overviewAad)`) **(was missing — the actual credit-card fill path)**
  - `extension/src/background/login-save.ts:215` (UPDATE_LOGIN: blob decrypt+re-encrypt → blobAad; overview decrypt+re-encrypt → overviewAad) **(was missing)**
- **Invariant**: the blob is never encrypted/decrypted with the OVERVIEW AAD or vice-versa. Create paths keep writing `aadVersion: 1`; UPDATE_LOGIN keeps `aadVersion: data.aadVersion ?? 1`. Note the `??` semantics precisely: it fires only on `null`/`undefined`, **not** on `0`. So an entry whose `aadVersion` is absent/null is written back as `1`; an explicit `aadVersion: 0` entry stays `0` and is re-encrypted with no AAD (`undefined`) — internally consistent and acceptable under the no-migration constraint. Do not add a 0→1 promotion branch.
- **Consumer-flow walkthrough** (the app is the consumer of extension-written ciphertext):
  - Consumer **app read path** (`src/lib/vault/vault-context.tsx:1019-1022`) reads `{ encryptedBlob, encryptedOverview, aadVersion, id }` and, for `aadVersion >= 1`, decrypts `encryptedBlob` with `buildPersonalEntryAAD(userId, id, BLOB)` and `encryptedOverview` with `buildPersonalEntryAAD(userId, id, OVERVIEW)`. Both fields the consumer needs (`id`, `aadVersion`) are present in the extension's POST/PUT body. After C4 the per-field AAD matches what the consumer computes → both decrypt. ✅
  - Consumer **extension autofill read** (`index.ts:1347`) is itself fixed by C4 so it can read app-written entries field-by-field.

### C5 — Recurrence-prevention parity test (root suite)
- **File**: `src/__tests__/aad-parity.test.ts` (new) — under `src/**` so it runs in the mandatory `npx vitest run`, which is gated by the CI `app:` path filter (`src/**`). **This is the guard for the regression that actually occurred (#482: app AAD changed, extension forgotten): editing `src/lib/crypto/crypto-aad.ts` triggers `app-ci`, runs this test, and it fails the moment the app builder diverges from the extension builder — no CI-config change required.**
- **Imports**: app builder from `@/lib/crypto/crypto-aad` (verified: zero top-level imports — pure leaf); extension builder from relative path `../../extension/src/lib/crypto` (verified: no module-level browser-API side effects; AAD functions use only `TextEncoder`/`DataView`, available in the node test env; root tsconfig includes the dom lib so `CryptoKey`/`AesGcmParams` types referenced elsewhere in that file resolve). **Pre-implementation verification step**: confirm the file imports/type-checks under the root config (a failing import is itself a finding). Fallback if import proves infeasible: assert each builder against the frozen golden hex (below).
- **Cross-decrypt regression test** (same file): `import { encryptData } from "@/lib/crypto/crypto-client"` (app) and `import { decryptData } from "../../extension/src/lib/crypto"` (extension); generate one shared key with `crypto.subtle.generateKey({name:"AES-GCM",length:256}, …, ["encrypt","decrypt"])`, encrypt an overview with the app's OVERVIEW AAD and decrypt it via the extension's OVERVIEW AAD → asserts success. This is the test that fails before the fix and passes after.
- **Assertions** (Arrange/Act/Assert, one concept each):
  - personal BLOB AAD bytes equal across app vs extension for sample `(userId, entryId)`
  - personal OVERVIEW AAD bytes equal across app vs extension
  - both builders equal a **frozen golden hex** for a canonical `(userId, entryId, vaultType)` triple (pins the absolute shape so a PR that breaks BOTH sides identically still fails). **Derivation (T17)**: compute the expected bytes from the spec formula (`"PV"` + version `0x01` + nFields `0x03` + per-field `[u16 len][utf8 bytes]`) and cross-verify that BOTH implementations reproduce it before pinning — do NOT copy one implementation's output into both tests (that would only prove self-consistency, not cross-implementation parity).
  - (structural lock) the AAD `nFields` byte is `3` and the decoded fields include the vaultType — differs from the legacy 2-field output
  - (cross-field throw, T16) encrypt a field with the BLOB AAD and assert decrypting it with the OVERVIEW AAD **throws**, in the root suite too — symmetric to C6's extension-suite anti-vacuous test, so the per-field binding is verified even if a future hotfix touches only `src/`.
  - non-ASCII `userId`/`entryId` (UTF-8 multibyte) produce equal bytes (guards encoder parity)
- **Scope note (S5)**: C5 guards **personal** AAD only. Team/history/itemkey AADs (duplicated in `crypto-team.ts`) are NOT covered and are out of scope; reviewers must not read C5 as full-AAD coverage.
- **Acceptance**: test fails if the app personal AAD shape changes without the extension matching; cross-decrypt regression passes.

### C6 — Update existing extension tests to the 3-arg builder
The extension suite currently encrypts fixtures and asserts call-args with the 2-arg builder; C1 breaks them. The Phase-2/3 forbidden-pattern grep (`buildPersonalEntryAAD\([^,]+,[^,)]+\)` across `extension/` **including tests**) is the completeness check — **after C6 it must return zero hits**. Files and their known 2-arg sites (counts are a starting list, not a cap — the grep is authoritative):
  - `extension/src/__tests__/lib/crypto.test.ts` — **all ~8 calls in the `buildPersonalEntryAAD` describe block (~lines 221-248), not only the field-count assertion at 243.** For same-vaultType comparison tests (determinism, userId-differ, entryId-differ) use a consistent `VAULT_TYPE.BLOB`; flip the `aad[3]` assertion from `2` to `3`.
  - `extension/src/__tests__/crypto-encrypt.test.ts` — ~5 sites: 2-arg → 3-arg with the vaultType matching the field round-tripped
  - `extension/src/__tests__/background-login-save.test.ts` — ~8 sites
  - `extension/src/__tests__/background-passkey-provider.test.ts` — ~8 sites
  - `extension/src/__tests__/background.test.ts` (and audit `background-commands.test.ts`, `background/totp-handlers.test.ts`) — `toHaveBeenCalledWith(...)` mock-arg assertions gain the 3rd vaultType arg; the `mockReturnValue` stubs in commands/totp tests need no arg change (they assert no args), but confirm.
- **Invariant (structural, T15)**: a round-trip/fixture assertion that decrypts `encryptedBlob` MUST use a `VAULT_TYPE.BLOB` AAD, and one that decrypts `encryptedOverview` MUST use a `VAULT_TYPE.OVERVIEW` AAD, held in **distinct variables** — never one shared AAD for both fields. A single shared (even if 3-arg) AAD across both decrypts passes vacuously while production is broken. This mirrors the C4 production split into the tests.
- **Anti-vacuous test (required)**: add one extension-suite test (in `crypto.test.ts`) that encrypts a field with `VAULT_TYPE.BLOB` and asserts decrypting it with `VAULT_TYPE.OVERVIEW` **throws** (proves the per-field binding is active, not just present). C5 adds a symmetric throw in the root suite (T16). **Note (T18)**: the existing `crypto-encrypt.test.ts` "wrong-AAD" test varies userId/entryId (not vaultType), so after C6 the cross-field throw coverage lives specifically in `crypto.test.ts` (+ C5) — keep it there; do not let a future refactor orphan it.
- **Note (T12, accepted)**: `background.test.ts` COPY_PASSWORD/AUTOFILL tests use a fixed-stub crypto mock and do not validate the vaultType argument. This is pre-existing weak coverage, not a regression; real per-field vaultType validation lives in the round-trip tests above and the anti-vacuous test. No action beyond the 3rd-arg assertion update.
- **Acceptance**: `cd extension && npm test` green; forbidden-pattern grep returns zero 2-arg hits.

### C7 — Extension-suite golden-vector parity guard (recurrence prevention, reverse direction)
C5 (root suite, under `app-ci`) catches the app-side regression direction. This contract catches the reverse — an **extension-side** AAD change — under `extension-ci`, with **no CI-config coupling** (the rejected alternative of adding extension files to the `app:` filter would trigger the full ~15-min `app-ci` on extension-only changes and would silently miss any future new extension crypto file).
- **File**: `extension/src/__tests__/lib/crypto.test.ts` (extend the existing personal-AAD describe block).
- **Assertions**: `buildPersonalEntryAAD(u, e, VAULT_TYPE.BLOB)` and `(u, e, VAULT_TYPE.OVERVIEW)` each equal a **frozen golden hex** — the *same* canonical vectors asserted in C5's root test. The golden hex is the pinned cross-implementation spec: if the extension builder drifts, this test fails under `extension-ci`; if the app builder drifts, C5 fails under `app-ci`. Both directions covered by each package's native CI trigger.
- **Acceptance**: editing `extension/src/lib/crypto.ts`'s AAD shape fails `extension-ci` via this test.

### Forbidden patterns (Phase 2–3 grep gate)
- pattern: `buildPersonalEntryAAD\([^,]+,[^,)]+\)` across `extension/` **including tests** — reason: a personal AAD call with exactly two arguments means a production site or test fixture was missed (every call must pass a third `vaultType` arg after C1).
- pattern: `buildAADBytes(SCOPE_PERSONAL, 2,` — reason: the old 2-field personal shape must not remain anywhere in the extension.
- pattern (dual-field paths): a single `const aad =` feeding both a blob and an overview `encryptData`/`decryptData` in `login-save.ts` / `passkey-provider.ts` / `index.ts:performAutofillForEntry` — reason: C4 requires distinct blob/overview AADs. Manual review (grep cannot reliably prove the two calls share the variable).

## Testing strategy

- **Extension suite** (`cd extension && npm test`): all existing tests updated per C6 must pass. Add an extension-side unit test that round-trips a personal entry through `buildPersonalEntryAAD` + `encryptData`/`decryptData` for both BLOB and OVERVIEW vaultTypes, asserting the **wrong** vaultType fails to decrypt (proves cross-field replay protection is active).
- **Root suite** (`npx vitest run`): C5 parity + cross-decrypt regression test.
- **Builds**: `npx next build` (root) and `cd extension && npm run build` (`tsc && vite build` — the `tsc` step is the compile-time net that surfaces every un-migrated call site as an error) both succeed.
- **Both suites are mandatory** before completion: root `npx vitest run` does NOT collect `extension/**`, so `cd extension && npm test` must be run separately, plus both builds.
- **Manual verification** (recorded in `…-manual-test.md`): load the built extension, unlock the vault on the dev account that has the `オリコ` CREDIT_CARD entry, open the popup on a web page — confirm the card appears under "Other entries"; then on the Apple checkout form click fill and confirm `performAutofillForEntry` fills the `cc-number`/`cc-exp`/`cc-csc` fields (this exercises the C4 `index.ts:1347` fix, which automated tests cover at the AAD layer but not at the DOM-fill layer).

## Considerations & constraints

- **Out of scope — inline in-page credit-card autofill wiring.** The extension has a credit-card form detector library (`extension/src/content/cc-form-detector-lib.ts`) and fill script (`autofill-cc.js`) that are never initialized, and `GET_MATCHES_FOR_URL` (`index.ts:2193`) returns LOGIN-only. This is a *separate feature* (a missing wiring, not a regression) and is explicitly **not** addressed here. This plan's fix makes credit cards appear in the popup list and fillable via the manual popup button; inline page suggestions remain a follow-up. Reviewers must not raise the absence of inline CC wiring as a finding against this plan.
- **No data migration** (explicit constraint): old extension-written 2-field entries become unreadable by the new extension. Acceptable per the user; the app already cannot read pre-#482 2-field personal entries either.
- **Two test suites / two builds**: the extension suite is not part of root `npx vitest run`. Both must be run before completion.
- The extension's `buildAADBytes` is duplicated in `crypto.ts` and `crypto-team.ts`; de-duplicating it is *not* in scope (team AAD is already correct). The parity test (C5) is the chosen guard rather than a refactor.
- **Accepted risk — server-controlled `aadVersion` downgrade (S3, Minor).** All personal decrypt paths except passkey (`passkey-provider.ts:233` rejects `<1`) fall back to a `undefined` AAD when the server returns `aadVersion: 0`. This is **not exploitable for plaintext exposure**: the stored ciphertext was encrypted *with* the AAD, so AES-GCM auth-tag verification fails on a no-AAD decrypt; forging a no-AAD ciphertext requires the vault key, which a server compromise does not yield. Worst case = decryption failure (UX/DoS); likelihood = low (requires server compromise); cost-to-fix = low but changes legacy `aadVersion:0` read behavior, which is migration-adjacent and explicitly out of scope per the no-migration constraint. We **do not** add a reject-guard (it would be speculative scaffolding for a non-exploitable path). Tracked: `TODO(ext-personal-aad-3field-sync): consider rejecting aadVersion<1 on personal LOGIN decrypt paths once legacy 0-version entries are confirmed absent.`

## User operation scenarios

1. **Popup list on a checkout page** (the reported case): user has one `CREDIT_CARD` entry created via the web app today; opens the extension popup on `secure9.store.apple.com`; before the fix the popup shows only "no matches for host" with no "Other entries"; after the fix the card appears under "Other entries" with a fill button.
2. **Manual fill from popup**: clicking the card's fill button sends `AUTOFILL_CREDIT_CARD`; `autofill-cc.js` fills `autocomplete="cc-number"/"cc-exp"/"cc-csc"` fields (these resolve already; only the decryption was blocking the card from being listed).
3. **Extension creates a login** (`SAVE_LOGIN`) then the **web app** opens that entry: with C4, the app decrypts both blob and overview.
4. **Mixed-age vault**: entries created before #482 (2-field) are not expected to decrypt post-fix (no migration) — verify the extension does not crash, just omits them (existing `catch` at `index.ts:1014`).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Extension `buildPersonalEntryAAD` → 3-field with `VAULT_TYPE`/`VaultType` | locked |
| C2 | All blob-only call sites pass `VAULT_TYPE.BLOB` (index.ts:917/1945/2023, passkey:236/427, login-save:92) | locked |
| C3 | Overview-only call site passes `VAULT_TYPE.OVERVIEW` (index.ts:977 decryptOverviews) | locked |
| C4 | All dual-field paths use distinct blob/overview AADs (login-save:139 create + :215 update, passkey:366 create, index.ts:1347 autofill) | locked |
| C5 | Root-suite app↔extension AAD parity + golden vectors + cross-decrypt regression + structural lock (catches app-side drift under app-ci) | locked |
| C6 | Update existing extension tests/fixtures/mocks to 3-arg; per-field BLOB/OVERVIEW structural rule + anti-vacuous throw test | locked |
| C7 | Extension-suite golden-vector parity guard (catches extension-side drift under extension-ci; no ci.yml coupling) | locked |
