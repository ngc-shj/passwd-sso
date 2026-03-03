# 個人・チーム パスワード画面の一括操作コード重複解消

## Context

個人パスワード画面とチームパスワード画面で、一括選択・一括操作（trash/archive/unarchive/restore）のロジックが5〜6ファイルにわたって重複している。選択状態管理、APIコール+toast、確認ダイアログ、フローティングアクションバーの4パターンが各画面にコピペされており、推定400〜500行の重複がある。これを共通フック・コンポーネントに抽出し、保守性を向上させる。

ユーザー確認済み方針: 個人とチームの見た目は基本的に同じ。チームが異なるのはAPI呼び出し先と作成者情報等の限定的な差異のみ。

## 対象ファイル（現状）

| ファイル | 行数 | 重複パターン |
| --- | --- | --- |
| `src/components/passwords/password-list.tsx` | 554 | 選択state, bulkAction handler, AlertDialog, FloatingBar |
| `src/components/passwords/trash-list.tsx` | 396 | 選択state, bulkRestore handler, AlertDialog, FloatingBar |
| `src/components/passwords/password-dashboard.tsx` | 395 | 選択mode state, ESCハンドラ, selectAll header |
| `src/app/[locale]/dashboard/teams/[teamId]/page.tsx` | 1,099 | 選択state, bulkAction handler, AlertDialog, FloatingBar |
| `src/components/team/team-archived-list.tsx` | 652 | 選択state, bulkUnarchive/Trash handler, AlertDialog, FloatingBar |
| `src/components/team/team-trash-list.tsx` | 435 | 選択state, bulkRestore handler, AlertDialog, FloatingBar |

重複している選択ヘルパー（100%同一ロジック）:

- `src/components/passwords/password-list-selection.ts` (17行)
- `src/components/passwords/trash-list-selection.ts` (25行)

## 実装ステップ

### Step 1: 選択ヘルパー統合

`password-list-selection.ts` と `trash-list-selection.ts` を1つに統合する。

**新規作成:** `src/lib/bulk-selection-helpers.ts`

```typescript
/**
 * Remove IDs from `prev` that no longer exist in `currentIds`.
 * Returns `prev` unchanged (by reference) when nothing was removed,
 * enabling React state bailout to avoid unnecessary re-renders.
 */
export function reconcileSelectedIds(
  prev: Set<string>,
  currentIds: readonly string[],
): Set<string>;
export function toggleSelectAllIds(
  entryIds: readonly string[],
  checked: boolean,
): Set<string>;
export function toggleSelectOneId(
  prev: Set<string>,
  id: string,
  checked: boolean,
): Set<string>;
```

- `password-list-selection.ts` の最適化版（`prev.size === 0` の早期リターン、参照等価性チェック）をベースにする
- 旧ファイル2つは削除

**テスト:** `src/lib/bulk-selection-helpers.test.ts` に統合。追加テストケース:

- `prev.size === 0` 時に同一参照が返ることの検証
- サイズ変化なし時に同一参照が返ることの検証

### Step 2: `useBulkSelection` フック

選択状態管理を1つのフックに集約する。

**新規作成:** `src/hooks/use-bulk-selection.ts`

```typescript
interface BulkSelectionHandle {
  toggleSelectAll: (checked: boolean) => void;
  // allSelected は含めない — onSelectedCountChange で伝達済み
}

interface UseBulkSelectionOptions {
  entryIds: readonly string[];
  selectionMode: boolean;
  selectAllRef?: React.Ref<BulkSelectionHandle>; // フック内部で useImperativeHandle
  onSelectedCountChange?: (count: number, allSelected: boolean) => void;
}

interface UseBulkSelectionReturn {
  selectedIds: Set<string>;
  allSelected: boolean;
  toggleSelectOne: (id: string, checked: boolean) => void;
  toggleSelectAll: (checked: boolean) => void;
  clearSelection: () => void;
}
```

内部で以下を処理（現在5ファイルに重複）:

1. `entryIds` 変更時の `reconcileSelectedIds` effect
2. `selectionMode=false` 時の自動クリア effect
3. `onSelectedCountChange` 通知 effect（`count` と `allSelected` の両方を伝達）
4. `allSelected` 算出
5. `selectAllRef` が渡された場合の `useImperativeHandle` 呼び出し（`toggleSelectAll` のみ公開）

**設計上の注意:**

- **ESCキーハンドラ** はダッシュボード側に残す（個人ダッシュボードではESCが検索クリアと併用されるため）
- **`effectiveSelectionMode`**: チーム子コンポーネントの `scopedTeamId ? (selectionMode ?? false) : false` は呼び出し元で解決してからフックに渡す。フック内部ではそのまま使用。
- **`entryIds` にはフィルタ/ソート済みのリストを渡す**: 現在の `team-archived-list.tsx` が `reconcileSelectedIds` に全エントリ（`entries`）を渡している不整合を修正し、`sortedFiltered.map(e => e.id)` に統一する（バグ修正）

**テスト:** `src/hooks/use-bulk-selection.test.ts`

- reconciliation on entryIds change
- reset on selectionMode toggle
- `onSelectedCountChange` が `(size, allSelected)` の正しい組み合わせを渡す
- `allSelected` が `entryIds` 空配列時に `false` を返す
- `allSelected` が全選択時のみ `true` になる

### Step 3: `useBulkAction` フック

一括操作のfetch+toast+状態管理を共通化する。エンドポイント/ボディ組み立て/カウント抽出はフック内部で処理し、呼び出し側のボイラープレートを最小化する。

**新規作成:** `src/hooks/use-bulk-action.ts`

```typescript
type BulkActionType = "trash" | "archive" | "unarchive" | "restore";
type BulkScope = { type: "personal" } | { type: "team"; teamId: string };

interface UseBulkActionOptions {
  selectedIds: Set<string>;
  scope: BulkScope;
  t: (key: string, params?: Record<string, unknown>) => string;
  /**
   * Called after a successful bulk action.
   * The caller is responsible for:
   * - Clearing selection (clearSelection())
   * - Refreshing the entry list (fetchPasswords(), etc.)
   * - Notifying parent of data changes (onDataChange?.())
   */
  onSuccess: () => void;
}

interface UseBulkActionReturn {
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  pendingAction: BulkActionType | null;
  processing: boolean;
  requestAction: (action: BulkActionType) => void; // ダイアログを開く
  executeAction: () => Promise<void>; // ダイアログ確認時に呼ぶ
}
```

**フック内部のエンドポイント解決:**

```typescript
function resolveEndpoint(scope: BulkScope, action: BulkActionType): string {
  if (scope.type === "team") {
    switch (action) {
      case "trash":
        return apiPath.teamPasswordsBulkTrash(scope.teamId);
      case "archive":
      case "unarchive":
        return apiPath.teamPasswordsBulkArchive(scope.teamId);
      case "restore":
        return apiPath.teamPasswordsBulkRestore(scope.teamId);
    }
  }
  switch (action) {
    case "trash":
      return apiPath.passwordsBulkTrash();
    case "archive":
    case "unarchive":
      return apiPath.passwordsBulkArchive();
    case "restore":
      return apiPath.passwordsBulkRestore();
  }
}
```

**フック内部のボディ組み立て/カウント抽出/i18nキー解決:**

```typescript
function buildBody(
  action: BulkActionType,
  ids: string[],
): Record<string, unknown> {
  if (action === "archive" || action === "unarchive") {
    return { ids, operation: action };
  }
  return { ids };
}

function extractCount(
  json: Record<string, unknown>,
  fallback: number,
): number {
  return (json.processedCount ??
    json.archivedCount ??
    json.unarchivedCount ??
    json.movedCount ??
    json.restoredCount ??
    fallback) as number;
}

const TOAST_KEYS: Record<BulkActionType, { success: string; error: string }> = {
  archive: { success: "bulkArchived", error: "bulkArchiveFailed" },
  unarchive: { success: "bulkUnarchived", error: "bulkUnarchiveFailed" },
  trash: { success: "bulkMovedToTrash", error: "bulkMoveFailed" },
  restore: { success: "bulkRestored", error: "bulkRestoreFailed" },
};
```

**使用例 — 個人パスワードリスト:**

```typescript
const { dialogOpen, setDialogOpen, pendingAction, processing, requestAction, executeAction } =
  useBulkAction({
    selectedIds,
    scope: { type: "personal" },
    t: tl,
    onSuccess: () => {
      clearSelection();
      fetchPasswords();
      onDataChange?.();
    },
  });
```

**使用例 — チーム:**

```typescript
const { ... } = useBulkAction({
  selectedIds,
  scope: { type: "team", teamId },
  t: tl,
  onSuccess: () => {
    clearSelection();
    fetchPasswords(); // 子コンポーネント自身のfetch
  },
});
```

**テスト:** `src/hooks/use-bulk-action.test.ts`

- 各アクションタイプで正しいエンドポイント・ボディが送信される
- personal / team で異なるエンドポイントが使われる
- カウントフォールバック連鎖の網羅テスト:
  - `processedCount` あり → そのまま使用
  - `processedCount` なし、`archivedCount` あり → フォールバック
  - カウントフィールド全欠如 → `selectedIds.size` にフォールバック
- エラー時のtoast検証
- `selectedIds.size === 0` のガード検証
- `processing` の `true→false` 状態遷移

### Step 4: `BulkActionConfirmDialog` コンポーネント

確認ダイアログのAlertDialogテンプレートを共通化。

**新規作成:** `src/components/bulk/bulk-action-confirm-dialog.tsx`

```typescript
interface BulkActionConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  cancelLabel: string;
  confirmLabel: string;
  processing: boolean;
  onConfirm: () => void;
}
```

各呼び出し側は `pendingAction` に応じて `title`/`description` を算出して渡す。

### Step 5: `FloatingActionBar` コンポーネント

フローティングアクションバーの外枠を共通化。ボタンは `children` として渡す。

**新規作成:** `src/components/bulk/floating-action-bar.tsx`

```typescript
interface FloatingActionBarProps {
  visible: boolean;
  position: "sticky" | "fixed"; // 個人=sticky, チーム=fixed
  children: React.ReactNode;
}
```

- `position="sticky"`: 個人画面用 `sticky bottom-4 z-40 mt-2 ...`
- `position="fixed"`: チーム画面用 `fixed bottom-4 inset-x-0 z-40 ... md:pl-60 pointer-events-none`
- 共通: `border bg-background/95 ... backdrop-blur`

### Step 6: 各ファイルの統合リファクタリング

親コンポーネントから先に移行し、インターフェース不整合を防ぐ:

**グループA: 個人画面（順次移行）**

1. **`password-list.tsx`** — リファレンス実装として最初に着手
2. **`trash-list.tsx`** — restore のみ
3. **`password-dashboard.tsx`** — ダッシュボード側の軽微な変更のみ

**グループB: チーム画面（親子を同一ステップで移行）**

4. **`[teamId]/page.tsx` + `team-archived-list.tsx` + `team-trash-list.tsx`** — 同一コミットで移行し、ref/propsインターフェースの不整合を防ぐ

**移行時のバグ修正:**

- `team-archived-list.tsx` の `reconcileSelectedIds` の引数を `entries.map(e => e.id)` から `sortedFiltered.map(e => e.id)` に修正（フック化で `entryIds` にフィルタ済みリストを渡すことで自然に解消）
- `team-trash-list.tsx` の `selectAllRef ?? ref` 二重管理を `selectAllRef` 一本に統一（`forwardRef` を廃止）

### Step 7: テスト更新

**テストファイルの責務定義:**

| テストファイル | 責務 |
| --- | --- |
| `bulk-selection-helpers.test.ts` | 純粋関数の動作（reconcile, toggleAll, toggleOne）+ 最適化パス（同一参照） |
| `use-bulk-selection.test.ts` | フックの状態管理（reconcile effect, reset, count callback, allSelected計算） |
| `use-bulk-action.test.ts` | フック内部ロジック（endpoint解決, body組立, count抽出フォールバック, processing遷移, toast, ガード）+ personal/team両スコープ |
| `password-list-bulk-actions.test.ts` | `vi.mock` でフック呼び出しを検証（`scope: { type: "personal" }`）。ソース文字列テストから移行 |
| `trash-list-bulk-restore.test.ts` | `vi.mock` でフック呼び出しを検証（restore アクション）。ソース文字列テストから移行 |

### Step 8: 旧ファイル削除

- `src/components/passwords/password-list-selection.ts`
- `src/components/passwords/trash-list-selection.ts`
- `src/components/passwords/trash-list-selection.test.ts`

## 新規作成ファイル一覧

| ファイル | 目的 | 推定行数 |
| --- | --- | --- |
| `src/lib/bulk-selection-helpers.ts` | 選択ヘルパー（純粋関数） | ~20 |
| `src/lib/bulk-selection-helpers.test.ts` | ヘルパーテスト | ~50 |
| `src/hooks/use-bulk-selection.ts` | 選択状態管理フック | ~60 |
| `src/hooks/use-bulk-selection.test.ts` | フックテスト | ~80 |
| `src/hooks/use-bulk-action.ts` | 一括操作フック（endpoint/body/count内部解決） | ~90 |
| `src/hooks/use-bulk-action.test.ts` | フックテスト（フォールバック網羅） | ~120 |
| `src/components/bulk/bulk-action-confirm-dialog.tsx` | 確認ダイアログ | ~50 |
| `src/components/bulk/floating-action-bar.tsx` | フローティングバー | ~35 |

## 削除ファイル

- `src/components/passwords/password-list-selection.ts`
- `src/components/passwords/trash-list-selection.ts`
- `src/components/passwords/trash-list-selection.test.ts`

## 検証方法

1. `npm run lint` — 型エラー・lint エラーなし
2. `npx vitest run` — 全テストパス
3. `npm run build` — プロダクションビルド成功
4. 手動検証:
   - 個人パスワード一覧: 選択→アーカイブ/ゴミ箱の一括操作
   - 個人ゴミ箱: 選択→一括復元
   - チームパスワード一覧: 選択→アーカイブ/ゴミ箱の一括操作
   - チームアーカイブ: 選択→アーカイブ解除/ゴミ箱
   - チームゴミ箱: 選択→一括復元
   - ESCキーで選択モード終了
   - ビュー切替で選択リセット
   - チーム検索フィルタ適用時の全選択チェックボックス表示
