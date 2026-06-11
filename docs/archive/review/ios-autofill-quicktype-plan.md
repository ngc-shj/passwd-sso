# Plan: iOS QuickType inline AutoFill suggestions (ASCredentialIdentityStore)

## Project context
- Type: `mixed` — native iOS app (host + AutoFill extension). Security-sensitive: registers
  credential metadata (username + site host + entry id) into the OS-managed credential identity store,
  which SpringBoard reads to render inline keyboard suggestions.
- Test infrastructure: `unit tests only`. The identity-mapping logic is unit-testable (pure);
  `ASCredentialIdentityStore` calls are system APIs verified manually on device.

## Problem (confirmed earlier on-device)
The iOS app registers NO credential identities (`grep` → no `ASCredentialIdentityStore` anywhere), so
the keyboard's inline QuickType suggestion bar is always empty. This was the user's first reported
symptom ("host matches but 0 candidates" inline). Today the user must open the provider picker
manually. The browser extension's analog is the inline suggestion dropdown. The fill side is already
done: the extension's iOS 17+ `provideCredentialWithoutUserInteraction(for:)` /
`prepareInterfaceToProvideCredential(for:)` consume `credentialRequest.credentialIdentity.recordIdentifier`
and decrypt+fill (biometric-gated) — so registering identities completes the loop.

## Objective
Register one `ASPasswordCredentialIdentity` per host-bearing vault entry (personal + team) whenever the
host app unlocks/syncs, so passwd-sso credentials appear inline in the QuickType bar. Clear them on
lock / logout so the system store's lifetime matches `bridge_key` (no inline hints for a locked vault).

## Requirements
Functional:
- After unlock + each sync, the QuickType bar shows passwd-sso suggestions for the current site.
- Selecting a suggestion fills via the existing biometric-gated extension path (recordIdentifier = entry id).
- Identities are a full replace of the current decrypted summary set (idempotent).
- Entries with empty `urlHost` and empty `additionalUrlHosts` are skipped (no useful serviceIdentifier;
  still reachable via the manual picker).

Non-functional / security:
- Identities (username + host + entry id — NO password) are cleared on `lock()` and `signOut()` so a
  locked/idle vault leaves no inline site/username hints. Lifetime == `bridge_key` lifetime, governed
  by the same auto-lock timeout.
- No password or secret is ever written to the identity store (passwords stay in the encrypted cache;
  fill decrypts on demand).

## Contracts

### C1 — CredentialIdentityRegistrar (locked)
- New `CredentialIdentityRegistrar` (Shared or App) with pure mapping + a thin store wrapper:
  - `static func identities(from summaries: [VaultEntrySummary]) -> [ASPasswordCredentialIdentity]`
    — PURE, unit-testable. For each summary with a non-empty `urlHost` (and each `additionalUrlHosts`
    entry), produce `ASPasswordCredentialIdentity(serviceIdentifier: ASCredentialServiceIdentifier(
    identifier: host, type: .domain), user: summary.username, recordIdentifier: summary.id)`. Skip
    summaries whose `urlHost` AND `additionalUrlHosts` are all empty. Username may be empty (still a
    valid identity; iOS shows the site).
  - `func replace(with summaries: [VaultEntrySummary]) async` — calls
    `ASCredentialIdentityStore.shared.replaceCredentialIdentities(identities(from:))` only when the
    store's `state(...).isEnabled` is true (no-op otherwise; AutoFill provider disabled).
  - `func clear() async` — `ASCredentialIdentityStore.shared.removeAllCredentialIdentities()`.
- Acceptance (unit, the pure mapper): N summaries with hosts → N (+ additional-host) identities with
  correct serviceIdentifier/user/recordIdentifier; empty-host summary → excluded; additionalUrlHosts
  produce extra identities pointing at the same recordIdentifier.
- Forbidden patterns:
  - `pattern: ASPasswordCredential(` inside the registrar — reason: the registrar handles
    *identities* (metadata), never credentials/passwords.

### C2 — Registration trigger (locked)
- After the host app has decrypted summaries (post-unlock + after each sync), call
  `registrar.replace(with: viewModel.summaries)` (or the freshly-loaded summary set). Wire at the
  point where `VaultViewModel.summaries` is populated / `HostSyncService` completes a sync, so the
  identity set tracks the latest entries.
- **Consumer-flow walkthrough**: the consumer is the AutoFill extension's
  `provideCredentialWithoutUserInteraction(for: any ASCredentialRequest)` /
  `prepareInterfaceToProvideCredential(for:)` (already implemented), which reads
  `credentialRequest.credentialIdentity.recordIdentifier` = `summary.id` and calls
  `resolver.decryptEntryDetail(entryId:)`. Field check: the recordIdentifier we register (`summary.id`)
  is exactly the `entryId` the extension's `decryptEntryDetail` looks up in the cache — verified
  consistent. No additional field needed.
- Acceptance: on device, after unlock the QuickType bar shows suggestions; selecting one fills.

### C3 — Clear on lock / logout (locked)
- `AutoLockService.lock()` and `signOut()` call `registrar.clear()` so identities never outlive the
  unlocked session. (signOut already clears tokens/cache/keys; add identity clear.)
- Acceptance: after lock/logout, the QuickType bar shows no passwd-sso suggestions (device-manual).
- Security note: this matches `bridge_key` lifetime — a locked vault leaks no inline metadata.

### C4 — No regression (locked)
- `build-for-testing` + `test-without-building` pass; existing 261 tests green + new registrar mapping
  tests. The AutoFill extension is unchanged (already consumes recordIdentifier). No new warnings.

## Testing strategy
- Unit: the pure `identities(from:)` mapper (host present/absent, additionalUrlHosts fan-out, empty
  username, recordIdentifier == summary.id). The `ASCredentialIdentityStore` calls (`replace`/`clear`/
  `state`) are system APIs — not unit-testable; verified manually on device.
- Manual (device): unlock → QuickType shows suggestions for a matching site; select → biometric →
  fill; lock → suggestions gone; re-unlock → suggestions return.

## Considerations & constraints
- **Team entries**: registered too (the extension's `decryptEntryDetail` already handles team
  recordIdentifiers). If team-key staleness blocks decrypt at fill time, the extension falls back to
  its existing error path — acceptable.
- **Identity store enablement**: `replace` is a no-op when the provider is disabled in Settings →
  AutoFill (`state.isEnabled == false`); avoids futile calls.
- **`autoCopyTotp` / Save-Update** are separate parity items (next); this plan is QuickType only.
- **Privacy**: only username + host + entry id reach the system store, and only while unlocked. No
  passwords. Documented for the security review.

## User operation scenarios
- In Safari on an amazon login field (vault recently unlocked) → the keyboard suggestion bar shows the
  amazon passwd-sso entry inline → tap → Face ID → filled (no manual provider selection).
- After the auto-lock timeout → no inline suggestions until the app is unlocked again.

## Round 1 Review Resolutions (triangulate — functionality/security/testing)

These supersede the C1–C3 bodies above where they conflict.

- **F1 (Critical) → FIXED**: `VaultViewModel.summaries` is DEAD (never assigned; only `allSummaries`
  is populated by `loadFromCache`). Register from the **freshly-decrypted summary set**, never
  `viewModel.summaries`. Source of truth = the summaries decrypted from each `runSync`'s
  `SyncReport.cacheData` (or `allSummaries` after a `loadFromCache`).
- **F2 (High) + F3 + F9 → FIXED**: `loadFromCache` is only called on `VaultListView.onAppear`; no
  sync path refreshes in-memory summaries. Wire `registrar.replace(...)` at EVERY `runSync` site,
  each decrypting overviews from that sync's `cacheData`:
  - `RootView.handleVaultUnlocked` (after the initial sync ~line 183)
  - `PasswdSSOAppApp` foreground `.onChange(scenePhase == .active)` re-sync (~line 51)
  - `BackgroundSyncTask` (~line 77) — register after background sync (the host process can call the
    store; vault key is available). If deferring, document explicitly — do not leave implicit.
  - `VaultViewModel.saveEntry` optimistic update (latent — edit UI disabled; name it so it's not
    missed when edit re-lands).
  A small shared helper decrypts `[VaultEntrySummary]` from a `CacheData` + vaultKey (reuse the
  existing overview-decrypt path) so all sites feed the registrar the CURRENT set.
- **F4 → noted**: `.domain` is correct, but iOS QuickType `.domain` matching is exact registrable-host,
  NARROWER than the picker's subdomain-suffix `isHostMatch` (a stored `example.com` won't inline-suggest
  on `app.example.com`, though the picker matches it). Acceptable iOS limitation; document — do not
  claim full picker parity for the inline bar.
- **F5 → fixed**: dedupe identical `(host, user)` pairs (urlHost may also appear in additionalUrlHosts).
- **F6/T4 (Major) → FIXED**: the registrar is **constructor-injected** into `AutoLockService`
  (defaulting to a no-op so the 4 existing lock/signOut tests construct unchanged). `clear()` is async;
  call it ONCE on lock (put it in `lock()`; `signOut()` calls `lock()`, so don't duplicate) as
  fire-and-forget `Task { await registrar.clear() }`. For the new "clear on lock" test, the injected
  fake exposes an await-able signal (continuation / `clearCallCount` read after `await fulfillment`)
  — never assert on the line after a fire-and-forget Task (racy; no `sleep`).

- **S1 (Medium, security) + S2 + S3 → FIXED — the key hardening**: `ASCredentialIdentityStore` is
  OS-managed and **survives app termination and device reboot**, so "lifetime == bridge_key" is FALSE
  on crash/force-quit/reboot. Enforce the invariant **"vault locked ⇒ identity store empty" at app
  launch**, not only inside `lock()`:
  - On app launch (before any unlock), call `registrar.clear()` UNCONDITIONALLY (idempotent) —
    reconciles any identities stranded by a crash/reboot. Identities repopulate only after a
    successful unlock+sync.
  - Clear on `scenePhase == .background` too (closes the up-to-timeout window where a backgrounded,
    still-"unlocked" app leaks the site/username inventory). Repopulate on the next foreground unlock/sync.
  - Keep the lock/logout clear as well (graceful path). Net: identities exist ONLY while the app is
    foreground-and-unlocked.
- **S4 → fixed**: confirm `summary.id` is a random UUID (not enumerable); extend the registrar
  forbidden-pattern lint to also ban `password` / `totpSecret` / `detail.` field access inside the
  registrar (defence-in-depth so a future edit can't smuggle a secret into the store).
- **S6 → fixed**: feed the registrar ONLY the current-tenant decrypted set; verify the cache is
  purged on tenant switch so no stale-tenant hosts/usernames are registered. (Team usernames inherit
  the S1/S2 lifetime hardening — no separate mechanism.)
- **T1/T2 (Major) → FIXED**: the pure mapper lives in **Shared** (beside `partitionCandidates`),
  un-isolated tests assert on `.serviceIdentifier.identifier` / `.serviceIdentifier.type` / `.user` /
  `.recordIdentifier`. Lock the full case table (8): (1) host-only → 1 identity, fields correct;
  (2) urlHost="" AND additional=[] → 0; (3) urlHost="" AND additional=["a.com"] → 1 (the "both empty"
  skip rule, not "urlHost empty"); (4) urlHost + 2 additionals → 3, same recordIdentifier;
  (5) empty string INSIDE additionalUrlHosts → dropped (no identity with identifier==""); (6) empty
  username → identity still produced; (7) N summaries → flat-map, each recordIdentifier maps to its
  source id; (8) [] → [].
- **T3 (Major) → FIXED**: introduce `protocol CredentialIdentityStoring { var isEnabled: Bool async;
  func replace(_:) async; func removeAll() async }` (production impl forwards to
  `ASCredentialIdentityStore.shared`), matching the existing DI culture (BridgeKeyStore/Clock/
  HostTokenStore are all injected). A fake lets unit tests verify: replace-when-enabled calls through
  with the mapped identities, replace-when-disabled is a no-op, `clear()` calls `removeAll`. Never
  assert against the real `ASCredentialIdentityStore.shared` (entitlement/env-dependent → flaky).
- **T5 → noted**: forbidden-pattern is a build/lint grep (not a unit test); C4 phrased as
  "261 existing still green + new registrar/store-seam/clear-on-lock tests".

## Go/No-Go Gate
| ID  | Subject                                          | Status |
|-----|--------------------------------------------------|--------|
| C1  | CredentialIdentityRegistrar (pure map + wrapper) | locked |
| C2  | Registration on unlock/sync                      | locked |
| C3  | Clear on lock/logout                             | locked |
| C4  | No build/test regression                         | locked |
