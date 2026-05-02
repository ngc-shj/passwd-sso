# Manual Test Plan — admin-ia-redesign

R35 artifact for Tier-1 (UI surface) deployment-affecting change.

## Pre-conditions

- Local dev DB up to date with migrations.
- Two locales available (`/ja/`, `/en/`).
- Three test users:
  - `<test-user-email>` — vault setup + unlocked, personal-only (non-admin).
  - `<tenant-admin-email>` — vault setup + unlocked, ADMIN role.
  - `<team-owner-email>` — vault setup + unlocked, owner of at least one team.
- Browser with DevTools (Chrome or Firefox).
- Screen reader available for step 7 (NVDA on Windows / VoiceOver on macOS).
- Mobile emulation via DevTools (iPhone 13: 390×844, Pixel 7: 412×915).

## Steps

### 1. Foundation health check

| Step | Action | Expected |
|---|---|---|
| 1.1 | `npx vitest run` | All unit tests pass |
| 1.2 | `npx next build` | Build succeeds with no TypeScript errors |
| 1.3 | `npm run lint` | No ESLint errors |

### 2. Tenant sidebar — 7-item structure

Sign in as `<tenant-admin-email>`, navigate to `/ja/admin/tenant/members`.

| Step | Action | Expected |
|---|---|---|
| 2.1 | Inspect sidebar | 7 top-level items: メンバー / チーム / マシンID / ポリシー / 連携 / 監査ログ / ブレイクグラス |
| 2.2 | Click マシンID | Expands to show: サービスアカウント / MCP クライアント / 運用者トークン |
| 2.3 | Click ポリシー | Expands to show: 認証ポリシー / マシンID ポリシー / データ保存 / アクセス制御 |
| 2.4 | Click 連携 | Expands to show: プロビジョニング / Webhook / 監査ログ配信 |
| 2.5 | Click 監査ログ | URL `/ja/admin/tenant/audit-logs`; page renders without error |
| 2.6 | Click ブレイクグラス | URL `/ja/admin/tenant/breakglass`; page renders without error |

### 3. Team sidebar — 6-leaf structure

Sign in as `<team-owner-email>`, navigate to `/ja/admin/teams/{teamId}/general`.

| Step | Action | Expected |
|---|---|---|
| 3.1 | Inspect sidebar | 6 items: 全般 / メンバー / ポリシー / キーローテーション / Webhook / 監査ログ |
| 3.2 | Confirm no "Security" group | The old "Security" group with 3 children is gone |
| 3.3 | Click メンバー | URL `/admin/teams/{teamId}/members`; member list rendered; "メンバーを追加" button visible in page (not as sidebar item) |
| 3.4 | Click "オーナー権限を移譲" link | Navigates to `/admin/teams/{teamId}/members/transfer-ownership` |
| 3.5 | Click ポリシー | URL `/admin/teams/{teamId}/policy`; policy form visible |
| 3.6 | Click キーローテーション | URL `/admin/teams/{teamId}/key-rotation`; typed-confirm gate visible |
| 3.7 | Click Webhook | URL `/admin/teams/{teamId}/webhooks`; webhook list visible |

### 4. Group-landing redirects

| Step | Input URL | Expected final URL |
|---|---|---|
| 4.1 | `/ja/admin/tenant/machine-identity` | `/ja/admin/tenant/machine-identity/service-accounts/accounts` |
| 4.2 | `/ja/admin/tenant/machine-identity/service-accounts` | `/ja/admin/tenant/machine-identity/service-accounts/accounts` |
| 4.3 | `/ja/admin/tenant/policies` | `/ja/admin/tenant/policies/authentication/password` |
| 4.4 | `/ja/admin/tenant/policies/authentication` | `/ja/admin/tenant/policies/authentication/password` |
| 4.5 | `/ja/admin/tenant/policies/machine-identity` | `/ja/admin/tenant/policies/machine-identity/token` |
| 4.6 | `/ja/admin/tenant/integrations` | `/ja/admin/tenant/integrations/provisioning/scim` |
| 4.7 | `/ja/admin/tenant/integrations/provisioning` | `/ja/admin/tenant/integrations/provisioning/scim` |

### 5. Sub-tab navigation

#### 5a. /policies/authentication

| Step | Action | Expected |
|---|---|---|
| 5a.1 | Navigate to `/ja/admin/tenant/policies/authentication/password` | Tab bar shows: パスワード / セッション / パスキー / ロックアウト; パスワード active |
| 5a.2 | Click セッション | URL changes to `.../session`; page content updates |
| 5a.3 | Click パスキー | URL changes to `.../passkey` |
| 5a.4 | Click ロックアウト | URL changes to `.../lockout` |

#### 5b. /policies/machine-identity

| Step | Action | Expected |
|---|---|---|
| 5b.1 | Navigate to `/ja/admin/tenant/policies/machine-identity/token` | Tab bar shows: トークン / 委任; トークン active |
| 5b.2 | Click 委任 | URL changes to `.../delegation` |

#### 5c. /integrations/provisioning

| Step | Action | Expected |
|---|---|---|
| 5c.1 | Navigate to `/ja/admin/tenant/integrations/provisioning/scim` | Tab bar shows: SCIM / ディレクトリ同期; SCIM active |
| 5c.2 | Click ディレクトリ同期 | URL changes to `.../directory-sync` |

### 6. 404 on old URLs

| Step | Old URL | Expected |
|---|---|---|
| 6.1 | `/ja/admin/tenant/security/session-policy` | 404 page |
| 6.2 | `/ja/admin/tenant/operator-tokens` | 404 page |
| 6.3 | `/ja/admin/tenant/audit-logs/breakglass` | 404 page |
| 6.4 | `/ja/admin/tenant/mcp/clients` | 404 page |
| 6.5 | `/ja/admin/tenant/security` | 404 page |
| 6.6 | `/ja/admin/tenant/audit-logs/logs` | 404 page |

### 7. Accessibility — aria-current

| Step | Action | Expected |
|---|---|---|
| 7.1 | Navigate to `/ja/admin/tenant/audit-logs`; open DevTools Elements | Active sidebar link has `aria-current="page"` attribute |
| 7.2 | Enable NVDA/VoiceOver; navigate sidebar | Screen reader announces "current page" on the active item |
| 7.3 | Navigate to a different page | `aria-current` moves to the new active item |

### 8. ja/en label parity

| Step | Action | Expected |
|---|---|---|
| 8.1 | Navigate to `/en/admin/tenant/members` | Sidebar shows English labels: Members / Teams / Machine identity / Policies / Integrations / Audit logs / Break glass |
| 8.2 | Navigate to `/en/admin/tenant/policies/authentication/password` | Tab bar shows: Password / Session / Passkey / Lockout |
| 8.3 | Compare sidebar labels in ja vs en | All items have a corresponding translation; no raw key strings visible |

### 9. Mobile — sidebar hamburger navigation

Using DevTools iPhone 13 emulation (390×844):

| Step | Action | Expected |
|---|---|---|
| 9.1 | Navigate to `/ja/admin/tenant/members` | Sidebar not visible by default; hamburger icon visible |
| 9.2 | Tap hamburger | Sidebar slides in with 7 top-level items |
| 9.3 | Tap ポリシー group | Group expands showing children |
| 9.4 | Tap 認証ポリシー child | Sidebar closes; URL changes to `/ja/admin/tenant/policies/authentication/password` |
| 9.5 | Repeat on Pixel 7 emulation (412×915) | Same behavior |

### 10. force-dynamic verification (no stale cache)

| Step | Action | Expected |
|---|---|---|
| 10.1 | Open DevTools Network; navigate to `/ja/admin/tenant/breakglass` | No `Cache-Control: s-maxage` header; `Cache-Control: no-store` or `no-cache` |
| 10.2 | Open `/ja/admin/tenant/audit-logs` | Same — no ISR cache headers |
| 10.3 | As tenant admin, sign out, sign in as a different tenant admin | Pages show fresh data (not cached from previous session) |

### 11. Passkey enforcement — admin paths still gated

Sign in as a user whose tenant has `requirePasskey=true` but no passkey enrolled.

| Step | Action | Expected |
|---|---|---|
| 11.1 | Attempt to navigate to `/ja/admin/tenant/members` | Redirected to passkey enrollment page (not a redirect loop) |
| 11.2 | Enroll passkey | Admin pages become accessible |

### 12. Key-rotation typed-confirm gate

As `<team-owner-email>`, navigate to `/ja/admin/teams/{teamId}/key-rotation`.

| Step | Action | Expected |
|---|---|---|
| 12.1 | Observe key-rotation page | A typed-confirm input (destructive action gate) is required before rotation |
| 12.2 | Submit without typing the confirm phrase | Button remains disabled or error shown |
| 12.3 | Type the confirm phrase | Button enables |

## Expected results summary

- All 12 sections pass with no regressions.
- No console errors during navigation.
- 404 on all listed old URLs.
- New sidebar structure correctly reflects 7 tenant-scope items and 6 team-scope items.
- Group-landing redirects fire before page renders.
- Sub-tab navigation within authentication, machine-identity, and provisioning groups works.
- a11y: `aria-current="page"` announced correctly by screen reader.
- ja/en parity complete with no raw key strings.
- Mobile hamburger → group → child navigation works on both iOS and Android emulation.

## Rollback

1. **Procedure**: `git revert <merge-commit>` and redeploy.
   - No Prisma migrations are part of this PR — rollback is purely a code redeploy.
2. **Residual state after rollback**: none. No DB enum changes, no localStorage state, no audit-action entries specific to this PR.
3. **Post-rollback URL behavior**: old admin URLs are restored to their previous routes; the 404 behavior (from this PR) is removed.

## Adversarial scenarios (Tier-1 minimal)

| Scenario | Verification |
|---|---|
| Old-URL bookmark attack | Bookmarked `/ja/admin/tenant/security/session-policy` returns 404 (verified in step 6) |
| Cross-tenant URL probe | `/ja/admin/tenant/members` as a non-admin user returns 404 (verified by E2E `admin-authz.spec.ts`) |
| Unauthenticated probe | Same URLs without session cookie return 404 |
| Redirect race (group landing before auth check) | layout `notFound()` guard fires before redirect — non-admin sees 404 on group-landing URLs too |
