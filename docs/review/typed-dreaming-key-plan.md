# Settings UI 改善: スクロール + 検索 + Webhook UI

## Context

設定ページのメンバー一覧が増えた際に以下の問題がある:

1. メンバー一覧がスクロールせず、下の設定項目（SCIM、招待、オーナー移譲等）にアクセスできない
2. メンバーの検索機能がない
3. Webhook の API は実装済みだが UI がない

## 変更概要

| 機能 | 対象 | 変更内容 |
| ---- | ---- | -------- |
| スクロール | tenant-members-card, team settings | メンバーリストに `max-h-96 overflow-y-auto` 追加 |
| 検索 | tenant-members-card, team settings | インライン検索入力で名前・メール絞り込み |
| Webhook UI | team settings | 新規 `TeamWebhookCard` コンポーネント + 4番目のタブ |

---

## Step 1: スクロール可能なメンバーリスト

### 1A: `src/components/settings/tenant-members-card.tsx`

L128 の `<div className="space-y-2">` を `<div className="max-h-96 space-y-2 overflow-y-auto">` に変更。

### 1B: `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx`

L418 のメンバーリスト `<div className="space-y-2">` → `<div className="max-h-96 space-y-2 overflow-y-auto">`

### 1C: 同ファイル — Transfer Ownership リスト

L496 の `<div className="space-y-2">` → `<div className="max-h-96 space-y-2 overflow-y-auto">`

---

## Step 2: メンバー検索

### 2A: i18n キー追加

**`messages/{en,ja}/TenantAdmin.json`**:

- `"searchMembers"`: `"Search members..."` / `"メンバーを検索..."`
- `"noMatchingMembers"`: `"No members match your search."` / `"検索に一致するメンバーがいません。"`

**`messages/{en,ja}/Team.json`**:

- `"searchMembers"`: `"Search members..."` / `"メンバーを検索..."`
- `"noMatchingMembers"`: `"No members match your search."` / `"検索に一致するメンバーがいません。"`

### 2B: `src/components/settings/tenant-members-card.tsx`

1. `Search` (lucide) + `Input` import 追加
2. `const [searchQuery, setSearchQuery] = useState("")` 追加
3. フィルタロジックを **純粋関数** として分離:

   ```tsx
   // src/lib/filter-members.ts
   export function filterMembers<T extends { name: string | null; email: string | null }>(
     members: T[],
     query: string,
   ): T[] {
     const q = query.trim().toLowerCase();
     if (!q) return members;
     return members.filter(
       (m) =>
         (m.name?.toLowerCase().includes(q) ?? false) ||
         (m.email?.toLowerCase().includes(q) ?? false),
     );
   }
   ```

4. `CardContent` 内、メンバーリストの上に検索入力を配置（members.length > 0 の場合のみ表示）:

   ```tsx
   <div className="relative mb-3">
     <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
     <Input placeholder={t("searchMembers")} value={searchQuery}
       onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
   </div>
   ```

5. `members.map(...)` → `filteredMembers.map(...)`
6. フィルタ結果 0 件時の空メッセージ表示

### 2C: `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx`

- 同パターンで `memberSearch` state + `filterMembers()` 使用
- メンバーリストカード内のセクションタイトル下に検索入力配置
- `members.map(...)` → `filteredMembers.map(...)`
- Transfer Ownership リストも **同一の `memberSearch` state を共有**し `filteredMembers` ベースに変更（同タブ内なので検索結果を連動させる）

---

## Step 3: Webhook 管理 UI

### 3A: API パスヘルパー追加

**`src/lib/constants/api-path.ts`** の `apiPath` に追加:

```typescript
teamWebhooks: (teamId: string) => `${API_PATH.TEAMS}/${teamId}/webhooks`,
teamWebhookById: (teamId: string, webhookId: string) =>
  `${API_PATH.TEAMS}/${teamId}/webhooks/${webhookId}`,
```

### 3B: `TeamWebhookCard` コンポーネント新規作成

**新規: `src/components/team/team-webhook-card.tsx`**

Props: `{ teamId: string; locale: string }`

構造:

1. **ヘッダー**: タイトル + 説明（`TeamWebhook` namespace）
2. **Webhook 一覧**: `max-h-80 overflow-y-auto` のスクロール可能リスト
   - URL（truncate）, Active/Inactive バッジ, failCount, lastDelivered
   - 削除ボタン（AlertDialog 確認付き）
   - 削除後は `fetchWebhooks()` で再取得（ScimTokenManager の handleRevoke → fetchTokens パターン準拠）
   - 空状態: `t("noWebhooks")`
3. **作成フォーム**: `border-t pt-4` で区切り
   - URL 入力: `<Input type="url">`
   - イベント選択: `AUDIT_ACTION_GROUPS_TEAM` のグループ別 `Collapsible` + `Checkbox`
     - **`group:webhook` グループは除外**（WEBHOOK_DELIVERY_FAILED の自己参照防止）
     - グループヘッダーの Checkbox で一括選択
     - 個別アクションの Checkbox
     - イベント選択エリアは `max-h-64 overflow-y-auto` でスクロール
   - 作成ボタン: URL 空 / イベント未選択 / 上限到達時は disabled
   - 上限到達時は `t("limitReached")` 表示
4. **シークレット表示**: 作成成功後に React state (`newSecret`) で保持し表示
   - `<Input readOnly autocomplete="off" className="font-mono text-xs" />` + `CopyButton`
   - OK ボタン押下で `setNewSecret(null)` → 非表示
   - ページ遷移・コンポーネント unmount でも自動クリア（React state のライフサイクル）
   - GET API はシークレットを返さないため再表示不可

i18n: `useTranslations("TeamWebhook")` + `useTranslations("AuditLog")`（イベントラベル用）

参考パターン: `src/components/team/team-scim-token-manager.tsx`（fetch/create/delete/show-secret-once）

### 3C: チーム設定ページに Webhook タブ追加

**`src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx`**:

1. `TeamWebhookCard` import
2. `const tWebhook = useTranslations("TeamWebhook")` 追加
3. `TabsList` を admin 時 `grid-cols-4` に変更
4. Webhook タブトリガー追加: `{isAdmin && <TabsTrigger value="webhook">{tWebhook("title")}</TabsTrigger>}`
5. Webhook タブコンテンツ追加:

   ```tsx
   {isAdmin && (
     <TabsContent value="webhook" className="space-y-4 mt-0">
       <TeamWebhookCard teamId={teamId} locale={locale} />
     </TabsContent>
   )}
   ```

---

## Step 4: テスト

### 4A: `src/lib/filter-members.test.ts`

- 空クエリ → 全メンバー返却
- 名前部分一致
- メール部分一致
- 大文字小文字無視
- `name: null` のメンバー（email のみで検索）
- 日本語名の検索
- 一致なし → 空配列

### 4B: `src/lib/constants/api-path.test.ts` 更新

- `teamWebhooks("team-1")` → `"/api/teams/team-1/webhooks"`
- `teamWebhookById("team-1", "wh-1")` → `"/api/teams/team-1/webhooks/wh-1"`

### 4C: `src/components/team/team-webhook-card.test.tsx`

- fetchWebhooks 結果のレンダリング（URL、バッジ表示）
- 上限 5 件到達時の作成ボタン disabled
- 作成成功後のシークレット表示 → OK 押下で非表示
- 削除確認ダイアログの表示とハンドラ呼び出し
- fetch エラー時の UI 表示
- イベント未選択時の作成ボタン disabled
- `group:webhook` グループが選択肢に含まれないこと

### 4D: webhook API テスト補強（既存ファイル）

- `events: []` → 400 レスポンス
- 不正イベント名 (`"INVALID_EVENT"`, `"group:webhook"`) → 400 レスポンス
- GET レスポンスに `secret` / `secretEncrypted` フィールドが含まれないこと

---

## 実装順序

1. Step 1: スクロール（3箇所の className 変更のみ）
2. Step 2: 検索（filter-members.ts + i18n + state + フィルタ）
3. Step 3: Webhook UI（api-path + 新コンポーネント + タブ追加）
4. Step 4: テスト

## 検証

### 自動テスト

- `npm test` 全パス
- `npm run lint` エラーなし
- `npm run build` 成功

### 手動確認

- メンバー 10 人以上でスクロールが機能し、下のカードが見えること
- 検索クリアで全メンバーが再表示されること
- Webhook 作成: HTTPS URL + イベント選択 → 成功 + シークレット表示
- Webhook 削除: 確認ダイアログ → 成功
- 上限 5 件到達時に作成ボタンが無効化されること
