# Plan Review: settings-ui-reorganization
Date: 2026-03-30
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### [Major] F1: /admin/* ルートが VaultGate に包まれる問題
- **Problem**: AdminShellがVaultGate/ActiveVaultProvider/TravelModeProviderをどう扱うか未定義。vault非依存ページ(members/security/provisioning)と依存ページ(machine-identity)でVaultGate適用を分ける設計が必要。
- **Impact**: 管理コンソールでvault unlock前にDelegation ManagerやRotateKeyCardを表示しようとした際に機能不全。
- **Recommended action**: `/admin/layout.tsx`が参照すべきProviderとVaultGateの適用範囲をページ別に整理する。

### [Major] F2: DelegationRevokeBanner 内のハードコードされた旧URL
- **File**: `src/components/vault/delegation-revoke-banner.tsx:56`
- **Problem**: `router.push("/dashboard/settings?tab=developer&subtab=delegation")` がハードコード。
- **Impact**: Delegation移動後にリンク切れ。
- **Recommended action**: Phase 2 Step 9と同時に新URL (`/admin/tenant/machine-identity`) に更新。

### [Major] F3: /dashboard/teams/page.tsx 内の旧Team Settingsリンク
- **File**: `src/app/[locale]/dashboard/teams/page.tsx:100`
- **Problem**: `href={/dashboard/teams/${team.id}/settings}` がハードコード。チーム削除後の遷移先も未定義。
- **Impact**: admin移動後に404。
- **Recommended action**: Phase 3に書き換えステップ追加。遷移先を `/admin/teams/[id]/general` に変更。

### [Major] F4: useSidebarNavigationState の /admin/* パターン対応漏れ
- **File**: `src/hooks/use-sidebar-navigation-state.ts:66,69`
- **Problem**: isTeamSettings/isTenantSettingsが/dashboard/のみチェック。isAdminActiveフラグ未定義。
- **Impact**: /admin/配下でサイドバーの"管理コンソール"がハイライトされない。
- **Recommended action**: Phase 5に具体的な変更内容（isAdminActive追加）を明記。

### [Major] F5: i18n namespace グループの更新漏れ
- **File**: `src/i18n/namespace-groups.ts`
- **Problem**: NS_DASHBOARD_ALLに/admin/*用namespaceが含まれない。namespace-groups.test.tsが失敗する可能性。
- **Impact**: admin画面で翻訳欠落。
- **Recommended action**: Phase 1にNS_ADMIN_ALLの定義を追加。

### [Major] F6: proxy.ts の /admin/* アクセス制限チェック漏れ
- **File**: `src/proxy.ts:59,70`
- **Problem**: セッションチェックだけでなくcheckAccessRestrictionWithAuditも/admin/*に適用必要。
- **Impact**: IP制限がadminコンソールにバイパスされる。
- **Recommended action**: Phase 6にアクセス制限チェックの適用を明記。

### [Minor] F7: チーム招待URL (/dashboard/teams/invite/[token]) の扱い
- **Problem**: invite URLがdashboard配下に残ることが明記されていない。
- **Recommended action**: Migration Notesに明記。

### [Minor] F8: useVaultContext の CROSS_VAULT_PATHS 配列更新
- **File**: `src/hooks/use-vault-context.ts:34`
- **Problem**: /dashboard/teamsが廃止された場合の更新が必要。
- **Recommended action**: Phase 7 Cleanupに確認ステップ追加。

## Security Findings

### [Major] S1: auth実装(Phase 6)がルート追加(Phase 1-5)より後回し
- **Problem**: 開発中に/admin/*が保護されないウィンドウが生じる。
- **Impact**: 誤デプロイ時に認証なしでテナント管理機能にアクセス可能。
- **Recommended action**: proxy.tsの/admin/*保護をPhase 1の最初に移動。

### [Major] S2: Admin layout のテナント管理者チェックがサーバーサイドか不明
- **Problem**: /admin/layout.tsxをServer Componentとして実装し、auth()でサーバーサイドリダイレクトすべき。
- **Impact**: クライアントサイドのみでは迂回可能。SA一覧、MCPクライアントID等の情報漏洩。
- **Recommended action**: Server Componentとして実装、auth() + DBロールチェック + redirect()。

### [Major] S3: チーム管理ページの認可がクライアントサイドのみ
- **Problem**: /admin/teams/[teamId]/layout.tsxでサーバーサイドのメンバーシップ・ロールチェックが必要。
- **Impact**: 非メンバーがteamId直打ちでUIに到達しうる。
- **Recommended action**: Server Componentとして実装、getTeamMembership() + ロールチェック。

### [Minor] S4: Scope Selector のTOCTOU
- **Problem**: 削除済みメンバーシップがキャッシュに残る可能性。
- **Recommended action**: stale-while-revalidateパターン推奨。

### [Minor] S5: "管理コンソール"リンクのクライアントサイド表示制御
- **Problem**: S1/S2修正前提でリスクは低い。
- **Recommended action**: Server Componentでの表示制御推奨。

## Testing Findings

### [Critical] T1: E2Eテストがハードコードされた旧URLで破綻する
- **Files**: `e2e/tests/settings-sessions.spec.ts`, `settings-api-keys.spec.ts`, `settings-key-rotation.spec.ts`, `settings-travel-mode.spec.ts`, `tenant-admin.spec.ts`
- **Problem**: 5つのE2Eテストスペックが旧URL直書き。
- **Impact**: Phase完了後に全落ち。
- **Recommended action**: E2Eテストの全面更新を専用フェーズとして追加。

### [Critical] T2: SettingsPage POが新page-per-route構造と根本的に非互換
- **File**: `e2e/page-objects/settings.page.ts`
- **Problem**: switchTab()/switchSecuritySubTab()/switchDeveloperSubTab()がタブUI前提。
- **Impact**: 4つのE2Eテストスペック全落ち。
- **Recommended action**: PO全面再設計（goto*()メソッド群に置換）。

### [Critical] T3: SidebarNavPage POとtenant-admin.spec.tsが旧ナビ構造に依存
- **File**: `e2e/page-objects/sidebar-nav.page.ts`
- **Problem**: navigateTo("tenantSettings")が3回使用されるがリンク先が消える。
- **Impact**: tenant-admin.spec.tsの全テスト失敗。
- **Recommended action**: AdminConsole向けメソッド追加、tenant-admin.spec.ts全面書き直し。

### [Major] T4: 新コンポーネント(AdminShell, AdminScopeSelector)のテスタビリティ未設計
- **Problem**: スコープ切り替えの条件分岐テストが計画に含まれていない。
- **Recommended action**: Phase 1完了条件にAdminScopeSelectorの単体テスト追加。

### [Major] T5: sidebar-section-security.test.tsxが旧URL・旧ナビ構造をハードコード
- **File**: `src/components/layout/sidebar-section-security.test.tsx`
- **Problem**: /dashboard/settings, /dashboard/teams, /dashboard/tenantがリテラルでアサート。
- **Impact**: Phase 5で全落ち。
- **Recommended action**: Phase 5の作業スコープに明示的に含める。

### [Major] T6: useSidebarNavigationState/useSidebarSectionsState が /admin/* パス未対応
- **Files**: `src/hooks/use-sidebar-navigation-state.test.ts`, `use-sidebar-sections-state.test.ts`
- **Problem**: /admin/*パスに対するテストケースが存在しない。
- **Impact**: Adminコンテキストでのサイドバーバグが未検出のまま本番に流れる。
- **Recommended action**: /admin/*パスのテストケース追加。

## Adjacent Findings

- [Adjacent] Minor: `/api/tenant/*` 管理APIエンドポイントのレートリミット不足の可能性（Security → Functionality scope）
- [Adjacent] Security: F6 の proxy.ts アクセス制限チェックはセキュリティスコープと重複（Functionality → Security scope）

## Quality Warnings

| Finding | Warning | Reason |
|---------|---------|--------|
| F4/T6 | VAGUE | isAdminActiveの追加先ファイル・行が未特定 |
| T4 | VAGUE | テスト対象のファイル・フレームワーク未特定 |
| S4 | NO-EVIDENCE | キャッシュ実装のコード参照なし |
| S5 | VAGUE | 変更対象のコンポーネント・ファイル未特定 |

---

# Round 2
Date: 2026-03-30

## Changes from Previous Round
All Round 1 findings (F1-F8, S1-S3, T1-T6) resolved in plan update.

## New Findings (Round 2)

### Functionality
- [Major] F9: isSettings prefix match + sidebar.tsx calculation — RESOLVED in Round 3
- [Major] F10: CROSS_VAULT_PATHS judgment — RESOLVED in Round 3
- [Minor] F11-F13: E2E timing, hasAnyTeamAdminRole file, teams.spec.ts — RESOLVED in Round 3

### Security
- [Major] N1: hasAnyTeamAdminRole async DB call — RESOLVED in Round 3
- [Minor] N2-N3: Phase 0 atomic merge, link visibility — RESOLVED in Round 3

### Testing
- [Major] T7-T9: sidebar test timing, isSettingsActive test, teams.spec.ts — RESOLVED in Round 3
- [Minor] T10-T12: sections state spec, namespace test, team-dashboard PO — RESOLVED in Round 3

---

# Round 3
Date: 2026-03-30

## Changes from Previous Round
All Round 2 findings resolved.

## New Findings (Round 3)

### Functionality
- [Major] F14: getAdminTeamMemberships file path (src/lib/teams.ts → src/lib/team-auth.ts) + getTenantRole server-side — RESOLVED
- [Major] F15: isValidId doesn't exist → replaced with notFound() on null membership — RESOLVED
- [Major] F16: isAuditLog regex matches /admin/* paths → scoped to /dashboard/ — RESOLVED
- [Minor] F17: namespace-groups test excluded set — RESOLVED
- [Minor] F18: DelegationRevokeBanner in admin context — documented in Migration Notes

### Security
- [Major] N4: /admin/tenant/* needs tenant-admin layout check → added /admin/tenant/layout.tsx — RESOLVED
- [Minor] N5: getAdminTeamMemberships needs withBypassRls — RESOLVED (noted in step description)
- [Minor] N6: redirect vs notFound for team auth → notFound() chosen — RESOLVED

### Testing
- [Major] T13-T14: SidebarContentProps + useSidebarSectionsState isAdminActive — RESOLVED (Steps 53, 56)
- [Major] T15: namespace-groups test excluded set — RESOLVED (Step 13)
- [Major] T16: E2E PO atomicity — documented in Migration Notes
- [Minor] T17-T19: teams.page.ts openTeamVault, tenant-admin timing, admin.page.ts scope — documented in Migration Notes

## Assessment
Findings are converging to implementation-detail level. All Critical and Major issues have been addressed.
Plan is ready for implementation.
