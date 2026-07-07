# Fix: Vault relocks 5 minutes after switching tabs (remove hidden-tab 5-min cap)

## Background / Symptom

- Tenant session idle timeout is set to 480 minutes, yet the vault relocks after only a few minutes and prompts for the master passphrase again.
- The login session itself stays valid (no Google/SAML/email re-login needed). Only the vault relocks.
- Reproduction: switch from the passwd-sso tab to another tab / window, wait 5+ minutes, then return.

## Root Cause

`src/lib/vault/auto-lock-context.tsx` hardcodes a **5-minute lock for hidden tabs** that is independent of the tenant setting.

- `DEFAULT_HIDDEN_TIMEOUT_MS = 5 * MS_PER_MINUTE` (line 9)
- `hiddenLockMsRef = min(autoLockMinutes, 5min)` (line 34) — even a 480-minute setting is capped at 5 minutes while hidden.
- `checkInactivity` locks after 5 minutes measured from `hiddenAtRef` (the moment the tab became hidden) whenever `document.hidden` is true (line 62-72).

`document.hidden` becomes true on "switch tab" or "minimize window", so the vault relocks after 5 minutes even when the user is right in front of the device working in another tab.

## Design Decision (Adopted: A = single idle timeout)

By threat model, what we protect against is "the user has walked away from the device" — best measured by *presence of activity*, not by *which tab is in front*. Using `visibilityState` as a proxy for "away" is coarse and can even invert the risk (foreground-but-abandoned = risky yet allowed 480 min / active-in-another-tab = safe yet locked at 5 min). Major password managers (Bitwarden, 1Password, KeePassXC) use a single idle timeout that does not distinguish visible/hidden.

**Adopted approach A**: lock based solely on a single idle timeout derived from `autoLockMinutes` (tenant setting, default 15 min), regardless of visible/hidden. Remove the hidden-tab 5-minute logic.

### Why the "on close" defense is not lost

Key zeroization on "close tab/browser", "navigate to another URL", and "reload" lives in a **separate layer** — `src/lib/vault/vault-context.tsx` — which this change does not touch:

- `pagehide` handler (vault-context.tsx:283-301) — zeroes `secretKeyRef` / `ecdhPrivateKeyBytesRef` immediately on tab close/navigate.
- `pageshow` bfcache-restore guard INV-C1.6 (vault-context.tsx:310-320) — forces `lock()` if the key is null on frozen-page restore.

These are residual-key protections for process teardown/freeze, not away-detection, so they remain independent of the single-timeout change. Under A, "closing makes the key disappear" behaves identically to today.

## Changes (`src/lib/vault/auto-lock-context.tsx` only)

1. Remove: `DEFAULT_HIDDEN_TIMEOUT_MS` constant, `hiddenAtRef`, `hiddenLockMsRef`.
2. Timeout-update `useEffect` (line 31-36): drop the `hiddenLockMsRef` assignment; update only `autoLockMsRef`.
3. `handleVisibility` (line 53-60): remove the `document.hidden` branch. Call `updateActivity()` only when the tab **returns from hidden to visible**.

   This keeps "hidden → visible return counts as activity" so the timer treats the return moment as recent activity. Without it, the vault could lock instantly on return if the old `lastActivity` already exceeded the threshold, so we keep it.

   ```ts
   const handleVisibility = () => {
     if (!document.hidden) updateActivity();
   };
   ```

4. `checkInactivity` (line 62-79): remove the `document.hidden` branch; use a single check `now - lastActivity > autoLockMs` regardless of visibility.

   ```ts
   const checkInactivity = () => {
     if (Date.now() - lastActivityRef.current > autoLockMsRef.current) {
       lock();
     }
   };
   ```

5. Keep the `visibilitychange` listener registration/cleanup (used for the on-return activity reset).

Note: `setInterval` is throttled in background tabs (browsers coalesce background-tab timers to ~1 min), but the check compares absolute timestamps (`Date.now() - lastActivity`), so the threshold is evaluated correctly once the tab returns to the foreground and the interval fires normally. The single-timeout intent (lock exactly at the configured minutes) is preserved.

## User-facing strings / Docs

- No user-facing string or doc explains the hidden-tab 5-minute behavior (verified by grep). No copy changes needed.
- The settings UI help text (tenant-session-policy-card.tsx) does not mention the hidden branch either, so no change there.

## Tests (`src/lib/vault/auto-lock-context.test.tsx`)

Keep (behavior unchanged):
- "does not call lock before the inactivity threshold"
- "locks when inactivity exceeds the default timeout (15 min)"
- "uses tenant-configured autoLockMinutes when provided"
- "resets the inactivity timer on user activity (mousemove)" / "(keydown)"
- "does not register listeners or run timer when vault is LOCKED"
- "cleans up listeners and timer on unmount" (visibilitychange listener stays, so the assertion remains valid)

Change:
- **Delete** "locks when tab stays hidden longer than the hidden-timeout (5 min default)" and replace with:
  - **New 1**: "does not lock while hidden if below the inactivity threshold" — the core of A. With `document.hidden=true`, advancing 5 min + interval must not call `lock`.
  - **New 2**: "locks while hidden once the inactivity threshold (15 min) is exceeded" — single timeout still applies when hidden.
  - **New 3**: "resets activity on hidden → visible return, so it does not lock immediately on return" — verifies the on-return `updateActivity` in `handleVisibility`.
- Remove the `DEFAULT_HIDDEN_TIMEOUT_MS` constant from the test header.

## Impact / Regression Check

- Team vault: has no independent lock timer; it follows the personal vault's `lock()` (team-vault-core.tsx has no timer). This change only alters the personal vault's lock trigger; no team-side change needed.
- `vaultAutoLockMinutes` DB / API / policy plumbing: unchanged.
- `pagehide` / `pageshow` / bfcache guard: unchanged (different file).

## Verification Steps

1. `npx vitest run src/lib/vault/auto-lock-context.test.tsx` — all pass.
2. `npx vitest run` — full suite passes.
3. `npx next build` — build succeeds.
4. Manual: on the dev server (:3001), unlock the vault → switch to another tab for 6+ minutes → return and confirm it stays unlocked. Leave idle for 15 min (or the tenant-configured minutes) and confirm it locks. Close the tab and reopen to confirm it is LOCKED.

## Commit Policy

- Single commit. `fix:` prefix (bug fix → patch bump).
- State the "why": the hidden-tab 5-minute cap ignored the tenant setting and relocked too early.
