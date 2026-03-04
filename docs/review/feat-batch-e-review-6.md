# プランレビュー: typed-dreaming-key.md (Tenant Vault Reset)

日時: 2026-03-05T00:30:00+09:00
レビュー回数: 2回目

## 前回からの変更

1回目の29件の指摘を受けて以下を追加:
- RLS ポリシー (Step 1)
- 既存 pending token の一括 revoke (Step 1 migration)
- AUDIT_ACTION_GROUPS_TENANT (Step 2)
- GET /api/tenant/role エンドポイント (Step 5)
- 10刻み権限階層 (Step 3)
- Revoke メールテンプレート (Step 10)
- teamName optional 化 (Step 10)
- テスト対応表 + テストヘルパー (Step 14)
- lint + build を検証に追加

## 機能観点の指摘 (4件)

### F-1 [低] Step 9 の logAudit で resetRecord.tenantId を使う旨の明記
- **採用**: Step 9 に `resetRecord.tenantId` を明示的に渡す旨を追記

### F-2 [低] 旧/新 route の rate limit key 不整合
- **不採用**: 移行期間は短く（Step 7 → Step 12 の間のみ）、実害なし

### F-3 [低] FK 制約 CASCADE→SET NULL の SQL 記載漏れ
- **不採用**: Prisma migrate dev が自動生成するため手動 SQL 不要

### F-4 [中] Step 6/7/8 の RLS コンテキスト設定パターン明記
- **採用**: 各 Step に `withTenantRls(prisma, actor.tenantId, ...)` パターンを追記

## セキュリティ観点の指摘 (4件)

### S-1 [高] Execute Route の TOCTOU — Revoke との競合
- **採用**: Step 9 にアトミック `updateMany` パターンを追記。Revoke 新設により実際のリスクが生じるため重要

### S-2 [低] Execute Route で tenantId が logAudit に渡されない
- **採用**: F-1 と統合して Step 9 に追記

### S-3 [中] History API にページネーション未指定
- **採用**: Step 7 GET に `take: 50` デフォルト上限を追記

### S-4 [低] Revoke API にレートリミット未指定
- **不採用**: pending トークン最大3件で revoke 自体が自然に制限される

## テスト観点の指摘 (3件)

### T-11 [中] admin-reset の scope assertion 不足
- **採用**: Step 14 の admin-reset/route.test.ts に scope フィールド assertion を追記

### T-12 [高] ADMIN_VAULT_RESET_REVOKE の実装定義がプランに不在
- **不採用**: Step 1 (Prisma enum) と Step 2 (constants) に既に記載済み

### T-13 [低] admin-reset/route.test.ts が削除対象外の明示
- **不採用**: execute API は tenant 版でも存続するため自明
