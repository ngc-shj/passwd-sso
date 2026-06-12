# Manual Test Plan: iOS manual Sign Out + tenant auto-lock override

Unit tests cover the decode/threading/persist/effective/clamp logic
(`applyTenantPolicy` 3 branches, getter fail-close, clamp). The SwiftUI surfaces
(Sign Out dialog, org-enforced Settings UI) and the end-to-end policy-threading
across unlock paths are not unit-testable — verify them here before release.

## Pre-conditions

- A device or simulator running iOS 17+, signed in and unlocked.
- A reachable passwd-sso server. **Use a placeholder host of your own** (e.g.
  `https://vault.example.com`) — never a real production hostname or account email.
- Tenant-policy steps require admin access to set `vaultAutoLockMinutes` on the
  tenant (via the web dashboard tenant policy, or DB for test setup).

## A. Manual Sign Out

| # | Steps | Expected |
|---|-------|----------|
| 1 | Unlocked vault → ⋯ menu | "Sign Out" appears below "Lock" (destructive, red) |
| 2 | Tap "Sign Out" | Confirmation dialog: title "Sign out of passwd-sso?", message "This clears the local session…", destructive "Sign Out" + "Cancel" |
| 3 | Tap "Cancel" | Dialog dismisses; vault stays unlocked; list unchanged |
| 4 | ⋯ → Sign Out → confirm "Sign Out" | App returns to the server-setup / sign-in screen |
| 5 | After sign-out, attempt to re-enter | Must re-authenticate (OAuth) AND re-unlock (passphrase) — tokens, bridge_key, wrapped keys, and cache are gone |
| 6 | (ja device) repeat 1-2 | 「サインアウト」, dialog「passwd-sso からサインアウトしますか？」/「ローカルセッションが消去されます。…」/「サインアウト」/「キャンセル」 |

## B. Tenant auto-lock override

Pre: set the tenant's `vaultAutoLockMinutes` to a value NOT in {5,15,30,60}, e.g. **120**.

| # | Steps | Expected |
|---|-------|----------|
| 1 | Sign in + unlock with passphrase → open Settings | Auto-Lock picker is **disabled**, shows "120 minutes" / 「120 分」; footnote "Set by your organization." / 「組織によって設定されています。」 |
| 2 | Try to change Auto-Lock | Cannot (disabled); "On Timeout" + Clipboard remain editable |
| 3 | Leave the app idle | Vault auto-locks after **120 min** (the tenant interval), NOT 60 |
| 4 | Set tenant `vaultAutoLockMinutes` to a STANDARD value (e.g. 30) → re-unlock with passphrase → Settings | Picker disabled, shows "30 minutes" (standard option, no duplicate), hint shown |
| 5 | **Clear** the tenant policy server-side (set null) → re-unlock with passphrase → Settings | Picker **enabled** again with {5,15,30,60}; reflects the user's own prior choice (their setting was never overwritten); no hint |

## C. Biometric path retains the policy (the critical non-authoritative case)

| # | Steps | Expected |
|---|-------|----------|
| 1 | With tenant=120 enforced, passphrase-unlock once (persists 120) | Settings shows 120 enforced |
| 2 | Lock, then re-unlock via **Face ID/Touch ID** (offline path, no fresh fetch) | Settings still shows 120 enforced (the persisted value is retained, NOT wiped by the biometric unlock) |
| 3 | Sign Out (section A) | On next sign-in the tenant policy is re-fetched fresh; the persisted value was cleared on logout |

## Adversarial / edge

- Server returns `vaultAutoLockMinutes` = 0 / negative / > 1440 → treated as no override (user setting applies; huge values are not honored). Verify auto-lock uses the user's interval, not a disabled/24h+ lock.
- Sign Out while a sync is in flight → still signs out cleanly (no crash, lands on setup).

## Rollback

Revert the branch; no migration, schema, or persisted-secret change. The tenant
key is a non-secret App Group UserDefaults integer cleared on logout.
