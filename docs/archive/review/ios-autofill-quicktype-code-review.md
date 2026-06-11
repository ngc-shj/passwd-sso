# Code Review: ios-autofill-quicktype

Date: 2026-06-11
Review round: 1 (converged)
Base: `ios-main` (= origin/main). Scope: `git diff ios-main...HEAD` — 6 files (registrar + integration + tests).

## Functionality Findings
- **F5 (Medium) — documented**: background-clear vs foreground-register are unserialized fire-and-forget
  Tasks; on scene thrash the `.active` re-register is the last writer once settled, so transient
  inconsistency self-heals. Added a comment at the scenePhase handler documenting the
  "`.active` is the last writer; `.background` is the privacy boundary" assumption (PasswdSSOAppApp).
  Full serialization (generation-counter actor) deemed gold-plating for a sub-second self-healing window.
- **F8 (Low, security-adjacent) — mitigated**: `decryptPersonalOverviews` duplicates
  `VaultViewModel.decryptOverview`'s AAD rules (drift risk → silent QuickType breakage on a server AAD
  bump). Added a cross-reference NOTE in both directions instead of a risky extraction (the host decrypt
  path works and handles team via a different branch; merging is higher-risk than the Low severity warrants).
- **F6 (Low) — accepted (YAGNI)**: each call site constructs a fresh `CredentialIdentityRegistrar()`; the
  struct is stateless over `ASCredentialIdentityStore.shared`, the seam is unit-tested, no shared instance
  needed.
- Verified correct: AAD rules match VaultViewModel (F1); recordIdentifier round-trips host↔extension (F2);
  mapper dedup/skip/trim (F3); clear coverage incl. `.inactive` correctly NOT clearing (F4); background-sync
  intentionally not registering, consistent with background-clear; saveEntry latent site named for the edit
  re-enablement work (F7); Sendable/strict-concurrency clean (F9).
- **Team-entry exclusion (product note)**: QuickType covers personal entries only (the set the host
  decrypts with vault_key); team sites never inline-suggest. Documented plan decision; team QuickType is a
  follow-up (needs team keys in the host decrypt path).

## Security Findings
- **No Critical/High; no escalation.** Verified: launch-clear is unconditional + pre-unlock, enforcing
  "vault locked ⇒ no inline hints" across crash/reboot (the OS store survives termination) (S1); background
  clear present; the invariant "identities exist only while foreground+unlocked" holds (S6 reconciliation
  real); NO password/totpSecret reaches the store — only host/user/entry-id (S3); overview-only decrypt,
  never the blob (S4); the extension/fill path is untouched → no silent-fill bypass (S5); team entries
  excluded = strictly more conservative (S7).
- **S2 (Low) — documented**: a narrow post-crash launch window (before the async `.task` clear runs) where
  metadata-only (host+username, no secret) inline hints persist; actual fill stays biometric-gated. The
  `.task` comment documents it; no robust code-side fix exists (identities can't be cleared before the
  process runs). Worst case: account-inventory metadata visible for sub-seconds after a crash on an already
  device-unlocked phone. Likelihood low; cost-to-fix at the app layer: none effective. Accepted.

## Testing Findings (FIXED)
- **T1 (Medium) — FIXED**: `decryptPersonalOverviews` (the highest-logic addition: AAD v0/v1 branch +
  team-skip invariant) had zero tests. Added `testDecryptPersonalOverviews_returnsPersonalSummaries`
  (aadVersion 0 and 1), `_excludesTeamEntries` (the security-relevant team-skip), and
  `_wrongUserIdExcluded` (AAD binding), with an in-memory CacheData fixture.
- **T2 (Low) — accepted**: the decrypt→replace glue is the only untested seam; both halves (decrypt via T1,
  replace via the store-seam tests) are covered, so the 2-line glue is left to manual/device.
- Verified sound: 9 mapper cases + dedup, store-seam replace/clear/disabled with a race-free actor fake,
  all async assertions awaited (no vacuous pass), no red flags.

## Resolution Status
All Testing (T1) findings fixed; Functionality (F5/F8) documented + F6 accepted; Security clean (S2
documented + accepted with quantified justification). Build clean; **276 unit (+3) + 2 UI tests pass**.
Round 1 converged. The fill side (extension recordIdentifier consumption) was delivered in #533;
this branch is the host-side registration that completes the inline-suggestion loop.
