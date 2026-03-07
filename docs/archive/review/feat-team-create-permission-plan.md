# feat/team-create-permission

## 目的

`POST /api/teams` をテナントの OWNER/ADMIN のみに制限し、MEMBER は 403 を返す。

## 要件

- `TENANT_PERMISSION.TEAM_CREATE` 権限を新設
- OWNER と ADMIN に TEAM_CREATE 権限を付与
- MEMBER は権限なし（403）
- `requireTenantPermission` の戻り値から `tenantId` を取得し重複 DB 呼び出しを排除
- `requireTenantMember` の 404 → 403 変更（メンバーシップ列挙攻撃の防止）

## 実装ステップ

1. `src/lib/constants/tenant-permission.ts` に `TEAM_CREATE` 追加
2. `src/lib/tenant-auth.ts` の `ROLE_PERMISSIONS` に TEAM_CREATE を OWNER/ADMIN に追加
3. `src/app/api/teams/route.ts` POST ハンドラに `requireTenantPermission` ガード追加
4. `actor.tenantId` を使い `resolveUserTenantId` 呼び出しを削除
5. `requireTenantMember` を 404 → 403 に変更（セキュリティ強化）
6. テスト追加・更新

## 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/constants/tenant-permission.ts` | `TEAM_CREATE` 定数追加 |
| `src/lib/tenant-auth.ts` | TEAM_CREATE 権限 + 404→403 + JSDoc 更新 |
| `src/app/api/teams/route.ts` | actor パターン + resolveUserTenantId 削除 |
| `src/lib/tenant-auth.test.ts` | TEAM_CREATE 統合テスト + 403 テスト更新 |
| `src/app/api/teams/route.test.ts` | 403/401/re-throw テスト追加 + モック整理 |
