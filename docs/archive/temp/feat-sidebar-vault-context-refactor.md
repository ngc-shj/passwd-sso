# コードレビュー: feat/sidebar-vault-context-refactor

**ブランチ:** `feat/sidebar-vault-context-refactor`
**レビュー日:** 2026-02-19
**対象コミット:** `2c6371d` ～ `a6085d8` (35 commits)
**前回レビュー:** あり（同日、33 commits 時点）
**前回からの変更:** 2 コミット追加（`9789ea0`, `a6085d8` — 権限修正 + テスト追加 + エラー処理共通化）

---

## 概要

サイドバーの大規模リファクタリング + vault context 機能の導入 + share-links の org スコープ対応。

**主な変更:**

1. `sidebar.tsx` (1125行 → 大幅縮小) をフック群 + コンポーネント群に分割
2. Vault コンテキスト切替（個人/組織）の導入
3. Share-links の個人/組織スコープ分離 + VIEWER ロール制限
4. 監査ログ翻訳キーの拡充・正規化ユーティリティ抽出
5. サイドバーからのタグ編集/カラー変更/削除機能
6. テストカバレッジの追加（新規テスト 10 ファイル以上）

---

## 前回レビューからの変更サマリー

| 前回 # | 前回重要度 | 概要 | 今回の状態 |
| ------ | --------- | ---- | --------- |
| 1.1 | HIGH | useSearchParams モック漏れ | **解決済み** ✅ |
| 1.2 | MEDIUM | 無効な SidebarSection 値 "vault" | **解決済み** ✅ |
| 1.3 | MEDIUM | タグフィルタの個人/org 非対称性 | 未対応（継続） |
| 1.4 | LOW | fetch エラーの無声失敗 | 未対応（継続） |
| 1.5 | LOW | 並行フェッチの競合リスク | 未対応（継続） |
| 1.6 | MEDIUM | render 中の state 更新パターン | **解決済み** ✅ |
| 2.1 | HIGH | org スコープで VIEWER にも全リンク公開 | **解決済み** ✅ |
| 3.2 | HIGH | 新規コンポーネント 3 ファイルのテスト未作成 | **部分解決** — テスト追加済みだがカバレッジが薄い |
| 3.3 | MEDIUM | OrgAuthError 拒否テスト欠落 | **解決済み** ✅ |
| 3.4 | MEDIUM | share-links org context 未検証 | **解決済み** ✅ |
| 3.5 | LOW | props 転送の未検証 | 未対応（継続） |
| 6.1 | MEDIUM | フォルダ展開ボタンに aria-label なし | **解決済み** ✅ |
| 6.2 | LOW | セクションヘッダーに aria-expanded なし | **解決済み** ✅ |
| 7.1 | MEDIUM | 検索の大文字小文字不一致 | **解決済み** ✅ |
| 7.2 | LOW | クライアント時刻によるステータス判定 | **解決済み** ✅ |
| 7.3 | LOW | OrgDashboardPage テストカバレッジ不足 | 未対応（継続） |
| 8.3 | MEDIUM | 組織監査ログタイトルから org 名消失 | **解決済み** ✅ |
| 8.4 | LOW | normalizeAuditActionKey 関数の重複 | **解決済み** ✅ |
| 8.6 | NOTE | OrganizationsSection デッドコード | **解決済み** ✅ |
| 前7.2 | MEDIUM | タグ/フォルダ管理権限の非対称性 | **解決済み** ✅ |
| 前7.3 | MEDIUM | use-sidebar-tag-crud.ts テストなし | **解決済み** ✅ |
| 前7.4 | MEDIUM | tag-dialog.tsx テストなし | **解決済み** ✅ |
| 前7.5 | NOTE | showApiError 関数の重複 | **解決済み** ✅ |

**解決率:** 22 件中 17 件解決（77%）。残存 5 件はいずれも LOW 以下。

---

## 1. 機能（Functionality）

### 1.1 [MEDIUM] `useSidebarNavigationState` — タグフィルタリングの非対称性

**ファイル:** [use-sidebar-navigation-state.ts:118-133](src/hooks/use-sidebar-navigation-state.ts#L118-L133)
**前回:** 1.3 [MEDIUM] — 継続

個人タグ: `passwordCount > 0` でフィルタ（L127）
組織タグ: フィルタなし（L120-125）

組織タグは `count: 0` でも表示され、個人タグは非表示。意図的な設計の可能性もあるが、UX の一貫性の観点で確認すべき。

### 1.2 [LOW] `useSidebarData` — エラーの無声失敗

**ファイル:** [use-sidebar-data.ts:57,67,111](src/hooks/use-sidebar-data.ts#L57)
**前回:** 1.4 [LOW] — 継続

`.catch(() => {})` で全 fetch エラーを無視。ネットワーク障害時にサイドバーが空表示のままとなり、ユーザーに問題が伝わらない。

### 1.3 [LOW] `useSidebarData` — 並行フェッチの競合リスク

**ファイル:** [use-sidebar-data.ts:48-112](src/hooks/use-sidebar-data.ts#L48-L112)
**前回:** 1.5 [LOW] — 継続

`refreshData()` が短時間に複数回呼ばれた場合、古いレスポンスが新しいレスポンスを上書きする可能性がある。AbortController なし。ページ遷移 + `vault-data-changed` イベントが同時発火するケースが該当。現実的には低頻度。

---

## 2. セキュリティ（Security）

### 2.1 ~~[HIGH] share-links API — org スコープで全リンク返却~~ → **解決済み** ✅

> **コミット `8cdb259` で修正:** VIEWER ロールは `createdById = session.user.id` フィルタが適用され、自身が作成したリンクのみ閲覧可能に制限。ADMIN / OWNER / MEMBER は従来どおり組織内全リンクを閲覧。

**修正内容の検証:**

- [route.ts:37-39](src/app/api/share-links/mine/route.ts#L37-L39): `ORG_ROLE.VIEWER` チェックが `where` 構築前に適切に配置
- サーバーサイドでのロール取得: `requireOrgMember` が `OrgMember` オブジェクト（`role` フィールド含む）を返却、`membershipRole` として取得
- テスト: VIEWER ロール制限テスト追加済み（[mine.test.ts:293-309](src/__tests__/api/share-links/mine.test.ts#L293-L309)）

### 2.2 [LOW] VIEWER 制限テスト — MEMBER / OWNER ロールの明示的検証なし

**ファイル:** [mine.test.ts](src/__tests__/api/share-links/mine.test.ts)

VIEWER テスト（自身のリンクのみ）は追加されたが、MEMBER / OWNER ロールで `createdById` フィルタが**付かない**ことの明示的テストがない。`beforeEach` で `ORG_ROLE.ADMIN` をデフォルト設定しているため暗黙的にはカバーされているが、ロール別の挙動を明確にするテストが望ましい。

---

## 3. テスト（Testing）

### 3.1 カバレッジ評価

| ファイル | テスト有無 | カバレッジ評価 | 前回比 |
| ------- | ---------- | ------------- | ------ |
| `use-vault-context.ts` | あり | **A-** — searchParams シナリオ追加 | → |
| `use-sidebar-data.ts` | あり | B+ — イベントリスナー・org fetching カバー | → |
| `use-sidebar-folder-crud.ts` | あり | **A** — CRUD 操作 + エラーパス + MEMBER 権限 | ↑ A-→A |
| `use-sidebar-navigation-state.ts` | あり | **B+** — MEMBER 権限テスト追加 | ↑ B→B+ |
| `use-sidebar-sections-state.ts` | あり | B+ — 有効値のみでテスト | → |
| `use-sidebar-view-model.ts` | あり | B — 動作検証のみ | → |
| `vault-selector.tsx` | あり | A — レンダリング + インタラクション | → |
| `sidebar-content.tsx` | あり | B+ — レンダリング検証 | → |
| `sidebar-sections.tsx` | あり | C+ — 2/4 コンポーネントのみ | → |
| `sidebar-section-security.tsx` | あり | C+ — 基本パスのみ | → |
| `sidebar-shared.tsx` | あり | C — 1/15+ シナリオのみ | → |
| `share-links/mine/route.ts` | あり | A — 認証・フィルタ・ロール制限 | → |
| `use-sidebar-tag-crud.ts` | **あり (新規)** | **B+** — 個人/org URL + エラー + 削除失敗 | ↑ N/A→B+ |
| `tag-dialog.tsx` | **あり (新規)** | **B** — 初期値・色null維持・色変更 | ↑ N/A→B |
| `use-sidebar-crud-error.ts` | なし | N/A | **新規** |
| `audit-action-key.ts` | なし | N/A | → |
| `share-links/page.tsx` | なし | N/A | → |
| `language-switcher.test.tsx` | あり | A | → |
| `search-bar.test.tsx` | あり | A | → |

### 3.2 [MEDIUM] `sidebar-sections.test.tsx` — カバレッジの偏り

**ファイル:** [sidebar-sections.test.tsx](src/components/layout/sidebar-sections.test.tsx)

テストは追加されたが、4 つの export コンポーネント中 2 つ（`VaultManagementSection`, `OrganizeSection`）のみ。

**テストなし:**

- `VaultSection` — パスワード + お気に入りリンク生成（個人/org 分岐）
- `CategoriesSection` — 5 カテゴリのリンク生成、折りたたみ状態

**テスト済みだが薄い:**

- `VaultManagementSection` — 個人/org の href 検証のみ。`isSelectedVaultArchive` 等のアクティブ状態未検証
- `OrganizeSection` — `onCreateFolder` コールバックのみ。タグ表示・フォルダツリー・編集/削除未検証

### 3.3 [MEDIUM] `sidebar-shared.test.tsx` — FolderTreeNode テストが最小限

**ファイル:** [sidebar-shared.test.tsx](src/components/layout/sidebar-shared.test.tsx)

FolderTreeNode は再帰的なフォルダツリーコンポーネント（~100 行）だが、テストは 1 ケース（祖先展開）のみ。

**未検証:**

- 子なしフォルダの展開ボタン非表示
- クリックによる開閉トグル
- aria-label / aria-expanded 属性の値
- フォルダメニュー（編集/削除）コールバック
- depth による paddingLeft のインラインスタイル
- アクティブフォルダの secondary variant 適用

### 3.4 [LOW] `audit-action-key.ts` — ユニットテストなし

**ファイル:** [audit-action-key.ts](src/lib/audit-action-key.ts)

`normalizeAuditActionKey` は 2 ファイルから import される共通ユーティリティだが、専用テストファイルがない。関数自体は単純（5 行）だが、テストがないと将来の変更時に回帰を検出できない。

### 3.5 [LOW] `use-sidebar-view-model.test.ts` — props 転送の未検証

**前回:** 3.5 [LOW] — 継続

view model フックが返す props の値が入力パラメータと一致することを検証していない。

### 3.6 [LOW] OrgDashboardPage テストカバレッジ不足

**前回:** 7.3 [LOW] — 継続

テストは folder/tag クエリパラメータの伝播（3 ケース）のみ。エラー状態、ロールベース権限、favorites/archive/trash 表示ロジック等が未検証。

---

## 4. i18n

### 4.1 [OK] 翻訳キーの整合性

en.json / ja.json の追加キーは完全に一致:

- `ShareLinks.sharedBy` — 追加済み
- `Org.favorites` / `Org.archive` / `Org.trash` — 追加済み
- `AuditLog.title` — 簡素化済み
- 監査アクション 11 キー + グループ 2 キー追加
- `Dashboard.editTag` / `Dashboard.deleteTag` — 追加済み
- `Dashboard.tagName` / `Dashboard.tagColor` — 追加済み
- `Dashboard.tagDeleteConfirm` — 追加済み

---

## 5. コード品質

### 5.1 [GOOD] リファクタリングの設計

- **関心の分離が明確:** データ取得 → ナビゲーション状態 → セクション状態 → ビューモデル → UI
- **テスタビリティ向上:** 各フックが独立してテスト可能
- **sidebar.tsx が 1125 行から大幅削減:** メンテナンス性が大きく改善

### 5.2 [GOOD] 前回指摘の修正品質

- **render-time setState 解消** ([sidebar-shared.tsx:66](src/components/layout/sidebar-shared.tsx#L66)): `const isExpanded = open || isAncestorOfActive` で状態更新パターンを排除。`wasAncestor` state を削除し、派生値として扱う設計に改善
- **normalizeAuditActionKey 抽出** ([audit-action-key.ts](src/lib/audit-action-key.ts)): 共通 util に適切に分離
- **org 監査ログタイトル復元**: `orgName` の fetch + フォールバック (`orgName ? t("orgAuditLog", { orgName }) : t("title")`) が適切に実装
- **権限レベル統一** ([use-sidebar-navigation-state.ts:74-79](src/hooks/use-sidebar-navigation-state.ts#L74-L79)): `selectedOrgCanManageFolders` と `selectedOrgCanManageTags` を共に `role !== VIEWER` に統一。API 側の権限設計（`MEMBER` もフォルダ・タグ管理可能）との整合性を確保
- **showApiError 共通化** ([use-sidebar-crud-error.ts](src/hooks/use-sidebar-crud-error.ts)): `showSidebarCrudError` として抽出し、folder-crud / tag-crud の重複を解消
- **colorChanged バグ修正** ([tag-dialog.tsx:28,35,40-45](src/components/tags/tag-dialog.tsx#L28)): 既存タグ色が `null` の場合に未変更保存でデフォルト色 `#4f46e5` が意図せず保存される問題を `colorChanged` フラグで防止

### 5.3 [GOOD] TagDialog の実装品質

- カラーバリデーション: `/^#[0-9a-fA-F]{6}$/` で不正値を `null` にフォールバック
- IME 対応: `!e.nativeEvent.isComposing` で日本語入力中の Enter 誤送信を防止
- `name.trim()` による空白チェック、`maxLength={50}` 制限、`loading` state で二重送信防止
- `htmlFor` / `id` のアクセシビリティ属性が適切

### 5.4 [NOTE] `OrganizeTagItem` の重複定義

同一インターフェースが 3 ファイルで重複定義:

- [sidebar-content.tsx:16-21](src/components/layout/sidebar-content.tsx#L16-L21)
- [sidebar-sections.tsx:28-33](src/components/layout/sidebar-sections.tsx#L28-L33)
- [use-sidebar-view-model.ts:9-14](src/hooks/use-sidebar-view-model.ts#L9-L14)

`use-sidebar-data.ts` の export に統合することで重複を解消可能。

---

## 6. アクセシビリティ

### 6.1 ~~[MEDIUM] フォルダ展開ボタンに aria-label なし~~ → **解決済み** ✅

> **コミット `8c707de` で修正:** [sidebar-shared.tsx:76-77](src/components/layout/sidebar-shared.tsx#L76-L77) に `aria-label` + `aria-expanded` 追加。

### 6.2 ~~[LOW] セクションヘッダーに aria-expanded なし~~ → **解決済み** ✅

> **コミット `8c707de` で修正:** [sidebar-shared.tsx:156](src/components/layout/sidebar-shared.tsx#L156) に `aria-expanded={isOpen}` 追加。

---

## 指摘サマリー

| # | 重要度 | カテゴリ | 概要 | ファイル | 状態 |
|---|--------|---------|------|---------|------|
| 1.1 | MEDIUM | 機能 | タグフィルタの個人/org 非対称性 | use-sidebar-navigation-state.ts | 継続 |
| 1.2 | LOW | 機能 | fetch エラーの無声失敗 | use-sidebar-data.ts | 継続 |
| 1.3 | LOW | 機能 | 並行フェッチの競合リスク | use-sidebar-data.ts | 継続 |
| 2.2 | LOW | セキュリティ | MEMBER/OWNER ロールの明示的テストなし | mine.test.ts | 継続 |
| 3.2 | MEDIUM | テスト | sidebar-sections テストカバレッジの偏り | sidebar-sections.test.tsx | 継続 |
| 3.3 | MEDIUM | テスト | FolderTreeNode テストが最小限 | sidebar-shared.test.tsx | 継続 |
| 3.4 | LOW | テスト | normalizeAuditActionKey ユニットテストなし | audit-action-key.ts | 継続 |
| 3.5 | LOW | テスト | props 転送の未検証 | use-sidebar-view-model.test.ts | 継続 |
| 3.6 | LOW | テスト | OrgDashboardPage テストカバレッジ不足 | orgs/[orgId]/page.test.tsx | 継続 |
| 5.4 | NOTE | 品質 | OrganizeTagItem の重複定義（3 ファイル） | sidebar-content 等 | 継続 |

HIGH: 0件 / MEDIUM: 3件（-3件）/ LOW: 6件 / NOTE: 1件（-1件）

---

## 総評

前回レビュー（MEDIUM: 6, LOW: 6, NOTE: 2）から、MEDIUM 3件 + NOTE 1件が解決され、残存はすべて MEDIUM 以下の 10 件。

**今回解決された指摘（コミット `9789ea0`, `a6085d8`）:**

- **権限レベルの統一（前7.2）**: `selectedOrgCanManageFolders` を `role !== VIEWER` に変更し、タグ管理と同じ権限レベルに統一。API 側の `ORG_PERMISSION.TAG_MANAGE`（MEMBER 許可）との不整合が解消。テスト（MEMBER ロールでの folder create/edit/delete 有効化）も同時更新
- **tag-crud テスト追加（前7.3）**: [use-sidebar-tag-crud.test.ts](src/hooks/use-sidebar-tag-crud.test.ts) — 個人/org URL 検証、エラー時 toast + throw、削除失敗時の state クリア（4 テストケース）
- **tag-dialog テスト追加（前7.4）**: [tag-dialog.test.tsx](src/components/tags/tag-dialog.test.tsx) — 初期値反映、null 色維持、色変更時の送信値検証（3 テストケース）
- **showApiError 共通化（前7.5）**: [use-sidebar-crud-error.ts](src/hooks/use-sidebar-crud-error.ts) に `showSidebarCrudError` として抽出。folder-crud / tag-crud の両方から利用

**追加のバグ修正:**

- **colorChanged フラグ導入**: TagDialog で既存タグ色が `null` の場合に未変更保存でデフォルト色 `#4f46e5` が保存される問題を修正。`colorChanged` state で色入力の有無を追跡し、未変更時は `null` を維持

**全体評価:**

- 機能・セキュリティの重大な問題は 0 件（HIGH なし）
- 残存 MEDIUM 3 件はいずれもテストカバレッジの偏りであり、機能的リスクは低い
- 指摘への対応が迅速かつ適切で、修正品質も高い

---

## 9. 追加コミット評価（251 commits 追記）

以下 251 コミットを追加評価（`a6085d8` 以降 ～ `d76a39f`）。
203 ファイル変更、+14,319 / -5,065 行。

**主な変更領域:**

1. サイドバー前回指摘の修正（1.1, 1.2, 1.3, 5.4）
2. フォーム大規模リファクタリング（個人/組織 Model/Controller/Presenter 分割）
3. インポート/エクスポート機能のページ化 + 組織対応
4. 共有型システムの整備（entry-form-types, translation-types）
5. パスキーエントリサポート（API + バリデーション + UI）
6. テストカバレッジ大幅拡充（58 新規テストファイル）

---

### 9.1 前回指摘の修正

#### 9.1.1 ~~[MEDIUM] タグフィルタの個人/org 非対称性~~ → **解決済み** ✅

> **コミット `997d972` で修正:** 組織タグにも `.filter((tag) => tag.count > 0)` を適用。テストに `count: 0` の org タグを追加し、フィルタ除外を検証。

**修正内容の検証:**

- [use-sidebar-navigation-state.ts:120-125](src/hooks/use-sidebar-navigation-state.ts#L120-L125): org タグフィルタ追加
- テスト: zero-count org タグのフィルタ検証追加
- MEMBER / OWNER ロールの share-links テストも同時追加（2.2 の指摘にも対応）

#### 9.1.2 ~~[LOW] fetch エラーの無声失敗~~ → **解決済み** ✅

> **コミット `8afec5c` で修正:** `lastError` state を導入し、詳細なエラーメッセージを公開。成功時に自動クリア。

**修正内容の検証:**

- `fetchArray()` に `onError` コールバックを追加し、HTTP エラー・型不一致・ネットワーク障害を区別
- エラー形式: `"Failed to fetch /api/tags: 500"`, `"Invalid response from /api/tags: expected array"`, `"Request error for /api/tags: timeout"`
- 成功時に `setLastError(errors[0] ?? null)` で自動クリア
- テスト: エラー格納 + 成功後のクリアを検証

#### 9.1.3 ~~[LOW] 並行フェッチの競合リスク~~ → **解決済み** ✅

> **コミット `b2cf5f7` で修正:** `refreshSeqRef` によるシーケンスガードを導入。古いレスポンスの上書きを防止。

**修正内容の検証:**

- `const seq = ++refreshSeqRef.current` でリフレッシュごとにインクリメント
- 非同期操作後に `if (seq !== refreshSeqRef.current) return;` で古い結果を破棄
- 2 箇所のガード（初期 fetch 後、org 詳細 fetch 後）
- テスト: 遅い先行リクエストが後続の高速リクエスト結果を上書きしないことを検証

#### 9.1.4 ~~[NOTE] OrganizeTagItem の重複定義~~ → **解決済み** ✅

> **コミット `1cf4c0c` で修正:** `SidebarOrganizeTagItem` を `use-sidebar-data.ts` に一元化。3 ファイルの重複を解消。

同時に以下のテストも追加:

- `VaultSection` テスト（個人/org リンク生成）
- `CategoriesSection` テスト（カテゴリリンク、個人/org スコープ）
- `FolderTreeNode` 展開/折りたたみ・コールバック・depth パディングテスト
- `OrganizeSection` タグメニューコールバックテスト
- `audit-action-key` ユーティリティテスト

#### 9.1.5 ~~[LOW] VIEWER 制限テスト — MEMBER / OWNER ロールの明示的検証なし~~ → **解決済み** ✅

> **コミット `997d972` で修正:** MEMBER / OWNER ロールで `createdById` フィルタが付かないことの明示的テストを追加。

---

### 9.2 フォームリファクタリング

**対象:** `src/components/passwords/`, `src/components/org/`, `src/hooks/use-personal-*`, `src/hooks/use-org-*`

**アーキテクチャ:** Model / Controller / Presenter パターンに分割。

```text
usePersonalPasswordFormModel (エントリポイント)
├── usePersonalPasswordFormState (UI + 値の状態)
│   ├── usePersonalPasswordFormUiState
│   └── usePersonalPasswordFormValueState
├── usePersonalPasswordFormPresenter (派生ビュー状態)
│   ├── usePersonalPasswordFormDerived (hasChanges, generatorSummary)
│   └── usePersonalEntryLoginFieldsProps (コールバック + UI props)
├── usePersonalPasswordFormController (サブミットロジック)
└── usePersonalFolders (データ取得)
```

組織フォームも同様の構造（+ lifecycle, attachments, folders フック）。

#### 9.2.1 [GOOD] 関心の分離

- **Model**: 依存関係のワイヤリング
- **Controller**: サブミットロジック + バリデーション
- **Presenter**: 状態 → UI props のマッピング
- **Derived**: hasChanges / submitDisabled の計算
- **State**: UI 状態（visibility toggles）と値状態（form fields）を明確に分離

#### 9.2.2 [GOOD] 型安全性

- 各レイヤーに明示的なインターフェース定義
- `selectPersonalEntryValues` / `selectOrgEntryFieldValues` で全状態 → エントリ値の変換
- 翻訳型: `PasswordFormTranslator`, `CommonTranslator` 等を `ReturnType<typeof useTranslations<"Namespace">>` で定義（[translation-types.ts](src/lib/translation-types.ts)）

#### 9.2.3 [GOOD] 共有コンポーネント抽出

- `EntryListHeader` — 個人/org ダッシュボードのヘッダー統一
- `entry-form-helpers.ts` — `extractTagIds`, `toTagNameColor`, `filterNonEmptyCustomFields`, `parseUrlHost`
- `form-navigation.ts` — cancel/back ハンドラの共通化
- `entry-tags-and-folder-layout.tsx` — タグ + フォルダセクションの個人/org 共有
- `entry-login-main-fields.tsx` — ログインフィールドの共有コンポーネント

#### 9.2.4 [MEDIUM] データ取得フックのエラー無声失敗

**ファイル:**

- [use-org-attachments.ts:16](src/hooks/use-org-attachments.ts#L16)
- [use-org-folders.ts:20](src/hooks/use-org-folders.ts#L20)
- [use-personal-folders.ts:18](src/hooks/use-personal-folders.ts#L18)

`.catch(() => {})` / `.catch(() => setAttachments([]))` で fetch エラーを無視。フォーム内でフォルダ・添付ファイルの読み込みに失敗してもユーザーに通知されない。サイドバーの `use-sidebar-data` では同様の問題が修正されたが、フォーム内のデータ取得フックには未適用。

#### 9.2.5 [LOW] スナップショット比較のパラメータリスト肥大

**ファイル:** [use-org-password-form-derived.ts:84-121](src/hooks/use-org-password-form-derived.ts#L84-L121)

`buildCurrentSnapshot` 関数が 20 以上のパラメータを受け取る。エントリタイプ別に分割するか、オブジェクトパターンの採用で可読性が向上する。

---

### 9.3 インポート/エクスポートリファクタリング

**対象:** ダイアログ → 専用ページへの移行、組織インポート対応、フォーマット共有。

#### 9.3.1 [GOOD] ページ化アーキテクチャ

- `/dashboard/export` / `/dashboard/import` — 個人
- `/dashboard/orgs/[orgId]/export` / `/dashboard/orgs/[orgId]/import` — 組織
- `PagePane` / `PageTitleCard` レイアウトコンポーネントの共通化
- サイドバーからの import/export ダイアログ削除（デッドコード除去）

#### 9.3.2 [GOOD] セキュリティ

- **パストラバーサル防止**: `x-passwd-sso-filename` ヘッダーで null バイト・制御文字・パス区切りをサニタイズ（テスト済み）
- **暗号化エクスポート**: PBKDF2(600k iterations) + AES-256-GCM、ランダム salt/IV
- **個人インポート E2E 暗号化**: クライアントサイドで fullBlob/overviewBlob を暗号化、AAD 付き
- **エクスポートボタン無効化**: パスワード未入力・不一致時は disabled（[export-options-panel.tsx](src/components/passwords/export-options-panel.tsx)）
- **インポートエラー状態クリア**: 実行エラー時に `importing` state を必ずクリア

#### 9.3.3 [GOOD] フォーマット共有

- `export-format-common.ts` (367 行) — CSV/JSON フォーマットロジック統一
- 個人/org で `includeReprompt`, `includePasskey` オプション分離
- CSV/date ヘルパー共有

#### 9.3.4 [LOW] エクスポート時の復号失敗サイレントスキップ

**ファイル:** [export-dialog.tsx](src/components/passwords/export-dialog.tsx)

個別エントリの復号に失敗した場合、`catch {}` でスキップ。失敗件数のフィードバックなし。大量のエントリで一部が壊れている場合にユーザーが気づけない。

---

### 9.4 パスキーエントリサポート

#### 9.4.1 [GOOD] API バリデーション

**ファイル:** [validations.ts:375-401](src/lib/validations.ts#L375-L401)

- `createOrgPasskeySchema` — `relyingPartyId` 必須、`.trim()` 適用、CUID 形式チェック
- `updateOrgPasskeySchema` — 部分更新対応（title/relyingPartyId は optional）
- フィールド長制限: `credentialId` max 500、`notes` max 10000

#### 9.4.2 [GOOD] API セキュリティ

- POST: セッション + `requireOrgPermission(PASSWORD_READ)` で認証/認可
- GET: 一覧では `credentialId` 非公開（詳細ビューのみ）
- PUT: `requireOrgMember` + `hasOrgPermission` の二段チェック
- Blob 暗号化: `encryptServerData` + AAD（orgId, entryId, "blob" ラベル）

#### 9.4.3 [GOOD] クライアントバリデーション

**ファイル:** [org-entry-validation.ts](src/lib/org-entry-validation.ts)

パスキー: `title` + `relyingPartyId.trim()` 必須。テスト ([org-entry-validation.test.ts](src/lib/org-entry-validation.test.ts)) で成功/失敗パスを検証。

---

### 9.5 テストカバレッジ拡充

75 テストファイル変更、58 新規テストファイル。

| 領域 | 新規テスト数 | カバレッジ評価 |
| ---- | ---------- | ------------- |
| Form Model/Controller/Presenter | ~15 ファイル | **A** — 各レイヤーを独立テスト |
| Form Derived/State | ~8 ファイル | **B+** — 主要パスをカバー |
| Import/Export | ~7 ファイル | **A** — フォーマット検出・暗号化・エラー処理 |
| Validation/Payload | ~5 ファイル | **A** — エントリタイプ別検証 |
| Shared Utilities | ~5 ファイル | **A** — sort, navigation, generator summary |
| Sidebar (追加) | ~5 ファイル | **B+** — VaultSection, CategoriesSection, FolderTreeNode 追加 |

#### 9.5.1 [GOOD] テスト品質

- `vi.hoisted()` パターンの適切な使用
- `renderHook` + `act` による React フックテスト
- ヘルパー関数によるモックデータ構築
- フェッチモック + エラーパスの網羅

#### 9.5.2 [LOW] インポートパーサーのユニットテスト不足

**ファイル:** [import-dialog-parsers.ts](src/components/passwords/import-dialog-parsers.ts) (387 行)

カスタム CSV パーサー + 5 フォーマット検出ロジックがあるが、パーサー自体の専用ユニットテストがない。フォーマット検出はインテグレーションテスト経由で暗黙的にカバーされているが、エッジケース（BOM、引用符内改行、欠損カラム）の直接テストが望ましい。

---

### 9.6 追加の i18n

#### 9.6.1 [OK] 翻訳キーの整合性

en.json / ja.json に以下のキーを追加（完全一致）:

- `SecureNoteForm.notes` / `SecureNoteForm.notesPlaceholder`
- `Common.importAnother`

全 37 トップレベルキー、両ロケールで同期を確認。

---

### 追加指摘サマリー

| # | 重要度 | カテゴリ | 概要 | ファイル | 状態 |
|---|--------|---------|------|---------|------|
| 9.2.4 | MEDIUM | 機能 | フォーム内データ取得の無声失敗 | use-org-attachments/folders, use-personal-folders | 新規 |
| 9.2.5 | LOW | 品質 | スナップショットパラメータリスト肥大 | use-org-password-form-derived.ts | 新規 |
| 9.3.4 | LOW | 機能 | エクスポート復号失敗のサイレントスキップ | export-dialog.tsx | 新規 |
| 9.5.2 | LOW | テスト | インポートパーサーのユニットテスト不足 | import-dialog-parsers.ts | 新規 |

---

### 前回指摘の最終状態（全ブランチ通算）

| # | 重要度 | 概要 | 状態 |
| --- | ------ | ---- | ---- |
| 1.1 (→9.1.1) | MEDIUM | タグフィルタ非対称性 | **解決済み** ✅ |
| 1.2 (→9.1.2) | LOW | fetch エラー無声失敗 | **解決済み** ✅ |
| 1.3 (→9.1.3) | LOW | 並行フェッチ競合 | **解決済み** ✅ |
| 2.2 (→9.1.5) | LOW | MEMBER/OWNER テスト | **解決済み** ✅ |
| 3.2 | MEDIUM | sidebar-sections カバレッジ | **解決済み** ✅（`1cf4c0c` で VaultSection, CategoriesSection テスト追加） |
| 3.3 | MEDIUM | FolderTreeNode テスト | **解決済み** ✅（`1cf4c0c` で展開/折りたたみ・コールバック・depth テスト追加） |
| 3.4 | LOW | audit-action-key テスト | **解決済み** ✅（`1cf4c0c` で追加） |
| 3.5 | LOW | props 転送の未検証 | 未対応（継続） |
| 3.6 | LOW | OrgDashboardPage テスト | 未対応（継続） |
| 5.4 (→9.1.4) | NOTE | OrganizeTagItem 重複 | **解決済み** ✅ |

**全体解決率:** 26 件中 22 件解決（85%）

---

### 更新された指摘サマリー（最終）

| # | 重要度 | カテゴリ | 概要 | ファイル | 状態 |
|---|--------|---------|------|---------|------|
| 3.5 | LOW | テスト | props 転送の未検証 | use-sidebar-view-model.test.ts | 継続 |
| 3.6 | LOW | テスト | OrgDashboardPage テストカバレッジ不足 | orgs/[orgId]/page.test.tsx | 継続 |
| 9.2.4 | MEDIUM | 機能 | フォーム内データ取得の無声失敗 | use-org-attachments/folders 等 | 新規 |
| 9.2.5 | LOW | 品質 | スナップショットパラメータリスト肥大 | use-org-password-form-derived.ts | 新規 |
| 9.3.4 | LOW | 機能 | エクスポート復号失敗のサイレントスキップ | export-dialog.tsx | 新規 |
| 9.5.2 | LOW | テスト | インポートパーサーのユニットテスト不足 | import-dialog-parsers.ts | 新規 |

HIGH: 0件 / MEDIUM: 1件 / LOW: 5件

---

### 総評（追加分）

251 コミットの追加で、ブランチ全体の規模は 286 コミットに拡大。主要な成果:

**前回指摘の完全解消:**

- 前回残存の MEDIUM 3件（タグフィルタ、sidebar-sections、FolderTreeNode）+ LOW 4件 + NOTE 1件がすべて解決
- 特に `b2cf5f7`（シーケンスガード）と `8afec5c`（エラー公開 + 自動回復）の修正品質が高い

**フォームリファクタリングの品質:**

- Model/Controller/Presenter の分離が明確で、テスタビリティが大幅に向上
- 58 新規テストファイルで各レイヤーを独立検証
- 共有コンポーネント（ログインフィールド、タグ+フォルダセクション、ナビゲーション）の抽出により個人/org 間のコード重複を大幅削減

**セキュリティ:**

- パスキー API は適切な認証/認可 + Zod バリデーション + Blob 暗号化
- インポート/エクスポートの暗号化実装は堅牢（PBKDF2 600k + AES-256-GCM）
- パストラバーサル防止のサニタイズ + テスト済み
- 重大なセキュリティ問題は 0 件

**残存指摘:**

- MEDIUM 1件（フォーム内データ取得の無声失敗）はサイドバーで修正済みのパターンと同種であり、同様の修正が望ましい
- LOW 5件はいずれも品質・テスト改善であり、機能的リスクは極めて低い
