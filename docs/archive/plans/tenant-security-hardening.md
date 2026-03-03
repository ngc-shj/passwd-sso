# テナントセキュリティ強化: 5項目の設計変更

## Context

コードレビューLoop 1-3で修正可能な指摘をすべて解決済み。残り5件は設計変更が必要な項目:
- F-1/S-1: FORCE RLS未適用 → テナント分離が実質無効
- F-4: emergency-access-server.tsのRLS欠如 → FORCE RLS後にクエリが0行返却
- S-3: IdPクレームがテナントIDに直接使用 → 悪意のあるIdPによるテナント乗っ取り
- S-4: ブートストラップ判定がslugプレフィックス依存 → 改竄でバイパス可能
- S-5: scim_group_mappingsのトリガー未登録 → tenant_id自動解決が機能しない

## 変更ファイル一覧

| ファイル | 変更内容 |
|----------|---------|
| `prisma/schema.prisma` | Tenant に `externalId`, `isBootstrap` 追加 |
| 新規マイグレーション A | `external_id`, `is_bootstrap` カラム + バックフィル |
| 新規マイグレーション B | FORCE RLS全テーブル + `resolve_tenant_id_from_row` 更新 |
| `src/auth.ts` | `externalId` でlookup + `isBootstrap` で判定 + tenantClaim長制限 |
| `src/lib/auth-adapter.ts` | bootstrap作成時に `isBootstrap: true` |
| `src/lib/tenant-claim.ts` | `extractTenantClaimValue` に長さ制限 + NULLバイト除去 |
| `src/lib/emergency-access-server.ts` | `withUserTenantRls` で囲む（呼び出し元から tenantId を渡す） |
| `src/auth.test.ts` | モック更新 + P2002リトライ + create引数検証 + isBootstrapネガティブ |
| `src/lib/auth-adapter.test.ts` | `isBootstrap: true` アサーション追加 |
| `src/lib/emergency-access-server.test.ts` | RLS ラッパーモック追加 |
| `src/app/api/vault/rotate-key/route.ts` | `withUserTenantRls` 範囲拡張 |
| `src/app/api/vault/rotate-key/route.test.ts` | RLS範囲拡張に伴うモック更新 |
| `scripts/check-bypass-rls.mjs` (新規) | `withBypassRls` 呼び出し箇所のCI許可リスト検証 |

## Step 1: Prisma スキーマ変更

`prisma/schema.prisma` の Tenant モデル (行350-388):

```prisma
model Tenant {
  id          String   @id @default(cuid())
  externalId  String?  @unique @map("external_id") @db.VarChar(255)  // S-3: IdPクレーム値
  isBootstrap Boolean  @default(false) @map("is_bootstrap")  // S-4
  name        String
  slug        String   @unique
  description String?  @db.Text
  ...
}
```

変更点:
- `externalId` に `@db.VarChar(255)` を追加（インデックスサイズ制限 + DoS防止）
- `isBootstrap` フラグ追加

## Step 2: マイグレーション A — スキーマ変更 + バックフィル

`prisma migrate dev --create-only --name tenant_external_id_and_bootstrap`

生成されたSQLに以下のバックフィルを追加:

```sql
-- 既存の非ブートストラップテナント: id = IdPクレーム値だったのでexternal_idにコピー
-- tenant_usr_* はPhase 7のオーファン解決で生成されたテナントなので除外
UPDATE "tenants" SET "external_id" = "id"
  WHERE "slug" NOT LIKE 'bootstrap-%'
    AND "slug" NOT LIKE 'u-%';

-- 既存のブートストラップテナント: フラグ設定
UPDATE "tenants" SET "is_bootstrap" = true
  WHERE "slug" LIKE 'bootstrap-%';
```

## Step 3: マイグレーション B — FORCE RLS + トリガー更新

`prisma migrate dev --create-only --name force_rls_and_scim_trigger_phase9`

### テーブルオーナー検証

マイグレーション先頭にDOブロックで `passwd_user` がテーブルオーナーであることを検証:

```sql
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT tableowner INTO v_owner
  FROM pg_tables WHERE tablename = 'users' AND schemaname = 'public';
  IF v_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION
      'FORCE RLS requires table owner = current_user. Owner="%", current_user="%"',
      v_owner, current_user;
  END IF;
END $$;
```

### FORCE RLS (F-1/S-1)

全27テーブル + scim_group_mappings に `ALTER TABLE ... FORCE ROW LEVEL SECURITY`:

Phase 5テーブル: teams, tenant_members, scim_tokens, scim_external_mappings
Phase 7テーブル: users, accounts, sessions, extension_tokens, tags, vault_keys, password_entries, team_members, team_member_keys, team_password_entries, team_tags, team_password_favorites, team_invitations, password_shares, share_access_logs, audit_logs, attachments, emergency_access_grants, folders, team_folders, password_entry_histories, team_password_entry_histories, emergency_access_key_pairs
SCIMテーブル: scim_group_mappings

### トリガー更新 (S-5)

`CREATE OR REPLACE FUNCTION resolve_tenant_id_from_row` でチームスコープテーブルリストに `'scim_group_mappings'` を追加（行35-37 の IN句）。

## Step 4: アプリケーションコード変更

### 4a: `src/auth.ts` — S-3 + S-4

**テナントlookup (行42-43)**: `where: { id: tenantClaim }` → `where: { externalId: tenantClaim }`

**テナント作成 (行49-54)**: `id: tenantClaim` を削除、`externalId: tenantClaim` に変更

**P2002リカバリ (行62-64)**: `where: { id: tenantClaim }` → `where: { externalId: tenantClaim }`

**ブートストラップ判定 (行78-82)**: `select: { slug: true }` → `select: { isBootstrap: true }`, `slug?.startsWith("bootstrap-")` → `existingTenant?.isBootstrap`

### 4b: `src/lib/auth-adapter.ts` — S-4

**ブートストラップ作成 (行36-42)**: `tx.tenant.create` の data に `isBootstrap: true` 追加

### 4c: `src/lib/tenant-claim.ts` — 入力バリデーション強化

`extractTenantClaimValue` の返却前に:
- NULLバイト除去: `.replace(/\0/g, "")`
- 長さ制限: 255文字を超える場合は `null` を返す

```typescript
const MAX_TENANT_CLAIM_LENGTH = 255;
// ...
const cleaned = value.trim().replace(/\0/g, "");
if (cleaned.length === 0 || cleaned.length > MAX_TENANT_CLAIM_LENGTH) {
  return null;  // 次のクレームキーを試行、または null を返す
}
return cleaned;
```

### 4d: `src/lib/emergency-access-server.ts` — F-4

呼び出し元 (`rotate-key/route.ts`) が既に `withUserTenantRls` 内で動作しているため、関数を RLS コンテキスト対応に変更。呼び出し元の RLS 範囲を拡張し、`markGrantsStaleForOwner` をその中に含める。

**Option A（推奨）**: `rotate-key/route.ts` の `withUserTenantRls` 範囲を拡張:

```typescript
// rotate-key/route.ts
const result = await withUserTenantRls(session.user.id, async () => {
  // 既存のkey rotation処理
  // ...
  // STALE化も同一RLSコンテキスト内で実行
  await markGrantsStaleForOwner(session.user.id, newKeyVersion);
  return rotationResult;
});
```

`markGrantsStaleForOwner` 自体は変更不要（RLSコンテキスト内で呼ばれるため）。

**注意**: emergency access grant は同一テナント内のユーザー間でのみ成立するため、`withUserTenantRls` で正しくフィルタされる。クロステナントの緊急アクセスはアーキテクチャ上存在しない。

## Step 5: テスト更新

### 5a: `src/auth.test.ts`

- `tenant.findUnique` モック: `where.id` → `where.externalId` でキー判定
- `tenant.create` の戻り値: `id: "cuid_acme_1"` (内部CUID)
- ブートストラップテナントモック: `isBootstrap: true` を返す
- 全アサーション: `tenantId: "tenant-acme"` → `tenantId: "cuid_acme_1"`
- **追加**: `tenant.create` の `data` 引数検証（`externalId` 含む、`id` 含まない）
- **追加**: P2002リトライパスのテスト（`findUnique` が `externalId` で再検索）
- **追加**: isBootstrapネガティブテスト:
  - `isBootstrap: true` + slugが `bootstrap-` 以外 → 移行許可
  - `isBootstrap: false` + slugが `bootstrap-` で始まる → 移行拒否

### 5b: `src/lib/auth-adapter.test.ts`

- `createUser` テストに `isBootstrap: true` のアサーション追加:
  ```typescript
  expect(mockPrismaTenant.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ isBootstrap: true }),
    select: { id: true },
  });
  ```

### 5c: `src/lib/emergency-access-server.test.ts`

- `markGrantsStaleForOwner` がRLSコンテキスト外で呼ばれた場合の動作テスト
- rotate-key/route.test.ts の `withUserTenantRls` 範囲拡張に伴うモック更新

### 5d: `src/lib/tenant-claim.test.ts`

- 255文字超のクレーム値で `null` が返ることを検証
- NULLバイトを含むクレーム値が除去されることを検証

## デプロイ手順

**重要**: マイグレーションとアプリケーションデプロイの間にテナント作成が行われると、バックフィル漏れが発生する。

1. メンテナンスウィンドウ中にマイグレーション A + B を実行
2. マイグレーション完了後にアプリケーションをデプロイ
3. アプリ停止が許容できない場合: マイグレーション A を先に適用し、アプリコードは `id` と `externalId` の両方で検索するフォールバックロジックを一時的に追加 → バックフィル完了確認後にフォールバック削除

## 検証手順

1. `npm run lint` — lint クリーン
2. `npx vitest run` — 全テストパス
3. `npx prisma validate` — スキーマ検証
4. マイグレーションの手動SQL確認（FORCE RLS、バックフィル、トリガー更新）
5. **追加**: `withBypassRls` 呼び出し箇所のCI静的検証（許可リスト方式）
