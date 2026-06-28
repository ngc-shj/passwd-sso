# Plan: Extension popup — add "copy username (ID)" button

## Project context

- **Type**: web app (browser extension popup, React/TS)
- **Test infrastructure**: unit + integration + E2E (vitest; extension has its own test setup)
- **Verification environment constraints**: none blocking for this change. The popup
  renders from in-memory `DecryptedEntry[]`; the new behavior is pure client-side
  clipboard write + toast, fully unit-testable with jsdom + a mocked
  `navigator.clipboard`. No paid-tier, no external service, no device attestation.
  All paths `verifiable-local`.

## Objective

Add a per-entry "copy username" button to the extension popup entry rows, alongside
the existing copy-password and copy-TOTP buttons, for `LOGIN` entries. Currently the
popup can only copy password and TOTP.

## Requirements

### Functional
- FR1: Each `LOGIN` entry row in the popup shows a "copy username" button.
- FR2: Clicking it copies the entry's `username` to the clipboard and shows the
  existing success-toast pattern.
- FR3: Clipboard auto-clear behaves identically to copy-password (same
  `copyAndScheduleClear` helper → `clipboardClearSeconds` setting).
- FR4: If the entry has no username, the button is not shown (no empty copy / no
  misleading "copied" toast).
- FR5: i18n: button title + success toast in both `en` and `ja`.

### Non-functional
- NFR1: No new SW message type, no new background handler, no extra network/decrypt
  round-trip — the username is already present in the popup's in-memory
  `DecryptedEntry.username` (decrypted overview; the same value already rendered at
  `MatchList.tsx:240`).
- NFR2: Match the existing button styling (size, dark-mode classes, icon stroke) used
  by copy-password / copy-TOTP for visual consistency (R8).

## Technical approach

### Why client-side only (key design decision)

`COPY_PASSWORD` and `COPY_TOTP` route through the SW because password and TOTP secret
live ONLY in the full `encryptedBlob`, which the popup does not hold — it must fetch +
decrypt on demand. **Username is different**: it is part of `encryptedOverview`
(`title, username, urlHost, tags` per CLAUDE.md), decrypted in `decryptOverviews`
during `FETCH_PASSWORDS`, and is already in `entries[].username` — visibly rendered at
`MatchList.tsx:239-241`. Copying it needs no round-trip.

This is the KISS/YAGNI-correct solution: a new `COPY_USERNAME` message + background
handler would re-fetch and re-decrypt the full blob only to read a field the popup
already has. The keyboard-shortcut path (`CMD_COPY_USERNAME`, `background/index.ts:929`)
fetches the full blob because the SW has no popup entries in memory and reuses the
password code path — that constraint does NOT apply to the popup.

Username from overview vs. blob: the popup copies `e.username` sourced from
`encryptedOverview` (set in `decryptOverviews`, `background/index.ts:1060-1064`, and
`decryptTeamOverviews` for team entries), while the keyboard shortcut copies
`blob.username` from `encryptedBlob`. These are two separately-encrypted copies written
together at save time — normally byte-identical, but NOT guaranteed equal by a schema
constraint (a save-path bug or out-of-band mutation could diverge them). This is an
**intentional, accepted** asymmetry: the popup copies exactly the subtitle it already
displays (WYSIWYG — you copy what you see), which is the correct product stance for a
button next to the visible username. No fix needed; recorded so the divergence source
is explicit rather than assumed-equal. (Functionality review F1.)

### Files to change
1. `extension/src/popup/components/MatchList.tsx`
   - Add `handleCopyUsername(e: DecryptedEntry)` (client-side; no `sendMessage`).
   - Render a copy-username button in the `LOGIN` action-button group, gated on
     `e.username` (FR4), placed before the copy-password button.
2. `extension/src/messages/en.json` — add `popup.copyUsername`, `popup.usernameCopied`.
3. `extension/src/messages/ja.json` — same keys (ja: 保管庫-rule compliant; no katakana
   ボルト; "username" → ユーザー名).

Note: `commands.copyUsername` already exists (keyboard-command label) — do NOT reuse it
for the popup; the popup needs a `popup.*`-namespaced key consistent with
`popup.copy` / `popup.copyTotp`.

## Contracts

### C1 — `handleCopyUsername` (client-side handler in MatchList)
- **Signature**: `const handleCopyUsername = async (e: DecryptedEntry): Promise<void>`
- **Body behavior**:
  - If `!e.username` → return early (defensive; button is also gated, FR4).
  - `try { await copyAndScheduleClear(e.username, t("popup.usernameCopied")); }`
    `catch { setToast({ message: humanizeError("CLIPBOARD_FAILED"), type: "error" }); }`
  - Mirrors `handleCopy` (MatchList.tsx:63-71) minus the `sendMessage` round-trip and
    the `res.error` branch (there is no remote call that can fail).
- **Invariants** (app-enforced):
  - I1: No `sendMessage`/`COPY_USERNAME` introduced (NFR1). The handler is purely local.
  - I2: Uses the shared `copyAndScheduleClear` helper — does NOT reimplement clipboard
    write or auto-clear scheduling (R1).
- **Acceptance**:
  - Clicking the button on a LOGIN entry with a username copies `e.username` and shows
    the `popup.usernameCopied` success toast.
  - Auto-clear fires after `clipboardClearSeconds` (inherited from helper; same as
    password — covered by helper, not re-tested per-handler).
  - Clipboard-write rejection → error toast `CLIPBOARD_FAILED`.

### C2 — username button rendering
- **Location**: inside the `e.entryType === EXT_ENTRY_TYPE.LOGIN && (<> ... </>)` group
  at MatchList.tsx:218-235, as the FIRST button in that group (order:
  username → TOTP → password, left to right).
- **Gate**: render only when `e.username` is truthy (FR4).
- **Markup**: a `<button>` with `onClick={() => handleCopyUsername(e)}`,
  `title={t("popup.copyUsername")}`, and the SAME className string as the existing
  copy-password button (MatchList.tsx:230) for visual parity (R8). Icon: a distinct
  glyph from password's clipboard icon — use a "user" outline svg (e.g. head+shoulders)
  at the same `w-3.5 h-3.5` / stroke settings so it reads as username, not password.
- **Forbidden patterns**:
  - `pattern: COPY_USERNAME — reason: no new SW message type; username is client-side (NFR1/I1)`
  - `pattern: navigator\.clipboard\.writeText\(\s*e\.username — reason: must go through copyAndScheduleClear, not a raw write (I2)`

### C3 — i18n keys
- Add to BOTH `en.json` and `ja.json` under the `popup` object, near `copy`/`copyTotp`:
  - `popup.copyUsername`:
    - en: `"Copy username"`
    - ja: `"ユーザー名をコピー"`
  - `popup.usernameCopied`:
    - en: `"Username copied"`
    - ja: `"ユーザー名をコピーしました"`
- **Invariant** (app-enforced): every `t("popup.X")` used by the new code resolves in
  both locales (the extension `t()` falls back to `en` then the raw key on miss — a
  missing ja key would silently show English; both must be present).
- **Acceptance**: `t("popup.copyUsername")` and `t("popup.usernameCopied")` return
  locale-correct strings in en and ja.

### Consumer-flow walkthrough
The only consumer of these contracts is the popup itself (MatchList render + click
handler). There is no API response shape, persisted state, or cross-module payload —
C1's input is the already-in-memory `DecryptedEntry`, C1's output is a clipboard side
effect + toast. No downstream consumer reads a produced shape. (Walkthrough obligation
satisfied trivially: no external consumer exists.)

## Testing strategy

Test file: `extension/src/__tests__/popup/MatchList.test.tsx`. Mirror the existing
"copies password on button click" test (lines 68-96) — but DROP its `COPY_PASSWORD`
`mockSendMessage` queue entry, since the new handler makes no `sendMessage` call.
Buttons expose their `title` as the accessible role-name and `t()` is NOT mocked (it
resolves the real `en.json`), so select via the exact accessible name.

- Unit test: render a LOGIN entry with a username, click the copy-username button
  selected by `{ name: "Copy username" }` (exact string, T2), assert
  `navigator.clipboard.writeText` called with the username and the success toast shown.
  `navigator.clipboard` and `getSettings` are already mocked in the file's `beforeEach`.
  Do NOT assert on `mockSendMessage` (would be vacuous — no call is made).
- Unit test (FR4): render a LOGIN entry with empty username so the entry IS visible
  (matching `tabUrl`, or via search query), then assert the "Copy username" button is
  absent while the row/title IS present — row-scoped via `title.closest("li")` +
  `within(row)` to avoid a vacuous pass where the entry was simply filtered out (T3).
- i18n: NO dedicated test. The existing parity guard
  `extension/src/__tests__/lib/i18n.test.ts:55-59` asserts
  `flattenKeys(ja) === flattenKeys(en)` over the whole tree, so adding a key to only one
  locale fails automatically. Just add both keys to both files (T1).
- Reuse existing clipboard-auto-clear coverage — do NOT duplicate timer tests for the
  new handler since it shares `copyAndScheduleClear`.

## Considerations & constraints

### Scope contract
- **SC1 — cross-origin (URL-mismatch) autofill with a warning**: explicitly OUT of
  scope. The autofill host-gate (`canFill()` in MatchList) is a phishing defense; the
  user decided NOT to weaken it for this change. A user who needs a mismatched
  credential can "view & copy" instead. Tracked as a possible future, separate
  plan/PR — not this one.
- **SC2 — search behavior changes**: OUT of scope. The popup already supports
  full-entry-set text search (`MatchList.tsx:163-177`); the user confirmed current
  search behavior is acceptable. No change.

### Risks
- Copying the username is strictly less sensitive than the already-shipped
  copy-password; same clipboard-clear hygiene applies. No new secret-exposure surface
  (username is already decrypted in memory and rendered at MatchList.tsx:240).
- Icon ambiguity: must visually distinguish username-copy from password-copy (R8) —
  addressed by using a distinct user-glyph icon (C2).
- **Pre-existing (S1), NOT fixed here**: `copyAndScheduleClear` schedules the
  clipboard clear in the popup context, so closing the popup before the timer cancels
  the clear (the keyboard path uses the SW's persistent `scheduleClipboardClear`
  instead). This limitation is shared identically by the existing copy-password and
  copy-TOTP buttons; copy-username does not make it worse. Out of scope for this PR —
  if popup-survivable clear is ever wanted, route all three through the SW. Recorded as
  a conscious acceptance, not silently dropped.

## User operation scenarios

1. User on github.com, popup shows the matching GitHub login → clicks the user-icon
   button → username copied, toast "Username copied", clipboard auto-clears later.
2. LOGIN entry imported without a username (password-only) → no copy-username button
   shown; copy-password/TOTP still present.
3. ja-locale browser → button tooltip "ユーザー名をコピー", toast
   "ユーザー名をコピーしました".
4. Team LOGIN entry → same button; `e.username` is populated from the team overview
   decrypt, copied identically (no teamId-specific path needed since no round-trip).

## Go/No-Go Gate

| ID  | Subject                                         | Status |
|-----|-------------------------------------------------|--------|
| C1  | `handleCopyUsername` client-side handler        | locked |
| C2  | username button rendering + gate + styling      | locked |
| C3  | i18n keys (popup.copyUsername / usernameCopied) | locked |
| SC1 | cross-origin autofill — out of scope            | locked |
| SC2 | search behavior — out of scope, unchanged       | locked |
