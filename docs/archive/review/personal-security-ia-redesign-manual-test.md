# Manual Test Plan — personal-security-ia-redesign

R35 artifact for Tier-1 (UI surface) deployment-affecting change.

## Pre-conditions

- Local dev DB up to date with migrations (including `20260502013455_add_settings_ia_migration_v1_seen`).
- Two locales available (`/ja/`, `/en/`).
- Three test users:
  - `vaultReady@example.com` — vault setup + unlocked, personal-only.
  - `tenantAdmin@example.com` — same as above, additionally a tenant admin.
  - `passkeyRequired@example.com` — tenant has `requirePasskey=true`, no passkey enrolled.
- Browser extension built from `extension/` (optional — for step 6).

## Steps

### 1. Foundation health check

| Step | Action | Expected |
|---|---|---|
| 1.1 | `npm run db:migrate` against dev DB | New migration `20260502013455_add_settings_ia_migration_v1_seen` applied; `\dT+` on `AuditAction` shows the new value |
| 1.2 | `npx vitest run` | All ~7836 tests pass (or higher) |
| 1.3 | `npx next build` | Build succeeds with no errors |

### 2. Header — LockVaultButton

| Step | Action | Expected |
|---|---|---|
| 2.1 | Sign in as `vaultReady`, vault unlocked, navigate to `/ja/dashboard` | Lock icon (🔒) visible next to avatar; `aria-label="保管庫をロック"` |
| 2.2 | Click 🔒 | Vault locks (status badge updates); page route unchanged; toast "保管庫をロックしました" or equivalent |
| 2.3 | After lock, view header | 🔒 button is HIDDEN (component returns null when `vaultStatus !== UNLOCKED`) |
| 2.4 | Open avatar dropdown | "個人の設定 →" link visible; "パスフレーズを変更" / "回復キー" / "保管庫をロック" items NOT present |
| 2.5 | Switch to `/en/dashboard` | English label "Lock vault" applied |

### 3. Header — Mobile (iOS Safari + Android Chrome)

| Step | Action | Expected |
|---|---|---|
| 3.1 | Open `/ja/dashboard` on iPhone Safari (or DevTools iPhone 13 emulation), vault unlocked | Lock icon tappable in 1 tap |
| 3.2 | Tap 🔒 | Vault locks immediately |
| 3.3 | Repeat on Android Chrome (Pixel 7 emulation) | Same result |

### 4. Settings sidebar — 6-section layout

| Step | Action | Expected |
|---|---|---|
| 4.1 | Avatar dropdown → "個人の設定 →" → lands on `/ja/dashboard/settings/account/profile` | Sidebar shows 6 sections: アカウント / 本人認証 / デバイスとセッション / 保管庫 / 共有と委任 / 開発者 |
| 4.2 | Click 本人認証 → パスフレーズ | URL `/ja/dashboard/settings/auth/passphrase`; sidebar item has `aria-current="page"` |
| 4.3 | Lock vault, return to パスフレーズ page | "vault locked" placeholder rendered; ChangePassphraseDialog NOT auto-opened |
| 4.4 | Unlock vault, return to パスフレーズ page | "Change passphrase" button visible; clicking opens dialog |
| 4.5 | Walk every section/sub-section pair | Each has the correct active highlight |

### 5. URL redirects — bookmark / external-link compat

For each (locale, old-path) below, navigate from address bar, confirm 308 → new path:

| Locale | Old path | New path |
|---|---|---|
| ja | `/ja/dashboard/settings/security` | `/ja/dashboard/settings/account` |
| ja | `/ja/dashboard/settings/security/sessions` | `/ja/dashboard/settings/devices` |
| ja | `/ja/dashboard/settings/security/passkey` | `/ja/dashboard/settings/auth/passkey` |
| ja | `/ja/dashboard/settings/security/travel-mode` | `/ja/dashboard/settings/vault/travel-mode` |
| ja | `/ja/dashboard/settings/security/key-rotation` | `/ja/dashboard/settings/vault/key-rotation` |
| ja | `/ja/dashboard/settings/mcp/connections` | `/ja/dashboard/settings/developer/mcp-connections` |
| ja | `/ja/dashboard/settings/mcp/delegation` | `/ja/dashboard/settings/vault/delegation` |
| en | `/en/dashboard/settings/security/passkey` | `/en/dashboard/settings/auth/passkey` |
| en | `/en/dashboard/settings/mcp/delegation` | `/en/dashboard/settings/vault/delegation` |

For each redirect destination — `MovedPageNotice` MUST be visible on first arrival; navigating away and back in the same tab MUST NOT re-show it; opening a new browser tab/profile MUST re-show it.

### 6. Browser extension deep-link

| Step | Action | Expected |
|---|---|---|
| 6.1 | Trigger extension flow that opens `/dashboard/settings/security/passkey` | Browser navigates to `/dashboard/settings/auth/passkey`, page renders |

(Skip if extension is not built locally.)

### 7. Migration banner

| Step | Action | Expected |
|---|---|---|
| 7.1 | First sign-in as `vaultReady` post-deploy (clear `localStorage["psso:settings-ia-redesign-banner-dismissed"]`) | Banner visible at top of dashboard |
| 7.2 | Click "詳細" | Modal opens with summary of new IA |
| 7.3 | Close modal, click "了解" | Banner hidden; localStorage key set; one row in `audit_logs` (or `audit_outbox`) with action `SETTINGS_IA_MIGRATION_V1_SEEN`, scope `PERSONAL` |
| 7.4 | Reload dashboard | Banner stays hidden |
| 7.5 | Open new browser context (incognito or different profile) | Banner visible again (per-device localStorage) |

### 8. Insights sidebar landmark + accessibility

| Step | Action | Expected |
|---|---|---|
| 8.1 | Screen reader (NVDA / VoiceOver) at `/ja/dashboard`, jump landmarks | A region named "Security" is reachable, contains Watchtower + 監査ログ |
| 8.2 | Same on `/en/dashboard` | Region name still "Security" (English literal — locale-independent for SR search compat) |
| 8.3 | Verify visible label is "インサイト" / "Insights" | Match expected localized labels |

### 9. 緊急アクセス recipient flow

| Step | Action | Expected |
|---|---|---|
| 9.1 | Sidebar at `/ja/dashboard` | "緊急アクセス" appears as top-level item, NOT inside the "インサイト" group |
| 9.2 | Click 緊急アクセス | URL `/dashboard/emergency-access` |
| 9.3 | Trigger an emergency-access notification (out-of-band) | Notification deep-link resolves to `/dashboard/emergency-access?focus={id}` (unchanged) |

### 10. Tenant admin scoping (run as `tenantAdmin`)

| Step | Action | Expected |
|---|---|---|
| 10.1 | Sidebar shows both "個人の設定" and "管理コンソール" links | OK |
| 10.2 | `/dashboard/settings/*` does NOT show admin-only items (e.g. operator tokens) | OK |
| 10.3 | `/admin/*` does NOT show personal-only items | OK |

### 11. Passkey enforcement (run as `passkeyRequired`)

| Step | Action | Expected |
|---|---|---|
| 11.1 | Sign in, redirect | Lands on `/ja/dashboard/settings/auth/passkey` (NOT a redirect loop) |
| 11.2 | Try to navigate to `/ja/dashboard/settings/auth/passphrase` | Blocked by passkey gate (redirected back to passkey page) — vault-sensitive auth pages STAY GATED |
| 11.3 | Register a passkey | Flow completes; subsequent navigation works |

### 12. Travel Mode badge

| Step | Action | Expected |
|---|---|---|
| 12.1 | Enable Travel Mode at `/dashboard/settings/vault/travel-mode` | Orange "✈ Travel" badge appears in header |
| 12.2 | Navigate to a different page | Badge persists in header globally |
| 12.3 | Disable Travel Mode | Badge disappears |

## Expected results summary

- All 12 sections pass with no regressions.
- No console errors during navigation.
- No 404s for any old IA path.
- New audit-action entries written correctly with PERSONAL scope.

## Rollback

1. **Procedure**: `git revert <merge-commit>` and redeploy.
   - The Prisma migration `20260502013455_add_settings_ia_migration_v1_seen` is NOT auto-reverted. The enum value persists in DB (audit-log immutability).
2. **Residual state — explicitly OK to leave behind**:
   - `localStorage["psso:settings-ia-redesign-banner-dismissed"]` — irrelevant for old UI.
   - `localStorage["psso:settings-ia-moved-notice:*"]` — irrelevant for old UI.
   - `audit_logs` rows with action `SETTINGS_IA_MIGRATION_V1_SEEN` — intentional (audit immutability).
   - `enum AuditAction.SETTINGS_IA_MIGRATION_V1_SEEN` value persists in DB.
3. **Rollback compatibility constraint**: when reverting, the rollback PR MUST manually re-add to:
   - `AUDIT_ACTION` and `AUDIT_ACTION_VALUES` in `src/lib/constants/audit/audit.ts`
   - `messages/{ja,en}/AuditLog.json` action label
   - `AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.SETTINGS]` (and the new `SETTINGS` group definition)
   - `groupSettings` label in both `AuditLog.json` files
   - `ALLOWED_ACTIONS` in `src/app/api/internal/audit-emit/route.ts`
   ...because `git revert` removes both the IA refactor AND the enum entries, but the enum entries must persist or the audit-chain verifier rejects existing audit rows. ~10-line manual fixup; spell out in the rollback PR description.
4. **Native old-URL behavior post-revert**: 308 redirect entries are removed by the revert; old paths resolve directly to the old pages (which exist again in the reverted code).

## Adversarial scenarios (skipped — Tier-1 only)

This is a Tier-1 IA refactor (UI surface change), not a Tier-2 auth/crypto/identity change. Adversarial scenarios are not strictly required. However, the following were considered:

- **Audit-emit XSS write primitive** (S11): mitigated by per-action `metadata` rejection and PERSONAL-only scope whitelist for the new action. An XSS-reachable POST cannot inject attacker-controlled content; it can only emit a content-free row up to 20×/min.
- **Passkey enforcement bypass** (S13): `PASSKEY_EXEMPT_PREFIXES` narrowed to exactly `/dashboard/settings/auth/passkey`. Vault-sensitive auth pages (passphrase / recovery-key) stay gated under the proxy passkey check.
- **Open-redirect via `IA_REDIRECTS`**: closed-const list; unit tests guard against `//`, protocol prefixes, backslashes, whitespace.
