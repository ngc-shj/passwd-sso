# Manual Test: iOS Entry URL Tap + Copy Feedback

Covers the user-facing behaviors that automated tests cannot exercise (browser
launch, haptic, toast timing, auto-lock activity). The pure URL-safety predicate
is covered by `PasswdSSOTests/SafeURLTests.swift` (excluded here per the
automation-dedup filter).

## Pre-conditions

- App installed on a **real device** (haptics do not fire in the simulator — VC2).
- Vault unlocked; at least one LOGIN entry exists.
- Prepare three LOGIN entries (or edit one between steps):
  - A: `url = https://github.com`
  - B: `url = github.com` (no scheme)
  - C: `url = javascript:alert(1)` (created/edited via the web app, since iOS edit is login-shaped)

## Steps & Expected results

### FR1 — Safe URL opens the browser
1. Open entry A → tap the URL value (`https://github.com`).
   - **Expected**: the system browser (or the GitHub app if installed — Universal Link, per SC-univlink) opens github.com.

### FR2 — Non-safe / schemeless URL is not a link
2. Open entry B (`github.com`).
   - **Expected**: the URL renders as plain text (not tinted/tappable); tapping it does nothing.
   - Tap the copy button on the URL row → clipboard receives `github.com`.
3. Open entry C (`javascript:alert(1)`).
   - **Expected**: plain text, NOT tappable. Nothing executes.

### FR3 — Copy feedback (toast + haptic)
4. On any entry, tap any copy button (username, URL, or password).
   - **Expected**: a success haptic fires AND a "Copied!" capsule appears near the bottom of the screen.
   - **Expected**: the toast shows the constant text "Copied!" — never the copied value.

### FR4 — Toast auto-dismiss
5. After step 4, wait ~1.5 s without interacting.
   - **Expected**: the toast fades/slides away on its own; it never blocks taps on the rows beneath it.

### I5b — URL tap records auto-lock activity
6. Set auto-lock to a short interval (e.g. 1 min) in Settings. Open entry A. Wait until just before the interval, then tap the URL.
   - **Expected**: opening the URL resets the auto-lock timer (the vault does NOT lock immediately after returning to the app).

### S6 — Toast respects screen-recording redaction
7. Start a screen recording (Control Center), open an entry, tap copy.
   - **Expected**: the `ScreenRecordingOverlay` covers the content and the "Copied!" toast does NOT appear in the recording.

## Rollback

Revert the branch; no migration, no persisted-state change. The change is purely
view-layer plus one pure helper (`SafeURL`). No operator action required.
