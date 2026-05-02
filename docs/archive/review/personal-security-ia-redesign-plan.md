# Personal Security IA Redesign — Plan

## Project context

- **Type**: web app (Next.js 16 App Router, TypeScript, Tailwind, shadcn/ui)
- **Test infrastructure**: unit (Vitest) + integration (real Postgres) + E2E (Playwright) + CI/CD (GitHub Actions)
- **Scope**: UI/UX restructuring; no API/schema/crypto changes
- **Language policy**: docs in English, UI labels in Japanese (ja primary, en complete)

## Objective

Reorganize personal security and settings information architecture (IA) based on user mental models. Eliminate the overloaded "Security" label, dissolve fragmentation across header / dashboard sidebar / settings, and surface high-frequency operations as 1-click affordances.

## Background — current problems

The label "セキュリティ" is currently used in three different surfaces with three different meanings:

| Surface | Current contents | Implicit meaning |
|---|---|---|
| Header dropdown | パスフレーズ変更 / 回復キー / 保管庫をロック | vault crypto operations |
| Dashboard sidebar > Security group | Watchtower / 緊急アクセス / 監査ログ | data governance / observability |
| Settings > Security tab | セッション / パスキー / トラベルモード / キーローテーション | mixed: auth + crypto + data scope |

Concrete defects:

1. Vault crypto operations (passphrase, recovery key, key rotation, delegation sessions) are spread across 4+ surfaces.
2. Settings tabs (Security / Developer / MCP) split by tech stack, not user intent. CLI tokens and MCP both serve "programmatic access" but live in separate tabs.
3. "Lock vault" is buried in a dropdown despite being the highest-frequency security action — every comparable product (1Password, Bitwarden, KeePassXC) makes it a one-click toolbar button.
4. Travel Mode lives under Security/auth though semantically it is a data scope filter, not authentication.
5. Recipient-side flow for 緊急アクセス must remain low-friction — it is the destination of urgent notifications.
6. The label "セキュリティ" fails as a category landmark because every section in this app is security-related; users searching by intent ("how do I rotate my key?") cannot map intent to location.

## Requirements

### Functional

- All existing functionality preserved. No feature removed.
- Old URLs continue to work via 301 redirect (no link rot for bookmarks, browser extension help, support docs).
- Lock Vault reachable in 1 click (desktop) / 1 tap (mobile) from any authenticated page when vault is unlocked.
- Travel Mode active state remains globally visible (header badge) even though configuration moves to Settings > 保管庫.
- 緊急アクセス recipient can reach the page in 1 click from a notification.
- One-time migration banner shown to existing users for 30 days post-deploy, with per-user dismiss tracking.
- A migration audit log entry is emitted per user on first post-deploy session, so security-conscious users can verify nothing was removed.

### Non-functional

- a11y: aria-label landmarks preserve "Security" / "Account" / "Sign-in" search terms even when visual category labels change.
- i18n: all new labels complete in `messages/ja.json` and `messages/en.json`. CI fails on missing keys.
- Mobile: the mobile header bar exposes Lock as a 1-tap target.
- Performance: no extra server round-trip on sidebar render. Migration banner state read once per session.
- Browser extension compatibility: extension deep links resolve correctly through 301.
- Trust: zero security-feature regression; visible audit-log evidence of the layout change.

## Technical approach

### Header (file: `src/components/layout/header.tsx`)

- New `LockVaultButton` component rendered next to the avatar — icon-only button, `aria-label="保管庫をロック"`, `tooltip="保管庫をロック"`.
  - Visible only when `vaultStatus === VAULT_STATUS.UNLOCKED` (matches current dropdown gate). Tests MUST import `VAULT_STATUS` from `src/lib/vault/vault-context.tsx` (the source of truth) — never inline string literals like `"UNLOCKED"` (RT1).
  - Calls the existing `lock()` from `useVault()` (`src/lib/vault/vault-context.tsx`) — does NOT introduce a new lock primitive. Auto-lock orchestration in `src/lib/vault/auto-lock-context.tsx` is unaffected.
  - **Idempotency**: `onClick` handler MUST early-return if `vaultStatus !== UNLOCKED` (race: vault auto-locks while button is rendered). The button is hidden in that state, but the click handler must defend against the in-flight render race. Toast confirmation is shown only on a successful UNLOCKED → LOCKED transition.
  - Mobile header: same icon, same aria-label, persistent.
  - **Keyboard tab order**:
    - Desktop (≥ md breakpoint): logo → LockVaultButton → notifications → avatar.
    - Mobile (< md breakpoint): mobile menu toggle → logo → LockVaultButton → notifications → avatar. (The mobile menu toggle precedes the logo in the current DOM and remains the first focusable; this is unchanged.)
- Remove `パスフレーズを変更` and `回復キー` items from the user dropdown; add a single `個人の設定 →` link to `/dashboard/settings`.
- The `ChangePassphraseDialog` and `RecoveryKeyDialog` components themselves are NOT deleted, but their consumer surfaces differ:
  - `RecoveryKeyDialog` — currently consumed by both `header.tsx` AND `src/components/vault/recovery-key-banner.tsx` (rendered by `dashboard-shell.tsx`). After the refactor: the banner consumer remains; the new `/dashboard/settings/auth/recovery-key` page becomes the second consumer; the header stops triggering it.
  - `ChangePassphraseDialog` — currently consumed ONLY by `header.tsx:23, 172` (verified via grep). After the refactor: the new `/dashboard/settings/auth/passphrase` page MUST become the sole consumer or the component becomes dead code. This page-wrapping is mandatory, not optional.
- The dashboard `RecoveryKeyBanner` (which prompts users to set up a recovery key when they have not) is unchanged and remains the discovery surface for first-time recovery-key setup.
- Keep: email display, Travel Mode badge, Notifications, Theme toggle, Locale switcher, Sign Out.
- **Travel Mode badge decoupling**: the badge reads from the global `useTravelMode()` hook (`src/hooks/use-travel-mode.tsx`), which is keyed off `/api/travel-mode` GET. Moving the *configuration* card to `/dashboard/settings/vault/travel-mode` does NOT touch this hook or the badge. Both the badge and the new config page MUST share the same SWR cache key so mutations on the config page invalidate the badge state — no duplicated state.

### Dashboard sidebar (file: `src/components/layout/sidebar-section-security.tsx`)

The file currently exports three named sections (`SecuritySection`, `SettingsNavSection`, `ToolsSection`) consumed by `src/components/layout/sidebar-content.tsx`. To minimize churn:

- Keep the file path; rename only the export `SecuritySection` → `InsightsSection`.
- Update the import in `sidebar-content.tsx` accordingly.
- Visible label `Sidebar.securityGroup` → new key `Sidebar.insightsGroup` (Japanese: "インサイト"); the old key is retained until all consumers are confirmed migrated, then removed.
- Group contents reduced to: Watchtower + 監査ログ.
- 緊急アクセス promoted out of the group to a top-level sibling (because the recipient flow must stay shallow).
- The DOM landmark retains `aria-label="Security"` (English literal, NOT translated) for screen-reader search compatibility even though the visible label is "インサイト". This landmark exists ONLY on authenticated dashboard pages — no pre-auth disclosure.
- **Test rename scope (R3, R7)**: identifier propagation across the test suite is NOT just import-line changes. Run BOTH:
  - `grep -rn 'SecuritySection' src/` — covers imports and code references.
  - `grep -rn 'security section' src/ -i` — covers test descriptions like `"does not render SecuritySection for team Viewer"`.
  Both must be updated in the same commit. Affected files (verified via grep):
  - `src/components/layout/sidebar-content.tsx`
  - `src/components/layout/sidebar-content.test.tsx` (mock + 2 assertions)
  - `src/components/layout/sidebar-section-security.test.tsx` (10+ references)

### Settings sidebar restructure

Old structure (3 tabs):

```
Settings
├─ セキュリティ (sessions / passkey / travel-mode / key-rotation)
├─ 開発者 (cli-token / api-keys)
└─ MCP (connections / delegation)
```

New structure (6 sections):

```
個人の設定
├─ アカウント
│   ├─ プロフィール    (locale, theme, display name)
│   └─ 通知
├─ 本人認証
│   ├─ パスフレーズ    [moved from header]
│   ├─ 回復キー        [moved from header]
│   └─ パスキー        [moved from settings/security]
├─ デバイスとセッション
│   └─ アクティブデバイス  [renamed from sessions]
├─ 保管庫
│   ├─ キーローテーション  [moved from settings/security]
│   ├─ 委任セッション      [moved from settings/mcp]
│   └─ トラベルモード      [moved from settings/security]
├─ 共有と委任
│   └─ 緊急アクセス        [settings/configuration only; recipient flow stays in dashboard]
└─ 開発者
    ├─ CLI トークン        [moved from settings/developer]
    ├─ API キー            [moved from settings/developer]
    └─ MCP 接続            [moved from settings/mcp]
```

Files affected:
- `src/app/[locale]/dashboard/settings/layout.tsx` — rewrite tab definitions to 6-section sidebar.
- `src/app/[locale]/dashboard/settings/account/{profile,notifications}/page.tsx` — surface existing account/notification cards (already in product, currently scattered).
- `src/app/[locale]/dashboard/settings/auth/{passphrase,recovery-key,passkey}/page.tsx` — host the existing dialogs/cards as standalone pages where they make sense.
- `src/app/[locale]/dashboard/settings/devices/page.tsx` — host `SessionsCard`.
- `src/app/[locale]/dashboard/settings/vault/{key-rotation,delegation,travel-mode}/page.tsx` — host the existing cards.
- `src/app/[locale]/dashboard/settings/sharing/emergency-access/page.tsx` — emergency-access *configuration* (grant management); the recipient/grantor inbox stays at `/dashboard/emergency-access`.
- `src/app/[locale]/dashboard/settings/developer/{cli-token,api-keys,mcp-connections}/page.tsx` — consolidate.

**Page-level vault state checks**: existing dialogs (e.g. `ChangePassphraseDialog`) implicitly assumed the caller had already gated the open state on `vaultStatus === UNLOCKED` (the dropdown was only shown when unlocked). Hosting them as standalone pages removes that implicit gate. Each new page hosting a vault-sensitive operation MUST re-check `vaultStatus` at mount and render a "vault locked — please unlock" placeholder otherwise:
- `/auth/passphrase` — requires UNLOCKED (passphrase change)
- `/auth/recovery-key` — requires UNLOCKED (recovery key generation/rotation)
- `/vault/key-rotation` — requires UNLOCKED
- `/vault/delegation` — requires UNLOCKED
- `/vault/travel-mode` — disable toggle requires passphrase verification (existing behavior)
- `/auth/passkey` — does not require UNLOCKED (passkey registration is a sign-in concern, not a vault concern)
- `/devices` — does not require UNLOCKED (session management is independent)
- `/sharing/emergency-access` (config) — typically requires UNLOCKED for E2E key handling

**Per-item scope (personal vs tenant-admin)**: each settings sidebar item is scoped exclusively to the personal user's data. The Developer section's "MCP 接続" item shows the user's *personal* MCP client list — tenant-admin MCP client management remains in `/admin/tenant/mcp/clients` (unchanged). Sidebar rendering MUST filter items by the current user's role; if any item maps to a tenant-admin-only resource, it is hidden for non-admin users. Server-side authorization on the underlying API endpoints is unchanged — the sidebar is a UX filter, not a security control.

### URL redirect map (Next.js `redirects()` in `next.config.ts`)

The project uses `next-intl` with `localePrefix: "always"` (`src/i18n/routing.ts`), so every URL the browser hits is `/ja/...` or `/en/...`. Bare `source` patterns will NOT match. All redirect entries MUST use a locale capture group.

**Helper extraction (T21 fix)**: `next.config.ts` is heavily wrapped (`withSentryConfig(withNextIntl(nextConfig), ...)`), runs `execSync("git rev-parse --short HEAD")` at module-evaluation time, and is NOT directly importable as ESM in Vitest. Therefore the redirect-fan-out logic is extracted to a pure helper that BOTH `next.config.ts` AND tests import:

```ts
// src/lib/redirects/ia-redirects.ts (new file)
import { routing } from "@/i18n/routing";

export const IA_REDIRECTS = [
  { from: "/dashboard/settings/security",                   to: "/dashboard/settings/account" },
  { from: "/dashboard/settings/security/sessions",          to: "/dashboard/settings/devices" },
  { from: "/dashboard/settings/security/passkey",           to: "/dashboard/settings/auth/passkey" },
  { from: "/dashboard/settings/security/travel-mode",       to: "/dashboard/settings/vault/travel-mode" },
  { from: "/dashboard/settings/security/key-rotation",      to: "/dashboard/settings/vault/key-rotation" },
  { from: "/dashboard/settings/mcp/connections",            to: "/dashboard/settings/developer/mcp-connections" },
  { from: "/dashboard/settings/mcp/delegation",             to: "/dashboard/settings/vault/delegation" },
] as const;

export function buildLocaleRedirects() {
  return IA_REDIRECTS.flatMap(({ from, to }) =>
    routing.locales.map((locale) => ({
      source: `/${locale}${from}`,
      destination: `/${locale}${to}`,
      permanent: true, // 308
    }))
  );
}
```

`next.config.ts` consumes:

```ts
async redirects() {
  return buildLocaleRedirects();
}
```

Tests import `buildLocaleRedirects` directly. Both prod and tests use the same function — the test is NOT a tautology (it validates that the fan-out matches expected length × structure, with explicit per-entry assertions on `source`/`destination` shape).

`/dashboard/settings/developer/cli-token` and `/dashboard/settings/developer/api-keys` are unchanged; no redirect entry needed.

### Passkey enforcement allowlist update

`src/lib/proxy/page-route.ts:21-25` currently has:

```ts
const PASSKEY_EXEMPT_PREFIXES = ["/dashboard/settings/security"];
```

…and line 163 redirects passkey-required users to `/dashboard/settings/security`. With the redesign:

- `PASSKEY_EXEMPT_PREFIXES` MUST be updated to **`["/dashboard/settings/auth/passkey"]`** — exactly the passkey-registration path, NOT the broader `/auth/` prefix. The narrow scope is intentional: `/auth/passphrase` and `/auth/recovery-key` MUST NOT be reachable while passkey enforcement is pending, because those are vault-sensitive operations. The page-level `vaultStatus === UNLOCKED` checks (see "Page-level vault state checks") are defense-in-depth, but the proxy gate is the primary control.
- The redirect target on line 163 MUST be updated to `/dashboard/settings/auth/passkey` directly — NOT to a redirect-chained URL.

Without this fix, passkey-required users hit an infinite redirect loop and cannot register a passkey to satisfy enforcement (hard lockout). This is a Critical pre-condition for the IA migration.

### New components

- `LockVaultButton` (`src/components/layout/lock-vault-button.tsx`) — icon button, calls `vault.lock()`.
- `SettingsMigrationBanner` (`src/components/settings/migration-banner.tsx`) — dismissible, persists dismiss state via existing user-preference mechanism.
- `MovedPageNotice` (`src/components/settings/moved-page-notice.tsx`) — inline notice rendered on each redirected destination ("このページは『XXX』に移動しました"). Self-dismissing after first view per session.

### Migration banner persistence

- **Decision: localStorage** — matches existing precedent in the product. The `RecoveryKeyBanner` already uses `localStorage["psso:recovery-key-banner-dismissed"]` (`src/components/vault/recovery-key-banner.tsx:12`). Using the same mechanism keeps banner-state handling uniform across the codebase.
- Storage key: `psso:settings-ia-redesign-banner-dismissed` (follows the `psso:` namespace convention already in use).
- Cross-device dismiss is intentionally NOT a requirement — re-showing the banner once per device is acceptable for a one-time announcement. (Server-side dismiss would require a schema change; deferred unless cross-device is later requested.)
- **Sunset constant (testable)**: the 30-day sunset MUST be implemented as an injectable constant — NOT a hard-coded date inline.
  ```ts
  // src/components/settings/migration-banner-config.ts
  export const BANNER_SUNSET_TS = new Date("2026-06-15T00:00:00Z"); // set at PR merge time
  ```
  Tests use `vi.useFakeTimers()` (unit) or `page.clock.install({ time: ... })` (Playwright; supported since 1.45, project uses 1.58) to advance the clock and verify pre-sunset / post-sunset behavior. Without injection the 30-day cutoff is dead-code-by-design and a date-arithmetic bug surfaces only at day 30.
- **Date drift mitigation**: hard-coding the date is fragile if PR-merge slips. To prevent silent drift:
  1. The merge checklist MUST include "update `BANNER_SUNSET_TS` to `<merge_date> + 30 days`" as a pre-merge step.
  2. A CI assertion verifies the constant is within `<commit_timestamp> + [25..35]` days at PR-merge time. Implementation: a Vitest test that reads `git log -1 --format=%cI HEAD` (or uses the commit timestamp from CI env vars) and asserts the diff is in the expected range. The test is skipped on local runs (where `HEAD` may be old) and runs only in CI.
  3. Alternative considered: use `process.env.NEXT_PUBLIC_DEPLOY_TS` injected at build time. Rejected because CI builds without injecting deploy time would default to build time, which is acceptable but less precise than a hand-set merge date.
- **Sunset cleanup task**: the banner component, the localStorage key, the `BANNER_SUNSET_TS` constant, the `Migration.json` namespace file, AND the orphaned `Sessions.json` keys (tabSecurity etc.) are removed in a follow-up PR scheduled at sunset+1 week. Tracked via grep-able TODO comment with the sunset date.

### `MovedPageNotice` session scope

- "Once per session" = `sessionStorage`-scoped (per-tab). NOT `localStorage` (that would be once-per-browser-forever).
- Storage key per destination: `psso:settings-ia-moved-notice:<destination-path>` so each redirected destination shows once.
- **Dismissal semantics** (explicit to avoid the auto-dismiss-vs-click race):
  - The notice is **click-driven dismiss**, NOT auto-dismiss. The user must click an "✕" button to dismiss; on dismiss the sessionStorage key is set.
  - The notice is shown until either (a) the user clicks dismiss, OR (b) the user navigates to a different route (component unmount also sets the sessionStorage key).
  - On subsequent same-context navigations to the same destination, the key is read and the notice is hidden.
- E2E test pattern (per Playwright):
  - Same context, navigate to old URL → assert notice visible. User does NOT need to click dismiss.
  - Navigate elsewhere → unmount sets the key.
  - Navigate back to same destination → assert notice absent. (Confirms sessionStorage scope + unmount-set semantics.)
  - New context (`browser.newContext()`) → assert notice reappears. (Confirms it is NOT persisted in localStorage by accident.)
- The `{section}` interpolation value MUST come from the closed enum of section i18n keys (`Settings.section.account|auth|devices|vault|sharing|developer`). The notice component receives a typed enum value, not an arbitrary string. This prevents any future XSS surface via i18n placeholder if a developer adds `useTranslations().rich()` with custom HTML rendering.

### Migration audit log entry

- One audit event emitted per user on first dismissal of the migration banner (not on first authenticated request — that is too noisy for inactive users and creates a cron-like spike on deploy day).
- **Canonical action name**: `SETTINGS_IA_MIGRATION_V1_SEEN` (enum constant; serialized as `settings.ia_migration_v1_seen`).
- **Action name rationale**: `_seen` is honest about what is provable. The emission is a client-side `fetch` from the banner's dismiss handler, which is reachable from any same-origin authenticated XSS context. It does NOT prove user intent; it proves the client confirmed banner render. The action's i18n label MUST reflect this trust level (e.g. ja: "設定IA移行通知を確認" — "rendered the migration notice", not "acknowledged"). This addresses the audit non-repudiation gap raised in security review.
- **Endpoint**: reuse the existing `/api/internal/audit-emit/route.ts`. Do NOT introduce a new endpoint. The existing endpoint already provides:
  - `checkAuth(request)` — session-cookie authentication
  - Rate limiting (20/min/user via `audit-emit-rate-limiter`)
  - `bodySchema` validation with metadata size cap (4096 bytes)
  - `ALLOWED_ACTIONS` allowlist gate
  - CSRF gate compatibility — same-origin authenticated `fetch` with cookie passes the project's baseline `assertOrigin` check automatically (no extra token needed).
- **Required code changes for emission** (verified file paths and current behavior):

  1. **DB schema migration** (Prisma 7) — `prisma/schema.prisma` has `enum AuditAction { ... PASSKEY_ENFORCEMENT_BLOCKED ... }` (around line 847+). Add `SETTINGS_IA_MIGRATION_V1_SEEN` value. Generate migration via `npm run db:migrate`. The plan's prior claim of "no DB schema change" was incorrect; this single enum addition IS a schema change. It is reversible (drop the enum value), but rollback must occur AFTER any rows referencing the value are removed or the enum value must persist in code (see Rollback section).
  2. Add `SETTINGS_IA_MIGRATION_V1_SEEN` to (a) `AUDIT_ACTION` and (b) `AUDIT_ACTION_VALUES` in **`src/lib/constants/audit/audit.ts`** (the SSoT for `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUP`, `AUDIT_ACTION_GROUPS_PERSONAL/TEAM/TENANT`, and `AUDIT_SCOPE` — all in one file).
  3. **Add a new display group** `AUDIT_ACTION_GROUP.SETTINGS = "group:settings"` in the same file. Adding the new action to existing AUTH group would mis-tag a UX migration confirmation under "auth"; semantically incorrect. Register the action under `AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.SETTINGS]` only (display group ≠ subscription group, per R11). Add a `groupSettings` label to `messages/{ja,en}/AuditLog.json` (the existing `audit-i18n-coverage.test.ts:31-48` enforces a label for every group key, so omitting this fails the test).
  4. Add `AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN` to the `ALLOWED_ACTIONS` set in `src/app/api/internal/audit-emit/route.ts:16-19`.
  5. **i18n action label**: add to `messages/ja/AuditLog.json` and `messages/en/AuditLog.json` using the **uppercase snake-case key** that exactly matches the enum value: `"SETTINGS_IA_MIGRATION_V1_SEEN": "..."`. Verified: existing keys in `AuditLog.json` are uppercase snake (`AUTH_LOGIN`, `PASSKEY_ENFORCEMENT_BLOCKED`, etc.); `audit-i18n-coverage.test.ts:22` looks up the exact value of `AUDIT_ACTION` entry. Do NOT use a dotted form like `audit.settings.ia_migration_v1_seen` — that does not match the test or the existing convention. Suggested ja: `設定IA移行通知を確認`. Suggested en: `Settings IA migration notice rendered`.
  6. **Scope plumbing — REQUIRED route handler change**: the existing `bodySchema` at `src/app/api/internal/audit-emit/route.ts:44-47` does NOT accept a `scope` field, and the handler at line 82 hardcodes `scope: AUDIT_SCOPE.TENANT`. To emit `SETTINGS_IA_MIGRATION_V1_SEEN` as PERSONAL (so it appears in the user's personal audit log feed, not the tenant feed), the route handler MUST be extended:
     - Extend `bodySchema` to include `scope: z.enum(["PERSONAL", "TENANT"]).default("TENANT")` (the default preserves the existing `PASSKEY_ENFORCEMENT_BLOCKED` behavior — backward compatible).
     - Replace line 82's hardcoded `AUDIT_SCOPE.TENANT` with `parsed.data.scope` (mapped through `AUDIT_SCOPE`).
     - Add a per-action scope whitelist: for `SETTINGS_IA_MIGRATION_V1_SEEN`, reject any scope other than `PERSONAL`. Implementation: discriminated union on `action`, OR a `.refine()` on the parsed body.
  7. **Per-action `metadata` rejection** (security): the route handler MUST reject any request that includes a `metadata` field for `SETTINGS_IA_MIGRATION_V1_SEEN`. Without metadata, a same-origin XSS cannot use this action as an audit-write primitive for attacker-chosen content. Implementation: discriminated union on `action` keyed off the same union added for scope, OR a `.refine()` that asserts `metadata === undefined` for this specific action.
  8. **Idempotency strategy — pragmatic, no schema change**: server-side per-user idempotency was considered but requires either (a) a Prisma 7 partial unique index (only achievable via raw-SQL migration; Prisma schema syntax does not support `WHERE` on `@@unique`) OR (b) checking BOTH `audit_logs` AND `audit_outbox` before insert because the audit pipeline is async outbox→worker (CLAUDE.md "Audit outbox" section); a bare `EXISTS` on `audit_logs` is race-prone because the prior call's row may still be in `audit_outbox` PENDING.
     - **Decision**: implement client-side dedup ONLY. The banner emits the audit event on first dismiss (when `localStorage["psso:settings-ia-redesign-banner-dismissed"]` was unset). Subsequent banner re-renders + dismisses do not re-emit. The server retains the existing rate-limit (20/min/userId) and the new `metadata` rejection.
     - **Resulting bound on XSS spam**: 20 rows/min/user × duration of XSS. Each row contains only `action`, `userId`, `scope=PERSONAL`, timestamp — no attacker-controlled content (metadata rejected). Acceptable because the schema-level fix has cost > benefit for a one-time migration confirmation.
  9. **Anchor manifest is OUT-OF-SCOPE** for per-action work: `src/lib/audit/anchor-manifest.ts` is a generic JWS manifest builder/verifier that hash-chains all audit rows uniformly — there is no per-action allowlist to update. The new action gets external commitment automatically by virtue of being a regular row in `audit_logs`.
- **Existing tests that auto-cover** (verified by reading the files):
  - `src/__tests__/audit-i18n-coverage.test.ts` — iterates `AUDIT_ACTION_VALUES` and asserts a label exists in `messages/{ja,en}/AuditLog.json` for each. Also asserts a label exists for every `AUDIT_ACTION_GROUP` key (the new `groupSettings` label is enforced here). Once the new action and group are registered, this test fails until labels are added — exactly the desired behavior.
  - `src/lib/audit/audit-query.test.ts` — enforces enum→`VALID_ACTIONS` coverage.
  - `src/lib/audit/audit-action-key.test.ts` is **only 12 lines** and tests the `normalizeAuditActionKey()` helper (prefix stripping). It does NOT iterate `AUDIT_ACTION_VALUES`. Do NOT rely on it for coverage.
- **New unit tests required for this PR** (extending the existing `src/app/api/internal/audit-emit/route.test.ts` — that file already covers `ALLOWED_ACTIONS` gate for `PASSKEY_ENFORCEMENT_BLOCKED` and includes a "returns 400 when action is not in ALLOWED_ACTIONS" case; extend, don't duplicate):
  - Assert `AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN` is included in `ALLOWED_ACTIONS` (regression guard).
  - Assert POST with `action: SETTINGS_IA_MIGRATION_V1_SEEN, scope: PERSONAL` succeeds and emits a row with PERSONAL scope.
  - Assert POST with this action and `scope: TENANT` returns 400 (per-action whitelist).
  - Assert POST with this action and any `metadata` field returns 400 (per-action rejection).
  - Assert POST with `action: PASSKEY_ENFORCEMENT_BLOCKED` and no `scope` defaults to TENANT — backward-compat regression guard.
  - Add a unit test for `normalizeAuditActionKey("SETTINGS_IA_MIGRATION_V1_SEEN")` — confirm the helper does NOT strip a non-existent `AuditLog.` prefix and returns the input unchanged.
- **Banner dismiss handler**:
  ```ts
  // First dismiss only — client-side dedup via localStorage.
  // (Subsequent banner mounts return early before reaching the dismiss handler
  //  because the banner reads localStorage and hides itself; dismiss handler
  //  only fires when the user clicks "了解" on a freshly-mounted banner.)
  await fetch("/api/internal/audit-emit", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "SETTINGS_IA_MIGRATION_V1_SEEN",
      scope: "PERSONAL",
    }),
  });
  // Then set localStorage so subsequent loads skip the banner entirely.
  localStorage.setItem("psso:settings-ia-redesign-banner-dismissed", String(Date.now()));
  ```
  Failures MUST be observable (toast on retry-eligible 4xx/5xx, silent retry-on-next-session for transient failure). Do NOT swallow with `.catch(() => {})`.

### i18n keys (additions)

The `messages/` directory uses **per-namespace files** (`messages/{ja,en}/<Namespace>.json`), NOT flat top-level files. New namespaces are needed for some keys; others reuse existing namespaces. Audit confirmed via `ls messages/ja/`.

| Key | Target namespace file | ja | en |
|---|---|---|---|
| `Settings.section.account` | NEW `messages/{ja,en}/Settings.json` | アカウント | Account |
| `Settings.section.auth` | same | 本人認証 | Sign-in |
| `Settings.section.devices` | same | デバイスとセッション | Devices & sessions |
| `Settings.section.vault` | same | 保管庫 | Vault |
| `Settings.section.sharing` | same | 共有と委任 | Sharing & delegation |
| `Settings.section.developer` | same | 開発者 | Developer |
| `Dashboard.insightsGroup` | existing `messages/{ja,en}/Dashboard.json` (where `sidebar`, `watchtower`, `auditLog`, `emergencyAccess` already live) | インサイト | Insights |
| Lock button (header) | **REUSE existing `Vault.lockVault`** at `messages/ja/Vault.json:17` ("保管庫をロック") — no new key needed | 保管庫をロック | Lock vault |
| `Migration.banner.title` | NEW `messages/{ja,en}/Migration.json` | 個人の設定の構成を改善しました | Personal settings layout updated |
| `Migration.banner.body` | same | 旧URLは新しいページへ自動転送されます | Old URLs redirect to the new pages |
| `Migration.movedNotice` | same | このページは『{section}』に移動しました | This page moved to "{section}" |
| Audit action key `SETTINGS_IA_MIGRATION_V1_SEEN` (uppercase snake — exact match with enum value) | existing `messages/{ja,en}/AuditLog.json` (per `audit-i18n-coverage.test.ts:22` which looks up the exact value) | 設定IA移行通知を確認 | Settings IA migration notice rendered |
| Audit group key `groupSettings` (for new `AUDIT_ACTION_GROUP.SETTINGS`) | existing `messages/{ja,en}/AuditLog.json` (per `audit-i18n-coverage.test.ts:31-48` which iterates groups) | 設定 | Settings |

Notes on reuse and orphans:
- Existing `messages/{ja,en}/Sessions.json` keys (`tabSecurity`, `tabAccount`, `subTabPasskey`, `subTabTravelMode`, `subTabKeyRotation`, `subTabCli`, `subTabApi`, `subTabDelegation`, `tabSecurityDesc`) become orphans after the layout rewrite. They are NOT deleted in this PR; orphan removal is scheduled for the post-sunset cleanup PR (see Migration banner persistence section).
- New i18n namespace files (`Settings.json`, `Migration.json`) MUST be added under `src/i18n/messages.ts` namespace registry if such a registry exists (verify by reading `src/i18n/messages.ts` and `namespace-groups.ts`).

## Implementation steps

1. **Plan + review (this phase)** — produce plan + 3-expert review + manual test plan.
2. **Branch creation** from `main` after review is clean.
3. **DB migration** — in `prisma/schema.prisma`, add `SETTINGS_IA_MIGRATION_V1_SEEN` to `enum AuditAction`. Run `npm run db:migrate` to generate the Prisma migration. Single non-destructive enum addition; reversible (with caveats per Rollback section).
4. **Audit action + group registration** — in `src/lib/constants/audit/audit.ts`, add: (a) `SETTINGS_IA_MIGRATION_V1_SEEN` to `AUDIT_ACTION` and `AUDIT_ACTION_VALUES`; (b) NEW `AUDIT_ACTION_GROUP.SETTINGS = "group:settings"`; (c) `AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.SETTINGS] = [AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN]`. Add ja+en label for the action AND the new group in `messages/{ja,en}/AuditLog.json` (existing `audit-i18n-coverage.test.ts` will fail until done — desired). Anchor manifest is generic; no per-action update needed.
5. **Audit-emit route extension** — in `src/app/api/internal/audit-emit/route.ts`: (a) add `SETTINGS_IA_MIGRATION_V1_SEEN` to `ALLOWED_ACTIONS`; (b) extend `bodySchema` with optional `scope: z.enum(["PERSONAL","TENANT"]).default("TENANT")` (default preserves backward compat for existing `PASSKEY_ENFORCEMENT_BLOCKED`); (c) replace hardcoded `AUDIT_SCOPE.TENANT` at line 82 with the parsed scope; (d) per-action constraint — for `SETTINGS_IA_MIGRATION_V1_SEEN`, reject any `scope` other than `PERSONAL`, AND reject any `metadata` field. Implementation via discriminated union OR `.refine()`.
6. **Passkey enforcement allowlist** — update `src/lib/proxy/page-route.ts:21-25` (`PASSKEY_EXEMPT_PREFIXES` → `["/dashboard/settings/auth/passkey"]` — exactly the registration path, not the broader `/auth/` prefix) and `:163` (redirect target → `/dashboard/settings/auth/passkey`). CRITICAL pre-condition for the IA migration.
7. **i18n key additions** — per the i18n keys table in Technical approach. New namespace files: `messages/{ja,en}/Settings.json`, `messages/{ja,en}/Migration.json`. Existing files updated: `messages/{ja,en}/Dashboard.json` (insightsGroup), `messages/{ja,en}/AuditLog.json` (audit action label + new group label). Reuse existing `Vault.lockVault` for the header lock button — do NOT create a duplicate. Verify `src/i18n/messages.ts` and `namespace-groups.ts` are updated to register new namespaces if a registry exists.
8. **Shared redirect helper** — create `src/lib/redirects/ia-redirects.ts` exporting `IA_REDIRECTS` constant + `buildLocaleRedirects()` function. Used by `next.config.ts`, unit tests. Do NOT import `next.config.ts` directly in tests (it has side-effecting top-level `execSync`).
9. **New route directories** under `src/app/[locale]/dashboard/settings/` per the structure above. Each page composes existing card components — no business logic moves. Each vault-sensitive page re-checks `vaultStatus` at mount.
10. **Settings layout rewrite** — `settings/layout.tsx` switches from 3-tab to 6-section sidebar. Active-section highlight via `aria-current="page"` matches the deep route. Sidebar items filter by user role (personal vs tenant-admin scope).
11. **Dashboard sidebar refactor** — rename `SecuritySection` export → `InsightsSection`. Update import in `sidebar-content.tsx`. Move 緊急アクセス to top-level sibling. Preserve `aria-label="Security"` on the landmark. Update test files matching `grep -rn 'SecuritySection\|security section' src/ -i`.
12. **Header LockVaultButton** — new component; idempotent `onClick`; mobile-and-desktop tab order specified; remove dropdown items for passphrase/recovery; add settings link. Travel Mode badge unchanged (uses `useTravelMode()`).
13. **Recipient flow verification** — locate the existing emergency-access notification dispatch code (likely `src/app/api/emergency-access/[id]/request/route.ts` or related notification creation site). Confirm the notification record carries an `actionUrl` or equivalent that resolves to `/dashboard/emergency-access?focus={id}`. If not, scope-add the deep-link payload OR move the recipient-1-click requirement to a follow-up plan with a clearly recorded TODO.
14. **Next.js redirects** — extend `next.config.ts` to consume `buildLocaleRedirects()` from the helper. Verify by visiting both `/ja/...` and `/en/...` old URLs.
15. **MigrationBanner + MovedPageNotice** components — banner sunset via injectable `BANNER_SUNSET_TS` constant; notice scoped via sessionStorage per-destination; `{section}` interpolation from closed enum.
16. **Audit emission wiring** — banner dismiss handler `fetch('/api/internal/audit-emit', { action: 'SETTINGS_IA_MIGRATION_V1_SEEN', scope: 'PERSONAL' })`. Client-side dedup via localStorage. Failures surfaced (toast or retry-on-next-session), not swallowed.
17. **a11y review** — preserve ARIA landmarks, verify keyboard tab order (desktop + mobile separately).
18. **i18n CI gate** — leverage existing `messages-consistency.test.ts` for ja↔en parity. Add a new test (or extend existing) that scans `src/**/*.tsx` for `t("Settings.section.<x>")` calls and asserts each `<x>` exists in both locales — closes the "code references key but no file declares it" gap.
19. **Browser-extension references update** — enumerate via `grep -rn "/dashboard/settings" extension/` (verified to include `extension/src/__tests__/background.test.ts:2097, 2111, 2142`). Update extension test fixtures and any production code that does literal path-string match.
20. **E2E tests** — see Testing strategy.
21. **Manual test plan** at `docs/archive/review/personal-security-ia-redesign-manual-test.md` (per R35) including rollback specifics.
22. **Release notes / blog draft** — explain the move so users understand nothing is removed.

## Testing strategy

### Automated

- **Unit (Vitest)**:
  - i18n parity (existing `src/i18n/messages-consistency.test.ts` auto-covers once new keys are added).
  - i18n code-reference test (NEW): scan `src/**/*.tsx` for `t("Settings.section.<x>")` calls; assert each `<x>` exists in both locales.
  - `IA_REDIRECTS` constant correctness: each `from` maps to exactly one `to`; no duplicates; all paths start with `/dashboard/`; no path contains `//` (protocol-relative), `\` (backslash), or whitespace; no path starts with `https://` or `//`.
  - **Generated redirect output test** (RT3 + RT2): import `buildLocaleRedirects` from `src/lib/redirects/ia-redirects.ts`; call it; assert the result has length `IA_REDIRECTS.length × routing.locales.length` and each entry's `source`/`destination` matches `/${locale}${from}` / `/${locale}${to}`. This catches "forgot to fan out, only `/ja` redirected" bugs that a constant-only test cannot. (Do NOT attempt to import `next.config.ts` directly — that file runs `execSync` at evaluation time and is wrapped by `withSentryConfig` + `withNextIntl`.)
  - `LockVaultButton` renders only when `vaultStatus === VAULT_STATUS.UNLOCKED` (mocked via the real `VAULT_STATUS` const imported from `src/lib/vault/vault-context.tsx`, NOT string literals — RT1).
  - `LockVaultButton.onClick` is a no-op when `vaultStatus !== UNLOCKED` (race defense).
  - `MigrationBanner` shown logic: pre-sunset & not-dismissed → shown; pre-sunset & dismissed → hidden; post-sunset → hidden regardless. Use `vi.useFakeTimers()` to advance.
  - `BANNER_SUNSET_TS` CI freshness: in CI mode (`process.env.CI === "true" && process.env.GITHUB_EVENT_NAME === "pull_request"`), assert `BANNER_SUNSET_TS - HEAD_commit_timestamp` is within `[25, 35]` days. The test must run under `node` test environment (not jsdom) to use `child_process.execSync("git log -1 --format=%cI HEAD")`. Skipped on local runs and on non-PR CI events. The PR pipeline must NOT use shallow clone with `fetch-depth: 1` for this test to be meaningful — verify and bump to `fetch-depth: 0` (or rely on the merge-commit timestamp from the GitHub API instead).
  - Audit action `SETTINGS_IA_MIGRATION_V1_SEEN`:
    - Auto-asserted to be in `AUDIT_ACTION_VALUES` (covered by existing `src/__tests__/audit-i18n-coverage.test.ts`).
    - NEW assertion (this PR): `ALLOWED_ACTIONS` set in `src/app/api/internal/audit-emit/route.ts` includes `AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN`. No existing test covers this — must add.
    - NEW assertion: per-action body schema rejects requests with a `metadata` field for this action (S11 fix).
    - NEW assertion (banner component test, NOT server-side): banner component reads `localStorage["psso:settings-ia-redesign-banner-dismissed"]` and does NOT re-emit when the key is set. Server-side per-user idempotency is intentionally NOT enforced (per design decision in Migration audit log entry section).
- **Integration (real DB, `npm run test:integration`)**:
  - **NEW file** `src/__tests__/db-integration/audit-emit-settings-ia.integration.test.ts` (matches existing convention: all real-DB integration tests live under `src/__tests__/db-integration/` and use `helpers.ts`'s `createTestContext` / `createPrismaForRole`. The `vitest.integration.config.ts` include glob `src/**/*.integration.test.ts` covers either location, but the directory convention matters for test helper imports):
    - Banner dismiss `POST /api/internal/audit-emit` with action `SETTINGS_IA_MIGRATION_V1_SEEN` and scope `PERSONAL`: emits one row to `audit_outbox`; rate limit applies; non-allowlisted action returns 400 (regression guard for `ALLOWED_ACTIONS` gate).
    - Per-action scope whitelist: POST with `action: SETTINGS_IA_MIGRATION_V1_SEEN, scope: TENANT` returns 400.
    - `metadata` field rejection: POST with `metadata` field for the action returns 400.
    - Backward compatibility: POST with `action: PASSKEY_ENFORCEMENT_BLOCKED` and no `scope` field still emits with TENANT scope (default).
    - Authentication: missing session → 401.
    - Note: per-user idempotency is NOT enforced server-side (per design decision in Migration audit log entry section); client-side dedup via localStorage is the primary control. Concurrent POSTs may emit multiple rows; the only bound is the rate limit. If business needs change, add a partial unique index in a follow-up migration.
  - Settings landing page renders with new section list.
- **E2E (Playwright)** — at `e2e/tests/settings-ia-redirects.spec.ts` (and tagged appropriately):
  - **Mobile projects** added to `e2e/playwright.config.ts`: `{ name: "mobile-ios", use: devices["iPhone 13"] }` and `{ name: "mobile-android", use: devices["Pixel 7"] }`. Project uses Playwright 1.58 (devices catalog supported).
  - **CI walltime mitigation**: existing 28 specs do NOT run on the mobile projects by default (the project config sets `fullyParallel: false, workers: 1` — running everything 3× would triple CI time). Mobile-specific tests are tagged with `@mobile` (Playwright tag annotation `test("...", { tag: "@mobile" }, ...)`) and the chromium project uses `--grep-invert "@mobile"` to skip them; mobile projects use `--grep "@mobile"` to run only those tests.
  - Parameterized over `IA_REDIRECTS` × `routing.locales`. Per pair: visit `/${locale}${from}` → assert final URL is `/${locale}${to}` and `MovedPageNotice` is visible once per session.
  - Same-context navigate-away-and-back: `MovedPageNotice` does NOT re-appear after unmount (sessionStorage scope assertion). Click-driven dismiss is NOT exercised here (a separate test covers it).
  - New context (`browser.newContext()`): `MovedPageNotice` reappears (NOT localStorage by accident).
  - Header `LockVaultButton`: click locks vault, status badge updates, page route unchanged.
  - Header `LockVaultButton` HIDDEN when vault is locked (inverse coverage; use existing locked-vault fixture).
  - `@mobile` test: `LockVaultButton` is tappable in 1 tap on mobile-ios and mobile-android viewports.
  - Migration banner: shows once per device (localStorage), dismissable. Sunset behavior tested via `page.clock.install()` advancing past `BANNER_SUNSET_TS`.
  - aria-label "Security" present on the renamed-Insights landmark, on both ja and en.
  - Notification → 緊急アクセス deep link with `?focus={id}` query param preserved.
  - Settings sidebar active-section highlight: navigate to each deep route; assert the corresponding sidebar link has `aria-current="page"`.
  - Tenant-admin scenario (using existing `e2e/helpers/fixtures.ts:33` `tenantAdmin` fixture): both `個人の設定` and `管理コンソール` links visible; `/dashboard/settings/*` shows no admin-only items; `/admin/*` shows no personal-only items.
  - **Network leakage assertion** (S12 fix): navigating to `/dashboard/settings/*` as a non-admin emits ZERO requests to `/api/tenant/**` or `/api/admin/**`. Use Playwright's `page.on("request", ...)` listener to fail the test if any matching request is observed during sidebar render.
- **No snapshot tests** for sidebar or header — covered by role-based queries (`getByRole`, `aria-current`, `aria-label`). Documented decision per project testing convention; snapshots are too fragile against i18n label changes.

### Manual

Per R35 (production-deployed component, Tier-1 IA refactor): produce `docs/archive/review/personal-security-ia-redesign-manual-test.md` with sections — Pre-conditions, Steps, Expected, Rollback. Must include:

- Full-coverage walk: every entry in `IA_REDIRECTS` leads to its new destination on both `/ja/` and `/en/`.
- Locked + unlocked vault states for header (LockVaultButton presence, dropdown content).
- Screen-reader walk (NVDA on Windows OR VoiceOver on macOS) confirming landmarks resolve via `D` (next landmark) and search by name "Security" still locates the renamed Insights group.
- Mobile (iOS Safari + Android Chrome) header lock button tap — confirm 1 tap.
- A user who is also a tenant admin: confirm 個人の設定 sidebar does not bleed admin items, and 管理コンソール does not bleed personal items.
- Browser extension deep-link resolution after `extension/src/__tests__/background.test.ts` fixtures are updated.
- **Rollback specifics** (new section):
  1. Procedure: `git revert <merge-commit>` and redeploy. The Prisma migration adding `SETTINGS_IA_MIGRATION_V1_SEEN` to `enum AuditAction` is NOT auto-reverted.
  2. Residual state — explicitly OK to leave behind:
     - `localStorage["psso:settings-ia-redesign-banner-dismissed"]` survives rollback. Irrelevant for old UI (key is unread).
     - `localStorage["psso:settings-ia-moved-notice:*"]` survives rollback. Irrelevant for old UI.
     - `audit_logs` rows with action `SETTINGS_IA_MIGRATION_V1_SEEN` survive rollback. This is intentional — audit log is immutable.
     - The `enum AuditAction.SETTINGS_IA_MIGRATION_V1_SEEN` value persists in the DB even after rollback. Removing it requires a follow-up migration AND removing all rows referencing it (forbidden by audit-log immutability). Conclusion: the enum value stays in DB.
  3. **Rollback compatibility constraint**: when the IA refactor itself is reverted via `git revert`, the rollback PR MUST manually re-add `SETTINGS_IA_MIGRATION_V1_SEEN` to (a) `AUDIT_ACTION` and `AUDIT_ACTION_VALUES` in `src/lib/constants/audit/audit.ts`, (b) `messages/{ja,en}/AuditLog.json` label, (c) `AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.SETTINGS]` (or wherever it was registered), AND keep `AUDIT_ACTION_GROUP.SETTINGS` enum + `groupSettings` label — because the original commit removed BOTH the IA refactor AND the enum entries, but the enum entries must persist or the verifier rejects the existing audit rows. This is a ~10-line manual fixup that the rollback PR description must spell out.
  4. Native old-URL behavior post-revert: 308 redirect entries are removed by the revert; old paths resolve directly to the old pages (which exist in the reverted code).

## Considerations & constraints

### Out of scope (deferred to separate plans)

- **Cmd-K command palette** — separate feature, ~10× the scope of this PR. Track as a follow-up.
- **Sign-up flow recovery key generation** — UX flow change in onboarding, separate from IA. Track as a follow-up.
- **Linked accounts UI** — no current backend support; revisit when OAuth-link management is implemented.
- **Watchtower expansion** (login history, breach alerts) — content additions to Insights group, separate plan.
- **Tenant-admin spillover cleanup** — separate audit of `/admin` console; not tied to personal-settings IA.
- **Operator-token / break-glass routing review** — admin scope, separate.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Trust erosion ("did they remove this?") | Migration audit log entry; in-page MovedPageNotice; banner; release notes |
| External deep-link breakage | 308 redirects for every old route, locale-aware via `:locale(ja\|en)` capture |
| Passkey enforcement infinite loop | `PASSKEY_EXEMPT_PREFIXES` and redirect target updated in same PR (Critical pre-condition) |
| Audit endpoint reuse leakage | Reuse existing `/api/internal/audit-emit` with extended `ALLOWED_ACTIONS`; no new endpoint introduced |
| Audit chain coverage gap | Anchor manifest hash-chains all rows uniformly (no per-action allowlist exists); existing `audit-i18n-coverage.test.ts` enforces enum + group label coverage |
| Banner emission XSS forgery | Action name `_seen` honestly reflects client-attested render confirmation; audit label states the trust level explicitly |
| i18n drift across 6 new sections | Existing `messages-consistency.test.ts` for parity; new code-grep test for code-references-key gaps |
| a11y regression | Preserve `aria-label="Security"` etc. on landmarks; keyboard tab order verified separately for desktop and mobile |
| Mobile lock affordance missed | New `mobile-ios` + `mobile-android` Playwright projects; manual test on iOS Safari + Android Chrome |
| Power-user (developer) friction | "開発者" promoted to top-level section, same depth as before |
| Recipient flow regression | Emergency-access recipient surface stays at `/dashboard/emergency-access` (unchanged); only configuration moves; deep-link mechanism verified pre-merge |
| Banner / notice shown to wrong audience | Per-device localStorage dismiss; sunset injection makes 30-day cutoff testable; sunset cleanup PR scheduled |
| LockVaultButton race (auto-lock during render) | `onClick` handler early-returns if `vaultStatus !== UNLOCKED`; toast only on successful UNLOCKED→LOCKED transition |
| Travel Mode badge state divergence | Single SWR cache key `/api/travel-mode` shared by badge and config page; mutations invalidate the same key |
| Sidebar admin item leakage | Each item declares scope (personal vs tenant-admin); sidebar filters by user role; underlying API authorization unchanged |
| Test rename incompleteness | Run `grep -rn 'SecuritySection\|security section' src/ -i` before final commit to catch test-description references |
| Extension fixture drift | Step 17 enumerates `extension/src/**/*.ts` references; explicit fixture updates |
| Hard-coded sunset date drift | CI assertion: `BANNER_SUNSET_TS - HEAD_commit_timestamp ∈ [25, 35]` days; merge-checklist update |
| Audit endpoint widened to user-triggerable action (XSS audit-write primitive) | `metadata` field rejected for new action; per-user idempotency at most one row; rate limit 20/min unchanged |
| Sidebar render leaks tenant-admin API requests for non-admin | E2E network-watcher asserts zero `/api/tenant/**` or `/api/admin/**` requests during settings sidebar render |
| `IA_REDIRECTS` future protocol-relative or absolute URL | Unit test guards `from`/`to` start with `/dashboard/`, no `//` after position 0 |
| `ChangePassphraseDialog` orphaned (no consumer if not re-wrapped) | Plan explicitly requires wrapping in new `/auth/passphrase` page; verified ChangePassphraseDialog has only header consumer today |
| Mobile Playwright projects 3× CI walltime | Mobile-tagged tests only run under mobile projects (`@mobile` tag + grep filter) |
| Audit scope misrouting | Emission body explicitly includes `scope: AUDIT_SCOPE.PERSONAL` |

### Known dependencies

- **DB schema**: ONE Prisma enum addition (`enum AuditAction` adds `SETTINGS_IA_MIGRATION_V1_SEEN`). Single non-destructive migration. Reversible.
- **API changes**: ONE existing endpoint extended — `/api/internal/audit-emit` `bodySchema` gains optional `scope` field (default `TENANT` preserves existing `PASSKEY_ENFORCEMENT_BLOCKED` behavior); `ALLOWED_ACTIONS` set extended with one entry. New action's body schema rejects `metadata`. No new endpoints. Backward compatible: existing callers continue to work without change.
- **No crypto / auth / authz logic changes** to authentication flow itself; only the location of related UI surfaces.
- localStorage is used for client-side dedup of the migration banner.

## User operation scenarios

### Scenario 1 — Returning user, first session post-deploy

1. User signs in, lands on `/ja/dashboard`.
2. `MigrationBanner` appears once: "個人の設定の構成を改善しました [詳細]".
3. User clicks "詳細" → modal explains the new IA, offers "了解" to dismiss.
4. Audit log entry `SETTINGS_IA_MIGRATION_V1_SEEN` (serialized: `settings.ia_migration_v1_seen`) recorded via `/api/internal/audit-emit`.
5. localStorage `psso:settings-ia-redesign-banner-dismissed` set; banner does not re-appear on this device until `BANNER_SUNSET_TS` (30 days post-deploy).

### Scenario 2 — Bookmark to old URL

1. User opens browser bookmark `/dashboard/settings/security/passkey`.
2. Server returns 308 → `/dashboard/settings/auth/passkey`.
3. New page renders with `MovedPageNotice` at the top: "このページは『本人認証 > パスキー』に移動しました".
4. Notice is dismissable; once-per-session.

### Scenario 3 — User wants to lock vault

1. User on any authenticated page, vault unlocked.
2. Header shows 🔒 icon next to avatar.
3. Click → vault locks → vault status indicator updates → toast "保管庫をロックしました".
4. Mobile: same icon visible in mobile header bar, single tap.

### Scenario 4 — User wants to change passphrase (low frequency)

1. User clicks avatar → "個人の設定 →".
2. Lands on `/dashboard/settings/account` (settings index).
3. Sidebar shows 6 sections; user clicks "本人認証" → "パスフレーズ".
4. Path: 3 clicks (header avatar / settings / passphrase). Acceptable for an annual-frequency operation.

### Scenario 5 — Power user rotates an API key

1. Header avatar → 個人の設定.
2. Sidebar: 開発者 → API キー (top-level section, no nesting under "Developer tab").
3. Same depth as the current Settings > 開発者 > API キー path. No regression.

### Scenario 6 — Recipient receives emergency access notification

1. Notification badge in header → click.
2. Deep link → `/dashboard/emergency-access?focus={id}` (unchanged from current).
3. Recipient flow has zero added friction.

### Scenario 7 — User is also a tenant admin

1. Sidebar shows both "個人の設定" and "管理コンソール" links.
2. Personal settings: only personal-scoped items.
3. Admin console: tenant-scoped items (Members, Operator Tokens, etc.) — unchanged.
4. No item appears in both. Audit log split: `/dashboard/audit-logs` = personal; `/admin/tenant/audit-logs` = tenant.

### Scenario 8 — Screen-reader user navigating settings

1. User presses landmark navigation (e.g. NVDA `D`).
2. Lands on `<nav aria-label="Security">` even though visible label is "インサイト".
3. Search by category term still works regardless of visual rename.

### Scenario 9 — Travel Mode active state visibility

1. User enabled Travel Mode last week.
2. Today, on any page, header shows orange "✈ Travel" badge globally.
3. Configuration panel has moved to Settings > 保管庫 > トラベルモード, but the active-state indicator persists in the header.

### Scenario 10 — Browser extension deep link

1. Browser extension popup links to `/dashboard/settings/security/passkey` to manage passkeys.
2. The 308 redirect resolves to `/dashboard/settings/auth/passkey`.
3. Extension flow continues without code change. (Out of scope: updating the extension's link target — tracked as follow-up if extension code is touched in same PR window.)

## Naming summary (final labels)

| Section | ja | en |
|---|---|---|
| (settings root) | 個人の設定 | Personal settings |
| (sub) | アカウント | Account |
| (sub) | 本人認証 | Sign-in |
| (sub) | デバイスとセッション | Devices & sessions |
| (sub) | 保管庫 | Vault |
| (sub) | 共有と委任 | Sharing & delegation |
| (sub) | 開発者 | Developer |
| (sidebar) | インサイト | Insights |
| (header) | 保管庫をロック | Lock vault |

The visible label "セキュリティ" is removed from settings tabs but preserved as an `aria-label` for accessibility/search continuity.

## Implementation Checklist (Step 2-1 output)

### Files to create (~20 new)

| Path | Purpose |
|---|---|
| `prisma/migrations/<ts>_add_settings_ia_migration_v1_seen/migration.sql` | DB enum addition |
| `src/lib/redirects/ia-redirects.ts` | IA_REDIRECTS const + buildLocaleRedirects() |
| `src/lib/redirects/ia-redirects.test.ts` | Constant correctness + generated output test |
| `src/components/layout/lock-vault-button.tsx` | Header icon button |
| `src/components/layout/lock-vault-button.test.tsx` | Render gate + idempotency tests |
| `src/components/settings/migration-banner.tsx` | One-time announcement, localStorage dismiss |
| `src/components/settings/migration-banner.test.tsx` | Sunset + dismiss + dedup tests |
| `src/components/settings/migration-banner-config.ts` | `BANNER_SUNSET_TS` injectable constant |
| `src/components/settings/migration-banner-config.test.ts` | CI freshness assertion (node env, PR-only) |
| `src/components/settings/moved-page-notice.tsx` | Per-destination sessionStorage notice |
| `src/components/settings/moved-page-notice.test.tsx` | Click + unmount + new-context tests |
| `messages/{ja,en}/Settings.json` | New section labels (6 sections) |
| `messages/{ja,en}/Migration.json` | Banner + notice copy |
| `src/app/[locale]/dashboard/settings/account/{profile,notifications}/page.tsx` | New |
| `src/app/[locale]/dashboard/settings/auth/{passphrase,recovery-key,passkey}/page.tsx` | Wrap existing dialogs/cards |
| `src/app/[locale]/dashboard/settings/devices/page.tsx` | Hosts SessionsCard |
| `src/app/[locale]/dashboard/settings/vault/{key-rotation,delegation,travel-mode}/page.tsx` | Move existing cards |
| `src/app/[locale]/dashboard/settings/sharing/emergency-access/page.tsx` | Emergency access config (config-only; recipient flow stays at /dashboard/emergency-access) |
| `src/app/[locale]/dashboard/settings/developer/mcp-connections/page.tsx` | Hosts McpConnectionsCard |
| `src/__tests__/db-integration/audit-emit-settings-ia.integration.test.ts` | Real-DB integration test |
| `e2e/tests/settings-ia-redirects.spec.ts` | Parameterized redirect E2E |
| `e2e/tests/lock-vault-button.spec.ts` | Header lock button E2E (incl. `@mobile`) |
| `e2e/tests/migration-banner.spec.ts` | Banner E2E with `page.clock.install()` |
| `docs/archive/review/personal-security-ia-redesign-manual-test.md` | R35 artifact |

### Files to modify (~15 existing)

| Path | Change | Risk |
|---|---|---|
| `prisma/schema.prisma:976` | Add `SETTINGS_IA_MIGRATION_V1_SEEN` to `enum AuditAction` | Schema migration |
| `src/lib/constants/audit/audit.ts:154,323,588` | Add to `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, NEW `AUDIT_ACTION_GROUP.SETTINGS`, `AUDIT_ACTION_GROUPS_PERSONAL` | Enum coverage |
| `src/app/api/internal/audit-emit/route.ts:16,44,82` | `ALLOWED_ACTIONS` extension; `bodySchema` scope field; per-action constraints | API contract |
| `src/app/api/internal/audit-emit/route.test.ts:57+` | Extend test cases for new action + scope + metadata rejection | Test |
| `src/lib/proxy/page-route.ts:23,163` | `PASSKEY_EXEMPT_PREFIXES` narrow + redirect target | Critical pre-cond |
| `messages/{ja,en}/AuditLog.json` | Add action label + new `groupSettings` group label | i18n coverage test |
| `messages/{ja,en}/Dashboard.json` | Add `insightsGroup` key | i18n |
| `next.config.ts` | Wire `buildLocaleRedirects()` into `redirects()` | Build artifact |
| `src/components/layout/header.tsx:23,24,45,46,115-165` | Remove dropdown vault items + dialogs; add LockVaultButton | UI |
| `src/components/layout/sidebar-section-security.tsx` | Rename export `SecuritySection`→`InsightsSection`; reduce contents to Watchtower + 監査ログ | UI |
| `src/components/layout/sidebar-content.tsx` | Update import; consume `InsightsSection`; add 緊急アクセス top-level | UI |
| `src/components/layout/sidebar-content.test.tsx` | Mock + descriptors update | Test |
| `src/components/layout/sidebar-section-security.test.tsx` | 10+ identifier renames | Test |
| `src/hooks/sidebar/use-sidebar-navigation-state.test.ts` | Settings URL update | Test |
| `src/app/[locale]/dashboard/settings/layout.tsx` | 3-tab → 6-section sidebar; `aria-current="page"`; role filter | UI |
| `src/app/[locale]/dashboard/settings/page.tsx` | Settings index → redirect to /account | UI |
| `src/components/vault/delegation-revoke-banner.tsx` | Update settings/security URL reference if any | UI |
| `extension/src/__tests__/background.test.ts:2097,2111,2142` | Test fixture URL update | Test |
| `e2e/page-objects/settings.page.ts` | URL update | Test |
| `e2e/playwright.config.ts` | Add `mobile-ios` + `mobile-android` projects with `@mobile` grep filter | CI |

### Existing routes to remove (after redirects in place)

`src/app/[locale]/dashboard/settings/{security,mcp}/` and all sub-paths. Existing pages there migrate to new locations as described above.

### Shared utilities to reuse (NOT reimplement)

| Surface | Source | Notes |
|---|---|---|
| Vault lock | `src/lib/vault/vault-context.tsx:1042` `useVault().lock()` | Don't add new lock primitive |
| Vault status enum | `src/lib/vault/vault-context.tsx` `VAULT_STATUS` | Use the const, never string literals |
| Travel Mode hook | `src/hooks/use-travel-mode.tsx` | Already SWR-keyed off `/api/travel-mode` |
| Audit emission | `/api/internal/audit-emit/route.ts` (`logAuditAsync`) | Extend, do NOT create parallel route |
| Audit action SSoT | `src/lib/constants/audit/audit.ts` (single file) | All audit constants in this one file |
| Existing dialogs | `src/components/vault/{change-passphrase-dialog,recovery-key-dialog}.tsx` | Wrap as page bodies, do NOT recreate |
| Banner localStorage pattern | `src/components/vault/recovery-key-banner.tsx:12` `psso:` prefix | Follow same pattern |
| i18n parity test | `src/i18n/messages-consistency.test.ts` + `audit-i18n-coverage.test.ts` | Auto-covers once registered |
| Existing test fixtures | `e2e/helpers/fixtures.ts` (`vaultReady`, `tenantAdmin`, etc.) | Use these, don't create new |

### Patterns that MUST be followed across all sites

- Vault-sensitive pages re-check `vaultStatus === UNLOCKED` at mount and render placeholder otherwise.
- All client `fetch` to `/api/internal/audit-emit` uses `credentials: "same-origin"`, includes `scope: "PERSONAL"`, never includes `metadata` for the new action.
- Sidebar items declare scope (personal/admin) and filter render by user role.
- Test mocks for `useVault` import the real `VAULT_STATUS` const, never inline string literals.
- `aria-label="Security"` literal preserved on the renamed Insights landmark for SR search compat.
- Locale-aware redirects use `routing.locales` fan-out — never bare paths.

### Implementation batches (proposed)

| # | Name | Steps | Depends on | Estimated files |
|---|---|---|---|---|
| 1 | Foundation | DB migration, AUDIT_ACTION + group registration, audit-emit route extension, passkey allowlist | — | 5-7 |
| 2 | i18n + helpers | Settings/Migration/Dashboard/AuditLog message files, redirect helper | 1 | 7-9 |
| 3 | UI components | LockVaultButton, MigrationBanner, MovedPageNotice + tests | 2 | 6 |
| 4 | Page structure | Settings layout rewrite, 12 new pages, dashboard sidebar refactor | 2 | 15+ |
| 5 | Wiring | Header changes, next.config redirects, banner emission, extension fixtures | 3+4 | 5 |
| 6 | Tests | Unit/integration/E2E (parameterized redirects, mobile, banner, a11y) | 5 | 6+ |
| 7 | Final | Manual test plan, release notes; lint+test+build gate | 6 | 2 |
