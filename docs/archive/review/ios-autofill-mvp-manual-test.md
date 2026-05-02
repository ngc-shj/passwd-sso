# iOS AutoFill MVP — Manual Test Plan

Tier-2 manual test artifact for the iOS host app + AutoFill credential provider extension. Run before MVP sign-off. All scenarios MUST pass on a real iPhone (not just Simulator) before tagging the release.

## Pre-conditions

### Test tenant seed

A deterministic test tenant is needed so manual results are reproducible across reviewers (per T25). Run the seed script before the first scenario:

```bash
# In the parent passwd-sso repo
npm run db:seed:ios-mvp
```

The seed creates:

- One personal-vault user (`ios-mvp-tester@example.com`)
- ≥ 1 personal entry encrypted under a known fixture passphrase (passphrase: `test-passphrase-do-not-use-in-prod`)
- ≥ 1 team-A entry (team `ios-mvp-team-a`)
- ≥ 1 team-B entry (team `ios-mvp-team-b` — for cross-team isolation scenarios)
- Fixture entries each include a TOTP secret (Base32 RFC 6238 vector for verifiability)

### Device requirements

- iPhone (iOS 17.0+) with Face ID OR Touch ID enrolled. **AT LEAST ONE biometric method must be enrolled** — without biometry, the bridge-key Keychain ACL (`biometryCurrentSet` only) refuses access entirely.
- iPhone Simulator alternative (limited): some scenarios DO work in Simulator (URL host match, lock-state predicate). Biometric scenarios DO NOT — Simulator emulates Face ID via Hardware menu, but the Keychain ACL gate behaves differently.

### Test domains list

- Safari fill: `https://github.com/login`, `https://app.example.com/sign-in` (any sign-in form on a non-AASA-claimed domain works for URL-host-match testing)
- App-side fill: any iOS app with Associated Domains pointing at a fixture host (we use `app://com.passwd-sso.test-target` if/when we ship a fixture target)
- Adversarial: `https://gìthub.com/login` (homograph) and `https://github.com.attacker.example/login` (subdomain confusion)

### Server URL

- Use a self-hosted dev server (e.g. `https://passwd-sso.local:3000`) with the AASA file served at `/.well-known/apple-app-site-association` (per `ios/README.md`).
- TLS certificate must be trusted by the device. For dev, install the dev CA into the iPhone's `Settings > General > VPN & Device Management > Configuration Profiles`.

## Standard scenarios (10 user operations)

Each scenario follows the same shape: pre-step → action → expected result → rollback.

### 1. Initial install + server URL setup

- **Pre-condition**: clean install (no prior `bridge_key_blob` in the Keychain access group)
- **Steps**:
  1. Open `passwd-sso` from the Home Screen.
  2. Enter the test server URL and tap Continue.
  3. Tap "Sign in with passwd-sso".
- **Expected**:
  - Server URL field accepts only `https://...` (or `http://localhost*`).
  - The app probes `/.well-known/apple-app-site-association` and `/api/health/live` before accepting.
  - The "Sign in" sheet opens an `ASWebAuthenticationSession` with `prefersEphemeralWebBrowserSession=true` (cookies isolated from Safari).
  - After sign-in, the app receives a Universal Link callback at `/api/mobile/authorize/redirect?code=…&state=…` and exchanges for tokens.
  - The vault unlock screen displays the server URL prominently.
- **Rollback**: delete the app to clear all per-app Keychain items and the App Group container.

### 2. Vault unlock

- **Pre-condition**: signed in (scenario 1 complete)
- **Steps**:
  1. Enter the fixture passphrase on the vault unlock screen.
  2. Tap Unlock.
- **Expected**:
  - Server-side `/api/vault/unlock/data` returns the encrypted secret key + KDF params.
  - Client-side PBKDF2 (600k iterations) derives the wrapping key.
  - Vault key is generated and wrapped under a fresh `bridge_key`.
  - The vault list screen appears with the fixture entries decoded.
- **Rollback**: lock the vault (manual action below).

### 3. Personal AutoFill in Safari

- **Pre-condition**: vault unlocked
- **Steps**:
  1. Open Safari and navigate to a fixture URL (e.g. `https://github.com/login`).
  2. Tap the username field; tap the AutoFill keyboard suggestion for the matching personal entry.
- **Expected**:
  - Face ID / Touch ID prompt appears EXACTLY ONCE per fill (`touchIDAuthenticationAllowableReuseDuration = 0`).
  - Username + password fill correctly.
  - The credential picker shows the matching entry sorted ABOVE non-matching entries (URL-host match).
  - No network call from the AutoFill extension during the fill (verify via Charles/proxy if available).

### 4. TOTP AutoFill (iOS 17+)

- **Pre-condition**: vault unlocked, fixture entry has a TOTP secret
- **Steps**:
  1. Navigate to a sign-in form with a one-time-code field (`textContentType=.oneTimeCode`).
  2. Tap the field; tap the AutoFill suggestion.
- **Expected**:
  - Face ID / Touch ID prompt fires.
  - The current 6-digit TOTP code is computed (verify against `oathtool` for the fixture secret) and filled.
  - The TOTP secret never reaches the pasteboard.

### 5. Team-vault entry AutoFill

- **Pre-condition**: vault unlocked; user is a member of `ios-mvp-team-a`
- **Steps**:
  1. Navigate to a fixture URL associated with a team entry.
  2. Tap AutoFill suggestion.
- **Expected**:
  - Face ID / Touch ID prompt fires.
  - Team entry decrypts via the wrapped team key (under 15 min old).
  - Personal entries for the same host also appear in the picker if any.

### 6. Manual edit (personal entry)

- **Pre-condition**: vault unlocked
- **Steps**:
  1. Tap an entry in the list to open detail.
  2. Tap Edit in the toolbar.
  3. Update the password field; tap Save.
- **Expected**:
  - Save button is disabled until a field changes.
  - On save, the app encrypts the new blob with the same `buildPersonalEntryAAD(userId, entryId)` and PUTs to `/api/passwords/{id}`.
  - After 200, `runSync` rewrites the cache with the new ciphertext.
  - The detail view reflects the new value.
- **Note**: Team entry edit shows an alert "Editing team entries is not yet supported on iPhone."

### 7. Auto-lock while Safari is open

- **Pre-condition**: vault unlocked, auto-lock = 1 minute (set in Settings)
- **Steps**:
  1. Switch to Safari, leave the app inactive for > 1 minute.
  2. Trigger AutoFill on a fixture URL.
- **Expected**:
  - The credential picker shows "Open passwd-sso to unlock" (the host's bridge_key is gone, so the AutoFill extension has nothing to decrypt).
  - Tapping "Open" returns the user to the host app for re-unlock.

### 8. No matching domain

- **Pre-condition**: vault unlocked
- **Steps**:
  1. Navigate to a fresh URL with no matching entry (e.g. `https://wikipedia.org/wiki/Login`).
  2. Tap a sign-in form's AutoFill keyboard.
- **Expected**: The picker shows no suggestions and an "Open passwd-sso" link to add a new entry manually.

### 9. Expired or revoked token

- **Pre-condition**: vault unlocked; revoke the iOS token from the web admin UI
- **Steps**:
  1. Trigger a foreground refresh (background the app, foreground it).
- **Expected**:
  - The host app sees a 401 from `/api/mobile/token/refresh`.
  - State transitions to "Sign in again"; the existing cache is preserved (so AutoFill still works locally until the wrapped team keys hit the 15-min wall-clock cap).

### 10. Apps without Associated Domains

- **Pre-condition**: vault unlocked
- **Steps**:
  1. Open any iOS app's sign-in form whose bundle ID is not on any AASA file.
- **Expected**: The keyboard shows the manual search list (URL-host match cannot help). Documented gap, not parity-claimed.

## Adversarial scenarios (Tier-2 obligation)

### A1. Homograph host attack

- **Steps**: Type `https://gìthub.com/login` into Safari. Tap username field.
- **Expected**: AutoFill picker shows the actual host (`gìthub.com`, the homograph) prominently. The user can see it differs from `github.com`. NO matching credential is offered (URL host match is exact-or-suffix, not visually-equivalent).

### A2. Malicious app relying-party overlap (subdomain confusion)

- **Steps**: A test app declares Associated Domains for `attacker-controlled-host.example`. Trigger AutoFill in that app.
- **Expected**:
  - URL host match rules out personal/team entries that don't suffix-match the requesting host.
  - For app-side fills (NOT Safari), the credential picker shows the bundle ID prominently AND requires an extra confirmation tap (per `Tenant.allowAppSideAutofill = true`).
  - If the tenant has `allowAppSideAutofill = false` (default), the extension shows a sheet "App-side AutoFill is disabled by your administrator."

### A3. AutoFill while screen-recording

- **Steps**: Start a screen recording (`Settings > Control Center > Screen Recording`); enter the vault list.
- **Expected**: A "Recording — content hidden" overlay covers the vault list and detail screens (`UIScreen.main.isCaptured` observation).

### A4. AutoFill while device under MDM / supervised mode

- **Steps**: Enroll the device in an MDM profile that restricts AutoFill providers. Trigger AutoFill.
- **Expected**: Behavior is unchanged at the application layer (iOS handles the MDM gate). Document any iOS-system messages.

### A5. Forensic acquisition simulation

- **Steps**: After signing out (full wipe), boot the simulator, verify the App Group container is empty AND the per-app Keychain is empty.
- **Expected**:
  - `<App Group>/vault/encryptedEntries.cache` is absent.
  - `<App Group>/vault/wrapped-vault-key.json` is absent.
  - `<App Group>/vault/wrapped-team-keys.json` is absent.
  - `bridge_key_blob` is absent from the shared Keychain access group.
  - `bridge_key_blob_owner_marker` sentinel in the per-app Keychain is absent.

### A6. Refresh-token theft simulation (per T24)

- **Steps**:
  1. Extract the refresh token from a device backup (encrypted iTunes/Finder backup → re-restore on a different device).
  2. Use the extracted token to call `/api/mobile/token/refresh` from a non-paired device.
- **Expected**:
  - The DPoP `cnf.jkt` does not match the new device's Secure Enclave key.
  - Server returns 401 with audit `MOBILE_TOKEN_REPLAY_DETECTED` `replayKind='refresh_token_reuse'`.
  - The token family is revoked; the original device's next refresh fails.
  - Original device surfaces "session revoked, sign in again."

### A7. Host-app crash mid-write (per T24)

- **Steps**:
  1. Begin an entry-edit save flow.
  2. Force-kill the app (multitasking) BETWEEN `wrapped_vault_key` write and `bridge_key` Keychain update.
  3. Open the AutoFill extension.
- **Expected**:
  - Extension reads `bridge_key_blob`; if absent → "Open passwd-sso to unlock" (clean fail-closed).
  - If present but stale (counter mismatch with cache file) → cache rejection + flag write.
  - No half-state read.

### A8. Bridge-key access-group rotation (per T24)

- **Steps**: Uninstall the app, reinstall under a different signing identity (Team ID change).
- **Expected**:
  - The new install cannot read the old `bridge_key_blob` (different access group).
  - The host app surfaces a re-unlock prompt.
  - The AutoFill extension's `prepareCredentialList` returns "Vault is locked. Open passwd-sso to unlock."

### A9. Server URL TOFU (per S20)

- **Steps**:
  1. Sign in to server A; pin the AASA hash + TLS SPKI.
  2. Change the AASA file content on the server (simulate operator key rotation).
  3. Foreground the app.
- **Expected**: The app surfaces "Trust new server?" prompt requiring master-passphrase re-entry.

### A10. Server URL phishing (per S20)

- **Steps**: On first setup, paste a homograph server URL.
- **Expected**: The app's first probe of `/.well-known/apple-app-site-association` succeeds (the malicious server claims to be `passwd-sso`); the unlock screen prominently displays the entered URL so the user can recognize the mismatch on every unlock.

### A11. Cache freshness window (per T34)

- **Steps**:
  1. Add a new entry on the web client.
  2. Immediately try AutoFill on the iPhone.
  3. Observe the new entry is NOT present (cache is stale).
  4. Foreground the host app; wait for the sync to complete.
  5. Try AutoFill again.
- **Expected**: The new entry appears AFTER the host-app foreground sync, not before.

### A12. BackgroundTask under Low Power Mode (per T35 / F23)

- **Steps**:
  1. Enable iOS Low Power Mode (`Settings > Battery`).
  2. Background the host app for 4 hours.
  3. Trigger AutoFill.
- **Expected**: Stale team-key blobs (> 15 min old) trigger fail-closed AutoFill with "Open passwd-sso to refresh." (Best-effort BackgroundTask drops happen here by design.)

### A13. End-to-end host-sync → extension-fill (per T33)

- **Steps**: sign in → unlock → wait for or trigger sync → verify App Group cache file size > 0 → drive Safari to a fixture login form → assert credential picker shows fixture entry. Re-run after a `BackgroundTask` to verify the top-up path produces the same outcome.
- **Expected**: cache size > 0 after sync; credential picker shows expected fixtures.

### A14. Server-takeover recovery via uninstall + reinstall (per T38 / S28)

- **Steps**:
  1. Sign in to server A; observe AASA + TLS pin established.
  2. Uninstall app.
  3. Reinstall.
  4. On first launch, observe: server URL field is empty, no pinned AASA hash, no pinned cert SPKI, master-passphrase challenge requires fresh sign-in.
- **Expected**: All pinned values are cleared (Synchronizable=false keeps them local to the bundle).

### A15. BGTaskScheduler exercise (per T40)

- **Steps** (manual-only path):
  1. Run the app on a connected simulator with the `BGTaskScheduler` registered.
  2. In LLDB, run: `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"com.passwd-sso.cache-sync"]`
  3. Verify the BackgroundTask handler updates `lastSuccessfulRefreshAt` and rewrites the cache.
- **Note**: The handler logic itself is unit-testable as `BackgroundSyncCoordinator.run(session, client) → Result` — see Unit Tests in Step 5.

## Test result template

For each scenario:

```
## Scenario [N] — [name]

- Date: YYYY-MM-DD
- Tester: <name>
- Device: <iPhone model + iOS version>
- Result: PASS | FAIL | SKIP
- Notes: <on PASS: brief confirmation; on FAIL: failure mode + steps to reproduce; on SKIP: reason>
```

Sign-off requires PASS on scenarios 1-10 + adversarial 1-15 OR explicit waiver from the security reviewer.

## References

- Plan: [docs/archive/review/ios-autofill-mvp-plan.md](./ios-autofill-mvp-plan.md)
- Coding Deviations: [docs/archive/review/ios-autofill-mvp-deviation.md](./ios-autofill-mvp-deviation.md)
- iOS Workspace README: [ios/README.md](../../../ios/README.md)
