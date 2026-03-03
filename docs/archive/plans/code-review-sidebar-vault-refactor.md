# コードレビュー残存指摘の対応計画

## Context

`feat/sidebar-vault-context-refactor` ブランチのコードレビュー（[feat-sidebar-vault-context-refactor.md](docs/temp/feat-sidebar-vault-context-refactor.md)）で残存した 6 件の指摘に対応する。

残存: HIGH 0件 / **MEDIUM 1件** / LOW 5件

---

## 1. [MEDIUM] フォーム内データ取得の無声失敗 (9.2.4)

### 対象ファイル
- [use-org-attachments.ts](src/hooks/use-org-attachments.ts) — L16: `.catch(() => setAttachments([]))`
- [use-org-folders.ts](src/hooks/use-org-folders.ts) — L20: `.catch(() => {})`
- [use-personal-folders.ts](src/hooks/use-personal-folders.ts) — L18: `.catch(() => {})`

### 参考パターン
[use-sidebar-data.ts](src/hooks/use-sidebar-data.ts) L48-70 の `fetchArray()` + `lastError` state

### 修正内容

各フックに `fetchError: string | null` state を追加し、エラー時にメッセージを設定、成功時にクリア。

**use-org-attachments.ts:**
```typescript
const [fetchError, setFetchError] = useState<string | null>(null);

fetch(apiPath.orgPasswordAttachments(orgId, entryId))
  .then((res) => {
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  })
  .then((loaded: OrgAttachmentMeta[]) => {
    setAttachments(loaded);
    setFetchError(null);
  })
  .catch((e: unknown) => {
    setAttachments([]);
    setFetchError(`Failed to load attachments: ${e instanceof Error ? e.message : "unknown"}`);
  });

return { attachments, setAttachments, fetchError };
```

**use-org-folders.ts / use-personal-folders.ts:** 同パターン。return に `fetchError` 追加。

### テスト
各フックのテスト（既存 or 新規）に fetch 失敗時の `fetchError` 検証を追加。

---

## 2. [LOW] props 転送の未検証 (3.5)

### 対象ファイル
- [use-sidebar-view-model.test.ts](src/hooks/use-sidebar-view-model.test.ts)

### 修正内容

既存テスト "forwards sidebar state and handlers"（L77-90）に不足している props の検証を追加:

```typescript
// 既に検証済み: selectedTags, selectedFolders, isOpen, toggleSection,
//   onCreateFolder, onEditFolder, onDeleteFolder, onEditTag, onDeleteTag

// 追加:
expect(result.current.t).toBe(params.t);
expect(result.current.tOrg).toBe(params.tOrg);
expect(result.current.vaultContext).toBe(params.vaultContext);
expect(result.current.orgs).toBe(params.orgs);
expect(result.current.selectedOrg).toBe(params.selectedOrg);
expect(result.current.selectedOrgCanManageFolders).toBe(false);
expect(result.current.selectedOrgCanManageTags).toBe(false);
expect(result.current.selectedTypeFilter).toBeNull();
expect(result.current.selectedFolderId).toBeNull();
expect(result.current.selectedTagId).toBeNull();
expect(result.current.isSelectedVaultAll).toBe(true);
expect(result.current.isSelectedVaultFavorites).toBe(false);
expect(result.current.isSelectedVaultArchive).toBe(false);
expect(result.current.isSelectedVaultTrash).toBe(false);
expect(result.current.isWatchtower).toBe(false);
expect(result.current.isShareLinks).toBe(false);
expect(result.current.isEmergencyAccess).toBe(false);
expect(result.current.isPersonalAuditLog).toBe(false);
expect(result.current.activeAuditOrgId).toBeNull();
```

---

## 3. [LOW] OrgDashboardPage テストカバレッジ不足 (3.6)

### 対象ファイル
- [page.test.tsx](src/app/[locale]/dashboard/orgs/[orgId]/page.test.tsx) — 現在 3 テスト

### 追加テスト (~6 tests)

既存の `setupFetch()` + `renderPage()` ヘルパーを活用:

```
describe("OrgDashboardPage — scopes", () => {
  1. scope=archive → OrgArchivedList がレンダーされる
  2. scope=trash → OrgTrashList がレンダーされる
  3. scope=favorites → favorites=true パラメータ付きで passwords fetch
});

describe("OrgDashboardPage — role-based rendering", () => {
  4. VIEWER ロール → "New Item" ボタンが表示されない
  5. OWNER ロール → "New Item" ボタンが表示される
});

describe("OrgDashboardPage — error handling", () => {
  6. org fetch 失敗 → エラー状態（toast.error 呼び出し or エラーメッセージ）
});
```

注意: OrgArchivedList / OrgTrashList は既にスタブ化済み。scope は `mockSearchParams.set("scope", "archive")` で設定。

---

## 4. [LOW] スナップショットパラメータリスト肥大 (9.2.5)

### 対象ファイル
- [use-org-password-form-derived.ts](src/hooks/use-org-password-form-derived.ts) — L81-118 useMemo deps

### 現状分析

`buildCurrentSnapshot()` 自体は既に 3 つの構造化引数 `{ effectiveEntryType, entryKindState, entryValues }` を受け取る設計（[org-password-form-derived-helpers.ts](src/hooks/org-password-form-derived-helpers.ts)）。問題は useMemo の依存配列に 30+ 個の個別変数がリストされている点。

### 修正内容

`entryValues` を JSON シリアライズした文字列を依存キーとして使用し、依存配列を簡素化:

```typescript
// Before: 30+ individual deps
const currentSnapshot = useMemo(
  () => buildCurrentSnapshot({ effectiveEntryType, entryKindState, entryValues }),
  [effectiveEntryType, title, notes, selectedTags, orgFolderId, isLoginEntry, /* ... 25+ more */],
);

// After: serialized key
const entryValuesKey = JSON.stringify(entryValues);
const currentSnapshot = useMemo(
  () => buildCurrentSnapshot({ effectiveEntryType, entryKindState, entryValues }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [effectiveEntryType, isLoginEntry, isNote, isCreditCard, isIdentity, isPasskey, entryValuesKey],
);
```

同様に `baselineSnapshot` の依存配列も確認（こちらは `editData` が安定参照なので問題なし）。

`entryValues` の個別変数の destructuring（L41-72）は不要になるため削除。

---

## 5. [LOW] エクスポート復号失敗のサイレントスキップ (9.3.4)

### 対象ファイル
- [export-dialog.tsx](src/components/passwords/export-dialog.tsx) — L115-117, L165
- [org-export-dialog.tsx](src/components/org/org-export-dialog.tsx) — L104-106, L154

### 修正内容

**個別エントリの失敗カウント + toast 通知:**

```typescript
// export-dialog.tsx / org-export-dialog.tsx
import { toast } from "sonner";

let skippedCount = 0;
for (const raw of rawEntries) {
  // ...
  try { /* decrypt/fetch */ }
  catch { skippedCount++; }
}

// ダウンロード後:
if (skippedCount > 0) {
  toast.warning(t("exportSkipped", { count: String(skippedCount) }));
}

// 外側 catch:
} catch {
  toast.error(t("exportFailed"));
} finally {
```

**i18n キー追加** (`messages/en.json` + `messages/ja.json`):

```json
// Export namespace
"exportSkipped": "{count} entries could not be exported and were skipped.",
"exportFailed": "Export failed. Please try again."
```

```json
// ja
"exportSkipped": "{count} 件のエントリをエクスポートできませんでした（スキップ）。",
"exportFailed": "エクスポートに失敗しました。もう一度お試しください。"
```

---

## 6. [LOW] インポートパーサーのユニットテスト不足 (9.5.2)

### 対象ファイル
- [import-dialog-parsers.test.ts](src/components/passwords/import-dialog-parsers.test.ts) — 現在 42 tests

### 追加テスト (~6 tests)

既存テストに不足しているエッジケース:

```
describe("parseCsvLine — edge cases", () => {
  1. BOM 付き UTF-8 先頭行の処理
  2. 引用符内の改行文字（line parser は行単位なので改行は渡されないが確認）
});

describe("parseCsv — edge cases", () => {
  3. ヘッダーのみ（データ行なし）→ entries 空（既存テスト "single-line" でカバー確認）
  4. 列数不足の行（fields.length < 2）→ スキップ
  5. BOM 付き先頭行 → ヘッダー正常解析
});

describe("parseJson — edge cases", () => {
  6. 配列でもオブジェクトでもない JSON → entries 空
});
```

注: `parseCsv` の BOM 処理は L113 `text.split(/\r?\n/)` で split 後、L116 `parseCsvLine(lines[0])` でヘッダー解析。BOM (`\uFEFF`) が先頭に残るため、`detectFormat` が失敗する可能性がある。BOM 除去が未実装の場合は、`parseCsv` に `text.replace(/^\uFEFF/, "")` を追加する。

---

## 実行順序

1. **#1** (MEDIUM) — フォーム内 fetch エラー通知（3フック修正）
2. **#5** — エクスポートのスキップ通知（2コンポーネント + i18n）
3. **#4** — useMemo 依存配列の簡素化（1フック）
4. **#2** — view-model テスト拡充（1ファイル）
5. **#3** — OrgDashboardPage テスト拡充（1ファイル）
6. **#6** — パーサーエッジケーステスト（1ファイル）

## 検証

各修正後: `npx vitest run <対象テストファイル>`
全完了後: `npx vitest run --coverage`
