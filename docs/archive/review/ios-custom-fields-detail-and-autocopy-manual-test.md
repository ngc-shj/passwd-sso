# Manual Test Artifact: iOS Custom Fields — Detail View + AutoFill Copy

Branch: `fix/ios-custom-fields-detail-and-autocopy`
Plan: `ios-custom-fields-detail-and-autocopy-plan.md`
Date: 2026-07-01

## Pre-conditions

1. A real device or simulator running iOS 17+.
2. The app is signed in to a tenant with at least one LOGIN entry that carries
   custom fields in its encrypted blob (create one via the web app, type
   "Login", add "Additional fields" of each type before saving).
3. AutoFill is enabled for passwd-sso in Settings → General → AutoFill &
   Passwords → passwd-sso.
4. Settings → Auto-copy TOTP after fill: configured as needed per test case.
5. Settings → Auto-copy custom field after fill: configured as needed per test case.
   (Setting visible in the app settings screen after this PR ships.)

---

## Section 1 — Detail View (host app)

### Display checks

| # | Scenario | Expected | Actual | Pass/Fail |
|---|----------|----------|--------|-----------|
| D1 | Open a LOGIN entry with `text` custom field "Recovery" = "abc123" | Section header "Recovery" shows, value "abc123" shown in plain text, copy button visible | | |
| D2 | Tap copy button on "Recovery" text field | Toast "Copied!" appears, haptic fires; pasteboard holds "abc123" | | |
| D3 | Open a LOGIN entry with `hidden` custom field "API Key" = "tok_abc" | Section header "API Key" shows, value is masked (•••), eye + copy button visible | | |
| D4 | Tap eye on "API Key" masked field | Value reveals; tapping eye again re-masks. Other hidden fields (if any) remain masked | | |
| D5 | Tap copy on "API Key" masked field | Pasteboard holds "tok_abc"; toast + haptic fire | | |
| D6 | Open entry with `url` custom field "Portal" = "https://portal.example.com" | Section shows URL as tappable link (tinted); copy button visible | | |
| D7 | Tap the portal URL link | System browser (or in-app Safari) opens to https://portal.example.com | | |
| D8 | Open entry with `url` custom field whose value is NOT a safe URL (e.g. "not-a-url") | Value shown as plain non-tappable text; copy button still present | | |
| D9 | Open entry with `boolean` custom field "2FA Enabled" = "true" | Section shows "Yes"; NO copy button visible | | |
| D10 | Open entry with `boolean` custom field "Newsletter" = "false" | Section shows "No"; NO copy button visible | | |
| D11 | Open entry with `date` custom field "Expires" = "2026-07-01" | Value shown in locale-formatted abbreviated date (e.g. "Jul 1, 2026" for en, "2026年7月1日" for ja); NOT "2026-07-01" | | |
| D12 | Open entry with `monthYear` custom field "Card Exp" = "2026-07" | Raw value "2026-07" shown with copy button (monthYear → plain passthrough) | | |
| D13 | Open entry with `text` custom field | Copy button copies the raw string, not a formatted version | | |
| D14 | Open a LOGIN entry with NO custom fields | No extra sections appear after "One-Time Code"; no empty "Custom Fields" header | | |
| D15 | Open a CREDIT_CARD or SSH_KEY entry that has no customFields | Detail renders normally; no custom field sections shown | | |

---

## Section 2 — Adversarial Clipboard (AutoFill extension wiring)

These three rows exercise the call-site wiring that unit tests structurally
cannot reach (VC2): the credential-provider's `autoCopyAfterFill` refactor.

### Test A — hidden exclusion: single hidden field NEVER auto-copies

**Pre-condition**: Entry has exactly 1 custom field of type `hidden`. Auto-copy
custom field opt-in: ON.

**Steps**:
1. Open a native app that has a login form (e.g. Safari → any site).
2. Tap the password field → AutoFill picker appears.
3. Select the entry with the single hidden field.
4. Password fills into the form.

**Expected**: Clipboard does NOT contain the hidden field's value after fill.
The fill completes normally. (The user must open the host app and copy from
the masked row manually.)

**Rollback**: If this fails, the `guard field.kind != .hidden` in
`CustomFieldAutoCopy.swift:customFieldToCopy` is missing or bypassed. Check
that `customFieldToCopy` returns nil for hidden and that the call site in
`autoCopyAfterFill` passes the correct `autoCopy` flag.

| Result | Actual clipboard content | Pass/Fail |
|--------|--------------------------|-----------|
| | | |

---

### Test B — TOTP arbitration: TOTP wins, custom field skipped

**Pre-condition**: Entry has exactly 1 custom field of type `text` AND a TOTP
secret. Auto-copy TOTP: ON. Auto-copy custom field: ON.

**Steps**:
1. Trigger AutoFill for this entry in a native app form.
2. After fill completes, paste from clipboard into a text field.

**Expected**: Clipboard holds the current TOTP code (6- or 8-digit number),
NOT the custom field value. The TOTP code clears after `clipboardClearSeconds`.

**Rollback**: If clipboard holds the custom field value instead, `totpWillCopy`
is not being passed correctly — the call site computes `totpCode` once and
passes `totpWillCopy: totpCode != nil`, which should be true when TOTP copied.

| Result | Clipboard content (TOTP or custom?) | Pass/Fail |
|--------|--------------------------------------|-----------|
| | | |

---

### Test C — custom field copies and self-clears when no TOTP

**Pre-condition**: Entry has exactly 1 custom field of type `text` (e.g.
"Recovery code" = "BACKUP-9988"), NO TOTP secret. Auto-copy custom field: ON.
`clipboardClearSeconds` set to 10 seconds (fastest observable).

**Steps**:
1. Trigger AutoFill for this entry.
2. Immediately after fill, paste into a text field — should see "BACKUP-9988".
3. Wait 10+ seconds.
4. Paste again.

**Expected** (step 2): Clipboard holds "BACKUP-9988".
**Expected** (step 4): Clipboard is empty (auto-cleared by SecureClipboard).

**Rollback**: If clipboard never holds the custom field value, check:
- `settings.autoCopyCustomField` is true (the setting was opted in).
- `totpWillCopy` is false (entry has no TOTP → `totpToCopy` returns nil).
- The field kind is not `.hidden` (it's `text`).

If auto-clear does not fire, check `SecureClipboard.copy(_:clearAfter:)` with
the stored `clipboardClearSeconds` value.

| Result | Step 2 clipboard | Step 4 clipboard | Pass/Fail |
|--------|-----------------|------------------|-----------|
| | | | |

---

## Rollback (all tests)

1. Flip `autoCopyCustomField` to OFF in app settings — auto-copy stops immediately.
2. The detail-view display is read-only and carries no new persistence; reverting
   the branch reverts the UI with no data migration needed.
3. No server-side changes were made; the blob format is unchanged.
