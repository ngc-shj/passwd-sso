# プランレビュー: typed-dreaming-key.md (Tenant Vault Reset)

日時: 2026-03-04T23:30:00+09:00
レビュー回数: 1回目

## 前回からの変更

初回レビュー

## 機能観点の指摘 (9件)

### 1-1 [Critical] 既存 pending トークンのマイグレーション未定義
- **採用**: Step 1 マイグレーション SQL に一括 revoke 追加

### 1-2 [Medium] Revoke 時のメール通知欠落
- **採用**: Step 8 に revoke メールテンプレート追加

### 1-3 [Low] Team 設定からリセットボタン削除後の導線
- **不採用**: テナント設定タブに統合済みのため、別途導線は不要

### 2-1 [High] Audit scope TENANT の監査ログ表示系更新が欠落
- **採用**: AUDIT_ACTION_GROUPS_TENANT を Step 2 に追加

### 2-2 [Medium] 同一テナントチェック手順が不明確
- **採用**: Step 7 に具体的な WHERE 条件を明記

### 2-3 [Low] logAudit に tenantId を明示的に渡す
- **採用**: Step 7, 8, 9 に明記

### 3-1 [Critical] クライアント側の TenantRole 取得手段がない
- **採用**: Step 5 に GET /api/tenant/role 新設、Step 11 に useTenantRole hook 追加

### 3-2 [High] Email テンプレート破壊的変更の順序
- **採用**: teamName を optional にし、Step 12 で完全削除

### 4-1 [Medium] Rate limit キー設計
- **採用**: ユーザー単位のキー形式を Step 7 に明記

### 4-2 [Medium] Deactivated メンバーの扱い
- **採用**: Step 6 に含める旨を明記

## セキュリティ観点の指摘 (10件)

### S-1 [高] RLS ポリシー未設定
- **採用**: Step 1 マイグレーションに RLS 追加

### S-2 [中] Revoke 認可の曖昧さ
- **採用**: audit metadata に revokedById を記録

### S-3 [中] 権限階層値の不整合
- **採用**: 10刻み (OWNER=30, ADMIN=20, MEMBER=10) に変更

### S-4 [中] teamId optional 化のデータ整合性
- **採用**: pending count クエリ条件を Step 7 に明記

### S-5 [中] Members API の情報露出
- **採用**: Prisma select で最小限フィールドのみ返す旨を Step 6 に明記

### S-6 [中] Rate Limiter キー設計
- **採用**: admin キーをユーザー単位に統一

### S-7 [低] Revoke の pending 定義
- **採用**: WHERE 条件を Step 8 に明示、不一致時は 409

### S-8 [低] 旧版削除時の pending token
- **採用**: Step 1 マイグレーションで一括 revoke (1-1 と統合)

### S-9 [中] Cross-team 暗号鍵影響
- **不採用**: executeVaultReset() は既存のセルフリセットでも同じ副作用があり、テナント版で新規に発生する問題ではない。文書化は実装段階で検討

### S-10 [高] History API のテナント検証
- **採用**: tenantId フィルタ必須を Step 7 に明記

## テスト観点の指摘 (10件)

### T-1 Revoke API テストケース不足
- **採用**: 10ケースを Step 14 に明示

### T-2 History API テストケース不足
- **採用**: 6ケースを Step 14 に明示

### T-3 tenant-auth permission matrix テスト
- **採用**: TenantRole 全組み合わせを Step 3 に明示

### T-4 admin-reset route.test.ts 更新影響
- **採用**: fixture 変更を Step 14 に明記

### T-5 旧テストとの対応表
- **採用**: 11ケースのマッピング表を Step 14 に追加

### T-6 Tenant Members API テストケース不足
- **採用**: 5ケースを Step 14 に明示

### T-7 E2E フロー検証方針
- **不採用**: 現在のプロジェクトは route 単体テスト方針。E2E フレームワーク導入は別 issue

### T-8 AuditAction enum の i18n 追加
- **採用**: AuditLog.json への翻訳追加を Step 2 に明記

### T-9 テストヘルパー追加
- **採用**: makeTenantMember() + mock-tenant-auth.ts を Step 14 に追加

### T-10 CI 検証基準
- **採用**: lint + build を検証セクションに追加
