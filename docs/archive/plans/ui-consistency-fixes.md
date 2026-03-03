# UI 一貫性修正 — 実装計画

## Context

PR #104 (Batch C) マージ後、UI の一貫性に関する4つの修正を行う。ブランチ `fix/ui-consistency-improvements` で対応。

---

## Step 1: 英語ロケール「Vault」→「Personal Vault」

**File:** `messages/en.json`

サイドバーの `personalVault` キーを変更:
```json
// Before
"personalVault": "Vault"

// After
"personalVault": "Personal Vault"
```

> 日本語は既に `"personalVault": "個人の保管庫"` で差別化済み。変更不要。

---

## Step 2: Org 設定ボタンの高さ統一

**File:** `src/app/[locale]/dashboard/orgs/page.tsx`

「Create Organization」ボタンから `size="sm"` を削除し、パスワードダッシュボードの「新規作成」ボタンと同じデフォルトサイズに統一。

```tsx
// Before (line 62)
<Button size="sm">

// After
<Button>
```

---

## Step 3: Org 一覧の外側 Card 削除

**File:** `src/app/[locale]/dashboard/orgs/page.tsx`

各組織アイテムは既に `rounded-xl border bg-card/80 p-4` で個別カードスタイルが適用されているため、外側の `<Card>` ラッパーは冗長。削除してグリッドのみを残す。

```tsx
// Before (lines 72-114)
<Card className="rounded-xl border bg-card/80">
  <CardContent className="p-4">
    <div className="grid ...">
      {/* org items */}
    </div>
  </CardContent>
</Card>

// After
<div className="grid ...">
  {/* org items */}
</div>
```

不要になった `Card`, `CardContent` import も削除 (他で使用していない場合)。

---

## Step 4: ソート順を検索カードに移動

### 4a. Personal Dashboard

**File:** `src/components/passwords/password-dashboard.tsx`

`EntryListHeader` の `actions` から `EntrySortMenu` を削除し、検索カードの `SearchBar` の隣に配置。

```tsx
// Before: actions slot に EntrySortMenu
<EntryListHeader actions={<>...<EntrySortMenu ... />...</>} />
...
<Card><CardContent><SearchBar ... /></CardContent></Card>

// After: actions から EntrySortMenu を削除、検索カード内に移動
<EntryListHeader actions={<>...(EntrySortMenu以外)...</>} />
...
<Card>
  <CardContent className="flex items-center gap-2">
    <div className="flex-1">
      <SearchBar ... />
    </div>
    <EntrySortMenu ... />
  </CardContent>
</Card>
```

### 4b. Org Dashboard

**File:** `src/app/[locale]/dashboard/orgs/[orgId]/page.tsx`

同じパターンで `EntrySortMenu` を `EntryListHeader` actions → 検索カード内に移動。

---

## 変更ファイル一覧

| # | ファイル | 変更内容 |
|---|---------|---------|
| 1 | `messages/en.json` | `personalVault`: "Vault" → "Personal Vault" |
| 2 | `src/app/[locale]/dashboard/orgs/page.tsx` | Button size="sm" 削除 + 外側 Card 削除 |
| 3 | `src/components/passwords/password-dashboard.tsx` | EntrySortMenu を検索カードに移動 |
| 4 | `src/app/[locale]/dashboard/orgs/[orgId]/page.tsx` | EntrySortMenu を検索カードに移動 |

---

## Verification

```bash
# 1. 型チェック
npx tsc --noEmit

# 2. テスト
npx vitest run

# 3. Lint
npm run lint

# 4. ビルド
npm run build

# 5. 目視確認
# - サイドバー: 英語で "Personal Vault" と表示
# - Org ページ: ボタン高さがダッシュボードと統一
# - Org 一覧: 外側カードが消え、個別カードのみ
# - Personal/Org ダッシュボード: ソートメニューが検索バー横に表示
```
