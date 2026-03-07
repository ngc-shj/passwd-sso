# サイドバー コンテキスト切替型リファクタリング — 実装プラン

## 1. 背景と目的

### 現状の問題

現在の `sidebar.tsx`（約1090行）は、個人Vault・組織Vault・タグ・フォルダ・セキュリティ・ユーティリティを **1つの縦長リスト** に全て表示している。組織が増えるほどカテゴリ（5種）・アーカイブ・ゴミ箱が重複し、サイドバーが肥大化する。

### ゴール

サイドバー上部に **Vault セレクタ** を配置し、選択中の Vault に応じてナビゲーション内容を差し替える。個人Vaultと各組織Vaultで同一のナビゲーション構造を共有し、表示量を約半分に削減する。

---

## 2. 設計

### 2.1 Vault セレクタ

サイドバー最上部にドロップダウンを配置する。

```
┌─────────────────────────┐
│  🔒 個人の保管庫      ▼ │  ← Select / DropdownMenu
├─────────────────────────┤
│  (選択中Vaultのメニュー) │
│  ...                    │
├─────────────────────────┤
│  (Vault横断メニュー)    │  ← Watchtower / 緊急アクセスのみ
└─────────────────────────┘
```

選択肢:
- **個人の保管庫**（デフォルト）
- 所属する各組織（例: "Security"）

セレクタの実装は `Select` (shadcn/ui) または `DropdownMenu` を使う。組織が1つもない場合はセレクタ自体を非表示にし、従来の「保管庫」ヘッダーのみ表示する。

### 2.2 Vault 内メニュー（コンテキスト依存部分）

選択中のVaultに関わらず **同じ構造** を表示する:

```
すべてのパスワード
お気に入り
─────────────────
カテゴリ  >
  ログイン
  セキュアノート
  クレジットカード
  ID情報
  パスキー
整理  >
  フォルダ  >
  タグ  >
─────────────────
アーカイブ
ゴミ箱
共有リンク
監査ログ
─────────────────
エクスポート
インポート
─────────────────
組織設定              ← 組織Vault選択時のみ (Admin/Owner)
```

各メニュー項目のURL対応:

| メニュー項目 | 個人Vault | 組織Vault |
|---|---|---|
| すべてのパスワード | `/dashboard` | `/dashboard/orgs/{orgId}` |
| お気に入り | `/dashboard/favorites` | `/dashboard/orgs/{orgId}?scope=favorites` |
| カテゴリ (LOGIN等) | `/dashboard?type=LOGIN` | `/dashboard/orgs/{orgId}?type=LOGIN` |
| フォルダ | `/dashboard/folders/{folderId}` | `/dashboard/orgs/{orgId}?folder={folderId}` |
| タグ | `/dashboard/tags/{tagId}` | `/dashboard/orgs/{orgId}?tag={tagId}` |
| アーカイブ | `/dashboard/archive` | `/dashboard/orgs/{orgId}?scope=archive` |
| ゴミ箱 | `/dashboard/trash` | `/dashboard/orgs/{orgId}?scope=trash` |
| 共有リンク | `/dashboard/share-links` | `/dashboard/share-links` (※) |
| 監査ログ | `/dashboard/audit-logs` | `/dashboard/orgs/{orgId}/audit-logs` |
| エクスポート | ExportDialog | OrgExportDialog |
| インポート | ImportDialog | (将来対応) |
| 組織設定 | — | `/dashboard/orgs/{orgId}/settings` |

※ 共有リンクは現在 `/dashboard/share-links` で個人+組織を一覧表示。Phase 1 では URL 変更を行わず、組織Vault選択時も同じURLに遷移する。組織別分離（`?org={orgId}` など）は Phase 3 で対応する。

### 2.3 Vault 横断メニュー（常時表示部分）

セレクタの選択に関わらず、サイドバー下部に常時表示する:

```
═════════════════
Watchtower
緊急アクセス
```

横断メニューが2項目のみになるため、Collapsible セクションは不要。フラット表示。

**各機能の配置根拠:**

| 機能 | 配置 | 理由 |
|---|---|---|
| Watchtower | 横断 | 現在は個人Vaultのみ対象だが、将来的に全Vault横断のセキュリティスコアに拡張すべき機能。特定のVault内に閉じ込めると、組織Vault切替時に消えて発見性が下がる |
| 緊急アクセス | 横断 | アカウント単位の機能。特定のVaultに紐づかない |

### 2.4 URL と Vault セレクタの同期

Vault セレクタの選択状態は URL から自動導出する（専用の state は持たない）:

| URL パターン | 選択される Vault |
|---|---|
| `/dashboard`, `/dashboard/favorites`, `/dashboard/tags/*` 等 | 個人の保管庫 |
| `/dashboard/orgs/{orgId}`, `/dashboard/orgs/{orgId}?type=...` 等 | 該当する組織 |
| `/dashboard/watchtower`, `/dashboard/emergency-access` | 直前の選択を維持 |
| `/dashboard/share-links` | 直前の選択を維持 (※) |

※ 共有リンクの組織別分離が完了するまでは横断ページ扱い。

**実装方法**: `useLocalStorage` で `lastVaultContext: "personal" | orgId` を保持。Vault内ページでは URL から上書き。横断ページでは読み取りのみ。

---

## 3. 実装ステップ

### Phase 1: Vault セレクタ + コンテキスト切替（コア）

**新規作成:**

| ファイル | 内容 | 見積もり行数 |
|---|---|---|
| `src/components/layout/vault-selector.tsx` | Vault 選択ドロップダウン | 80-100 |
| `src/hooks/use-vault-context.ts` | URL → VaultContext 導出ロジック | 40-50 |

**変更:**

| ファイル | 変更内容 |
|---|---|
| `src/components/layout/sidebar.tsx` | 1090行 → 推定 520-620行にリファクタリング |
| `messages/en.json` | i18n キー追加（5-8キー） |
| `messages/ja.json` | i18n キー追加（5-8キー） |

**sidebar.tsx の構造変更:**

```tsx
// Before (約1090行)
<nav>
  <Collapsible> 保管庫 (個人) </Collapsible>
  <Collapsible> カテゴリ (個人) </Collapsible>
  <Collapsible> 組織 </Collapsible>         ← 組織ごとにカテゴリ・アーカイブ・ゴミ箱が重複
  <Collapsible> 整理 </Collapsible>          ← 個人タグ + 組織タグが混在
  <Collapsible> セキュリティ </Collapsible>   ← Watchtower + 共有リンク + 緊急アクセス + 監査ログ(個人+各組織)
  <Collapsible> ユーティリティ </Collapsible>
</nav>

// After (推定 400-450行)
<nav>
  <VaultSelector />                           ← 新規: 個人/組織の切替
  {/* Vault コンテキスト内メニュー */}
  <VaultNavItems />                           ← すべて/お気に入り
  <Collapsible> カテゴリ </Collapsible>        ← 選択中Vaultのカテゴリのみ
  <Collapsible> 整理 </Collapsible>            ← 選択中Vaultのフォルダ + タグ
  <VaultManagementItems />                    ← アーカイブ/ゴミ箱/共有リンク/監査ログ
  <VaultUtilityItems />                       ← エクスポート/インポート
  <OrgSettingsLink />                          ← 組織選択時のみ
  <Separator />
  {/* Vault 横断メニュー */}
  <WatchtowerLink />
  <EmergencyAccessLink />
</nav>
```

**useVaultContext の設計:**

```tsx
type VaultContextType = "personal" | "org";

interface VaultContext {
  type: VaultContextType;
  orgId?: string;
  orgName?: string;
  orgRole?: string;
}

function useVaultContext(orgs: OrgItem[]): VaultContext {
  const cleanPath = stripLocalePrefix(usePathname());
  const [lastContext, setLastContext] = useLocalStorage<string>(
    "vault-context", "personal"
  );

  // URL / localStorage から現在コンテキストを導出（pure）
  let resolved: VaultContext = { type: "personal" };

  // URL から Vault を優先導出
  const orgMatch = cleanPath.match(/^\/dashboard\/orgs\/([^/]+)/);
  if (orgMatch) {
    const org = orgs.find(o => o.id === orgMatch[1]);
    if (org) {
      resolved = { type: "org", orgId: org.id, orgName: org.name, orgRole: org.role };
    }
  }

  if (resolved.type !== "org") {
    // 個人Vault ページ
    const isPersonalPage = ["/dashboard", "/dashboard/favorites", ...].some(
      p => cleanPath === p || cleanPath.startsWith(p + "/")
    );
    if (isPersonalPage) {
      resolved = { type: "personal" };
    } else if (lastContext !== "personal") {
      // 横断ページ → 直前の選択を維持
      const org = orgs.find(o => o.id === lastContext);
      if (org) {
        resolved = { type: "org", orgId: org.id, orgName: org.name, orgRole: org.role };
      }
    }
  }

  // 記憶更新は副作用で実施（render中に setState しない）
  useEffect(() => {
    if (resolved.type === "org" && resolved.orgId && lastContext !== resolved.orgId) {
      setLastContext(resolved.orgId);
    } else if (resolved.type === "personal" && lastContext !== "personal") {
      setLastContext("personal");
    }
  }, [resolved.type, resolved.orgId, lastContext, setLastContext]);

  return resolved;
}
```

### Phase 2: テスト

| ファイル | 内容 |
|---|---|
| `src/hooks/use-vault-context.test.ts` | **新規** — URL パターン別の Vault 導出、横断ページでの lastContext 維持 |
| `src/components/layout/vault-selector.test.tsx` | **新規** — 組織0/1/複数件時の表示、切替時のナビゲーション |
| `src/components/layout/sidebar.test.tsx` | **新規** — コンテキスト別メニュー表示、アクティブ状態、組織設定の権限制御 |
| `e2e/tests/sidebar-context.spec.ts` | **新規** — セレクタ切替 → メニュー差替え → ナビゲーション → 戻る/進む |

### Phase 3: 組織別共有リンクの分離（将来）

現在の `/dashboard/share-links` を組織別にフィルタ可能にする。

| 変更 | 内容 |
|---|---|
| 共有リンクAPI | `orgId` クエリパラメータ対応 |
| 共有リンクページ | Vault コンテキストに応じたフィルタリング |
| URL | `/dashboard/share-links?org={orgId}` または `/dashboard/orgs/{orgId}/share-links` |

---

## 4. 影響範囲

### 変更なし

- URL ルーティング構造（Phase 1）
- API エンドポイント
- ページコンポーネント (`page.tsx`)
- データベーススキーマ
- 暗号処理
- ブラウザ拡張

### 変更あり

| ファイル | 種別 | 行数変化 |
|---|---|---|
| `src/components/layout/sidebar.tsx` | リファクタリング | 1090 → 520-620 |
| `src/components/layout/vault-selector.tsx` | 新規 | 80-100 |
| `src/hooks/use-vault-context.ts` | 新規 | 40-50 |
| `messages/en.json` | 変更 | +5-8キー |
| `messages/ja.json` | 変更 | +5-8キー |
| テスト 4ファイル | 新規 | 300-400 |

**ネット行数:** sidebar.tsx の -260行 + 新規 420-550行 = 微増だが、複雑度は大幅低下

### 削除される概念

- サイドバー内の「組織」Collapsible セクション
- 「整理」セクション内の組織タググループ混在表示
- 「セキュリティ」Collapsible セクション（廃止 → Watchtower + 緊急アクセスをフラット表示）
- 「セキュリティ」内の監査ログサブツリー（個人 + 各組織一覧）
- 「ユーティリティ」Collapsible セクション（廃止 → Vault 内に移動）
- 組織ごとのカテゴリ重複表示

---

## 5. Before / After 比較

### Before（現状）

```
保管庫
  すべてのパスワード
  お気に入り
  アーカイブ
  ゴミ箱
カテゴリ  >
  ログイン / セキュアノート / クレジットカード / ID情報 / パスキー
組織
  Security  ▼
    ログイン / セキュアノート / クレジットカード / ID情報 / パスキー
    ─────
    フォルダ ...
    ─────
    アーカイブ
    ゴミ箱
  組織を管理
─────
整理  >
  (個人フォルダ)
  (個人タグ)
  Security
    (組織フォルダ)
    (組織タグ)
─────
セキュリティ  >
  Watchtower
  共有リンク
  緊急アクセス
  監査ログ
    アカウント
    Security
─────
ユーティリティ  >
  エクスポート
  インポート
```

**≈ 30+ 項目が常時展開可能**

### After — 個人Vault選択時

```
┌ 🔒 個人の保管庫  ▼ ┐

すべてのパスワード
お気に入り
─────────────────
カテゴリ  >
整理  >
  フォルダ  >
  タグ  >
─────────────────
アーカイブ
ゴミ箱
共有リンク
監査ログ
─────────────────
エクスポート
インポート
═════════════════
Watchtower
緊急アクセス
```

**≈ 14 項目（カテゴリ・タグ折りたたみ時）**

### After — Security 組織選択時

```
┌ 🏢 Security    ▼ ┐

すべてのパスワード
お気に入り
─────────────────
カテゴリ  >
整理  >
  フォルダ  >
  タグ  >
─────────────────
アーカイブ
ゴミ箱
共有リンク
監査ログ
─────────────────
エクスポート
─────────────────
組織設定
═════════════════
Watchtower
緊急アクセス
```

**≈ 14 項目（同構造）**

---

## 6. UX 考慮事項

### Vault セレクタの表示

- 組織が 0 件: セレクタ非表示、「保管庫」ヘッダーのみ（現行と同等の見た目）
- 組織が 1 件: セレクタ表示（個人 + 1組織）
- 組織が多数: ドロップダウン内スクロール対応

### Vault 切替時の挙動

セレクタで組織を切り替えると、その組織の「すべてのパスワード」ページ（`/dashboard/orgs/{orgId}`）にナビゲーションする。同じメニュー項目の位置を維持しようとする（例: カテゴリ > ログインを見ていた場合、切替先でもカテゴリ > ログインに遷移）のは複雑化するため、Phase 1 では行わない。

### 組織管理ページへの導線

「組織を管理」（`/dashboard/orgs`、組織一覧＋招待管理）は、Vault セレクタ内にオプションとして配置する:

```
┌─────────────────────────┐
│  🔒 個人の保管庫         │
│  🏢 Security             │
│  🏢 Engineering          │
│  ─────────────────────── │
│  ⚙️ 組織を管理            │  ← /dashboard/orgs へ遷移
└─────────────────────────┘
```

### キーボードアクセシビリティ

セレクタは shadcn/ui の Select（Radix Primitives ベース）を使い、キーボード操作（矢印キー、Enter、Escape）を標準サポート。

---

## 7. リスクと対策

| リスク | 対策 |
|---|---|
| アクティブ状態検出の複雑化 | `useVaultContext` に集約し、各メニュー項目は `context.type` で分岐するのみ |
| `lastVaultContext` と URL の不整合 | 横断ページ以外では必ず URL から上書き。横断ページでは localStorage の値を信頼し、該当する組織が存在しない場合は personal にフォールバック |
| 共有リンクの組織別分離が未完了 | Phase 1 では組織選択時も `/dashboard/share-links` に遷移。将来のフィルタパラメータ追加で対応 |
| モバイル Sheet での表示 | セレクタが Sheet 幅 (w-56) に収まることを確認。長い組織名は truncate |
| 既存 E2E テストの破損 | サイドバー操作を含む既存テストの修正が必要（Phase 2 で対応） |
