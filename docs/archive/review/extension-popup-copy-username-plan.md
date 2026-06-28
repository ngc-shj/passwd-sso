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
- **SC1 — cross-origin (URL-mismatch) autofill with a warning**: NOW IN SCOPE (was
  deferred; user decided to add it, mirroring the iOS AutoFill extension). Implemented
  as a confirmation sheet, NOT an unconditional weakening of the host-gate. See the
  "Cross-origin autofill confirmation (C4–C8)" section below. The phishing defense is
  preserved as an explicit, informed user decision rather than removed.
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

---

# Cross-origin autofill confirmation (C4–C8)

## Objective

Allow autofilling a LOGIN entry whose stored host does NOT match the current tab,
gated behind an explicit in-popup confirmation sheet — mirroring the iOS AutoFill
extension's host-mismatch warning. Today the popup hides the Fill button for
mismatched LOGIN entries (`canFill()` returns false), so the user has no way to fill a
credential the URL of which has drifted (legit case) — and no phishing safeguard exists
because the affordance simply isn't there.

## iOS reference (the behavior we mirror)

`ios/PasswdSSOAutofillExtension/Views/CredentialPickerView.swift` shows a
`hostMismatchConfirmationSheet` (lines 204-242) when a non-matched entry is selected:
warning triangle + headline + "saved for: <stored host>" + "This site is: <current
host>" + "Fill Anyway" / "Cancel". Strings live in `Localizable.xcstrings`. TOTP fill
has NO mismatch confirmation (`OneTimeCodePickerView`) — we mirror that: only autofill
is gated, copy/TOTP are not. (The iOS app-side / bundle-ID confirmation is iOS-26-only
and has no browser-extension equivalent — NOT ported.)

## Requirements

- FR6: Mismatched LOGIN entries show a Fill button (currently hidden).
- FR7: Clicking Fill on a mismatched LOGIN entry opens a confirmation sheet BEFORE any
  fill happens; it does NOT call the SW autofill until the user confirms.
- FR8: The sheet shows: a warning icon, a headline, the entry's stored host, and the
  current tab host, plus "Fill anyway" / "Cancel" actions.
- FR9: "Fill anyway" proceeds with the existing `handleFill` flow; "Cancel" closes the
  sheet and fills nothing.
- FR10: MATCHED LOGIN entries fill directly with NO confirmation (unchanged). TOTP and
  all copy actions are NEVER gated by this sheet (mirrors iOS).
- FR11: i18n for all new strings in en + ja, wording aligned with the iOS strings.
- FR12: The mismatch decision is made in the Fill click handler (single chokepoint), so
  it fires regardless of which section the row was rendered in (matched list cannot
  contain a mismatch; "other entries" and search both can).

## Contracts

### C4 — `entryMatchesTab` reuse + a single Fill chokepoint
- The existing `entryMatchesTab(e)` (MatchList.tsx:191-194) is the source of truth for
  "does this entry's stored host match the current tab". REUSE it — do NOT add a second
  host-comparison (R1).
- **F3 guard alignment**: `entryMatchesTab` currently calls `isHostMatch(e.urlHost, ...)`
  WITHOUT the `e.urlHost &&` guard the `matched`-list filter has (MatchList.tsx:150). Add
  the guard so the chokepoint decision is provably identical to matched-list membership
  and does not silently depend on `isHostMatch("")` returning false:
  `tabHost !== null && ((e.urlHost ? isHostMatch(e.urlHost, tabHost) : false) || (e.additionalUrlHosts ?? []).some((h) => isHostMatch(h, tabHost)))`.
- **F2 host-less LOGIN**: an entry with NO `urlHost` AND no `additionalUrlHosts` has no
  stored host to assert a mismatch against — showing a sheet with an empty "saved for"
  line is confusing. Treat it as "no mismatch" → fill directly, no sheet. Add a
  `hasStoredHost(e)` helper = `Boolean(e.urlHost) || (e.additionalUrlHosts?.length ?? 0) > 0`.
- **Signature change**: introduce `requestFill(e: DecryptedEntry): void` that:
  - if `e.entryType === LOGIN && hasStoredHost(e) && !entryMatchesTab(e)` → set
    `pendingFill = e` (opens sheet), return — do NOT call the SW.
  - else → call the existing `handleFill(e.id, e.entryType, e.teamId)` directly.
    (host-less LOGIN, matched LOGIN, and all CREDIT_CARD/IDENTITY take this branch.)
- The Fill button `onClick` calls `requestFill(e)` instead of `handleFill(...)`.
- **Invariant (app-enforced)** I3: the SW autofill message
  (`AUTOFILL`/`AUTOFILL_CREDIT_CARD`/`AUTOFILL_IDENTITY`) is NEVER sent for a mismatched
  LOGIN *that has a stored host* without passing through the confirm sheet. The only
  call site of `handleFill` for such an entry is the sheet's confirm action.

### C5 — `canFill` widened to render the Fill button for mismatched LOGIN
- **Current** (MatchList.tsx:196-199): `canFill` is false for mismatched LOGIN, hiding
  the button. **Change**: the Fill BUTTON should render for any autofillable LOGIN on a
  web page (matched or not); the match/mismatch distinction moves into `requestFill`
  (C4), not button visibility.
- Concretely: split the concept — keep a `canFill(e)` that means "fill directly without
  confirmation" (matched), and add `canShowFill(e)` = autofillable && `tabHost !== null`
  (renders the button). The button renders when `canShowFill(e)`; `requestFill` decides
  direct-fill vs. confirm.
- **CREDIT_CARD / IDENTITY**: unchanged behavior — they have no host gate today
  (`canFill` already allows them on any web page), so they continue to fill directly, no
  confirmation. The sheet is LOGIN-only (FR10).
- **Forbidden pattern**:
  `pattern: handleFill\(e\.id, e\.entryType — reason: Fill button must call requestFill(e), not handleFill directly, so the mismatch gate (C4/I3) cannot be bypassed`

### C6 — confirmation sheet state + rendering
- **State**: `const [pendingFill, setPendingFill] = useState<DecryptedEntry | null>(null)`.
- **Render**: when `pendingFill` is non-null, render an in-popup sheet (overlay or
  bottom panel within the 360px popup; NOT `window.confirm`). Contents:
  - warning triangle icon (amber, consistent with the existing `isInsecurePage` warning
    styling at MatchList.tsx:254-258).
  - headline `t("popup.fillMismatchTitle")`.
  - stored host line: `t("popup.fillMismatchSavedFor", { title, host })` where host is
    the entry's own stored host (NOT `displayHost`, which returns the matched host — for
    a mismatch use `e.urlHost || e.additionalUrlHosts?.[0] || ""`).
  - current site line: `t("popup.fillMismatchCurrentSite", { host: tabHost })`.
  - confirm button `t("popup.fillAnyway")` → fire-and-forget the fill, then clear
    state SYNCHRONOUSLY so the sheet is gone on both success and failure regardless of
    await semantics (F1): `void handleFill(pendingFill.id, pendingFill.entryType, pendingFill.teamId); setPendingFill(null);`.
    (On success `handleFill` calls `window.close()`; on failure it leaves the popup open
    with an error toast — in both cases the sheet must already be dismissed.)
  - cancel button `t("popup.cancel")` → `setPendingFill(null)`, fills nothing.
- **Invariant (app-enforced)** I4: confirm action clears `pendingFill` and is the sole
  path that calls `handleFill` for the pending mismatched entry; cancel clears state and
  calls nothing.
- **Acceptance**:
  - Click Fill on a mismatched LOGIN → sheet appears, no SW message sent yet.
  - Confirm → `sendMessage({type:"AUTOFILL", ...})` fires once with the entry id; sheet
    closes.
  - Cancel → no `sendMessage` autofill; sheet closes.
  - Matched LOGIN Fill → no sheet, fills directly (regression guard).

### C7 — REMOVED (default-view display of mismatched LOGIN not implemented)
- An earlier revision proposed showing mismatched LOGIN entries in the "Other entries"
  default-view section. This was NOT requested by the user and floods large vaults, so
  it was reverted. The "Other entries" section keeps its original behavior: non-LOGIN
  entries (cards, identity) only.
- Mismatched LOGIN entries remain reachable via SEARCH (the existing full-set search),
  which is unchanged pre-existing behavior. Fills initiated from search results pass
  through the C4 chokepoint and the confirmation sheet exactly the same way. No code
  change for this contract — the `unmatched` filter is left as it was originally.

### C8 — i18n keys (en + ja, aligned with iOS wording)
Add under `popup` in BOTH locales:
| key | en | ja |
|-----|----|----|
| `popup.fillMismatchTitle` | `Fill on a different site?` | `別のサイトに入力しますか？` |
| `popup.fillMismatchSavedFor` | `{title} is saved for: {host}` | `{title} の保存先: {host}` |
| `popup.fillMismatchCurrentSite` | `This site is: {host}` | `このサイト: {host}` |
| `popup.fillAnyway` | `Fill anyway` | `このまま入力` |
| `popup.cancel` | `Cancel` | `キャンセル` |
- ja wording matches iOS `Localizable.xcstrings` ("このまま入力" / "別のサイトに入力しますか？")
  for cross-platform consistency.
- Check `popup.cancel` does not already exist before adding (grep); reuse if present.
- i18n parity test (`i18n.test.ts:55-59`) auto-covers presence in both locales.

### Consumer-flow walkthrough (C4–C8)
Only consumer is the popup itself. `pendingFill` state is read solely by the sheet
render + confirm/cancel handlers in the same component. The confirm action's payload to
the SW is the EXISTING `AUTOFILL` message shape (entryId/tabId/teamId) — no new message
type, no payload-shape change, so no SW-side or cross-module consumer is affected. The
SW already fills whatever entryId it receives (it does not re-check host —
`performAutofillForEntry`), so the gate is entirely client-side by design; this is
acceptable because the popup is the trusted UI and the gate is a UX safeguard, not a
trust boundary (a compromised popup could already fill anything). Walkthrough satisfied.

## Testing strategy (C4–C8)

Same test file `extension/src/__tests__/popup/MatchList.test.tsx`.
- Mismatched LOGIN: render an entry whose `urlHost` differs from `tabUrl`'s host and
  reach it via the search box (mismatched LOGINs are not in the default view); click its
  Fill button; assert the sheet appears (find by `t("popup.fillMismatchTitle")` text)
  and that `mockSendMessage` was NOT called with an `AUTOFILL` type yet.
- Confirm: click "Fill anyway"; assert `mockSendMessage` called once with
  `{ type: "AUTOFILL", entryId: <id>, ... }` and the sheet is gone.
- Cancel: click "Cancel"; assert no `AUTOFILL` sendMessage and sheet gone.
- Matched LOGIN regression: render a matched entry, click Fill; assert NO sheet and
  `AUTOFILL` sent directly (guards FR10 / I3 against over-triggering).
- TOTP not gated: matched/mismatched, clicking TOTP never opens the sheet.
- i18n: no dedicated test (parity guard covers presence).
- Select Fill buttons by exact accessible name `t("popup.fill")` = "Fill"; scope to the
  target row with `title.closest("li")` + `within(row)` to avoid cross-row ambiguity now
  that multiple Fill buttons can render.

## Risks (C4–C8)

- **Phishing-defense framing**: the gate is a UX safeguard inside the trusted popup, not
  a server-enforced trust boundary. The SW does not re-validate host (it never did). A
  user who clicks "Fill anyway" on a phishing site can still be tricked — the sheet's
  job is to make the mismatch impossible to miss, matching the desktop-password-manager
  norm and iOS. Acceptable and consistent with the platform.
- **Over-triggering** (annoyance): if `entryMatchesTab` is too strict, legit matches
  could prompt. Mitigation: reuse the SAME `entryMatchesTab` already used for the matched
  list, so the sheet fires exactly when the entry is NOT in the matched set — no new
  matching logic, no drift (R1/R3).
- **List density**: an earlier revision listed all mismatched LOGINs in the default view
  ("Other entries"), which floods large vaults. Reverted (C7 REMOVED). Mismatched LOGINs
  are reached via search only, matching the iOS baseline.

## User operation scenarios (C4–C8)

1. User on `evil-phish.com`, has a `mybank.com` login. Searches for it (mismatched
   LOGINs surface via search). Clicks Fill → sheet: "Fill on a different site? — mybank
   login is saved for: mybank.com / This site is: evil-phish.com". User cancels. No fill.
2. User on `accounts.google.com` legitimately, has a login stored as `google.com`
   (matches via subdomain) → fills directly, no sheet (matched).
3. Company moved `app.oldcorp.com` → `app.newcorp.com`; user on the new domain searches
   for the old entry, clicks Fill → sheet, confirms "Fill anyway" → fills. Legit drift
   case the old hard-gate blocked entirely.
4. ja locale → "別のサイトに入力しますか？" / "このまま入力" / "キャンセル".

## Go/No-Go Gate

| ID  | Subject                                            | Status |
|-----|----------------------------------------------------|--------|
| C1  | `handleCopyUsername` client-side handler           | locked |
| C2  | username button rendering + gate + styling         | locked |
| C3  | i18n keys (popup.copyUsername / usernameCopied)    | locked |
| C4  | `requestFill` chokepoint + reuse `entryMatchesTab` | locked |
| C5  | `canShowFill` widens Fill button for mismatch      | locked |
| C6  | confirmation sheet state + render + confirm/cancel | locked |
| C7  | REMOVED — default-view display reverted (search only) | n/a  |
| C8  | i18n keys for the mismatch sheet (en + ja)         | locked |
| SC1 | cross-origin autofill — NOW IN SCOPE (C4–C8)       | locked |
| SC2 | search behavior — out of scope, unchanged          | locked |
