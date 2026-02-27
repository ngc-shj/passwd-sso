# コードレビュー: feat/tenant-team-scim-spec
日時: 2026-02-27T00:00:00+09:00
レビュー回数: 2回目

## 前回からの変更
初回レビュー

---

## 機能観点の指摘

### F-1 (Critical): `FORCE ROW LEVEL SECURITY` が未適用
- **ファイル**: `prisma/migrations/20260227020000_enable_tenant_rls_phase5/migration.sql` (行60-63)
- **問題**: 全テーブルで `ENABLE ROW LEVEL SECURITY` のみ。テーブルオーナーロールで接続するとRLSポリシーが完全にバイパスされる
- **影響**: テナント分離が実質無効
- **推奨修正**: 全テーブルに `FORCE ROW LEVEL SECURITY` を追加するか、アプリ接続ユーザーをテーブルオーナーと分離する

### F-2 (Critical): ブートストラップ移行で既存データの `tenant_id` が旧テナントに残る
- **ファイル**: `src/auth.ts` (行84-114)
- **問題**: user/account/tenantMemberのみ更新。password_entries, tags, folders, vault_keys, sessions, extension_tokens等の tenant_id が旧テナントのまま
- **影響**: RLS有効時に既存パスワードデータが全て不可視（データロス）
- **推奨修正**: 移行トランザクション内で全関連テーブルのtenant_idを一括更新

### F-3 (High): ブートストラップ移行後に重複 `tenantMember.upsert` が実行される
- **ファイル**: `src/auth.ts` (行96-109, 120-133)
- **問題**: 移行トランザクション内でupsert後、関数末尾で再度同じupsertが実行される
- **推奨修正**: ブートストラップ移行後は早期リターン

### F-4 (High): `emergency-access-server.ts` がRLSコンテキストなしでクエリ実行
- **ファイル**: `src/lib/emergency-access-server.ts`
- **問題**: `markGrantsStaleForOwner` がRLSラッパーなしで直接prismaを使用
- **推奨修正**: `withBypassRls` で囲む

### F-5 (High): `auth-adapter.ts` の `updateSession` がRLSコンテキストなし
- **ファイル**: `src/lib/auth-adapter.ts` (行131-157)
- **問題**: Auth.jsが毎リクエスト呼び出す `updateSession` にRLSラッパーがない
- **推奨修正**: `withBypassRls` で囲む。PrismaAdapterのbaseメソッドも同様

### F-6 (Medium): `passwords/route.ts` POSTで `withUserTenantRls` が5回呼ばれる
- **ファイル**: `src/app/api/passwords/route.ts` (行131-183)
- **問題**: 1リクエストで最大10トランザクション + 5回のset_config
- **推奨修正**: 1回のwithUserTenantRlsで全操作を囲む

### F-7 (Medium): SCIM Groups PUT/PATCHでVIEWERからremove時にMEMBERに「昇格」する
- **ファイル**: `src/app/api/scim/v2/Groups/[id]/route.ts` (行219-224, 341-343)
- **問題**: ロール階層を考慮せずMEMBERにフォールバック
- **推奨修正**: VIEWER remove時の動作を設計的に明確化

### F-8 (Medium): `slugifyTenant` が非ASCII入力で空文字列を返す
- **ファイル**: `src/lib/tenant-claim.ts` (行21-28)
- **問題**: 日本語組織名でサインイン不可
- **推奨修正**: 空文字列時にUUIDベースのフォールバックslugを生成

### F-9 (Low): `tenant.create` P2002リカバリ時にslug衝突が未処理
- **ファイル**: `src/auth.ts` (行48-69)
- **推奨修正**: P2002リカバリ時にslugでもfindUniqueを試行

### F-10 (Low): `resolveUserTenantIdFromClient` の競合状態
- **ファイル**: `src/lib/tenant-context.ts` (行8-19)
- **問題**: ブートストラップ移行中の一瞬、2テナントメンバーシップ状態が発生
- **推奨修正**: 移行トランザクション内でdelete→upsertの順序を入れ替え

---

## セキュリティ観点の指摘

### S-1 (Critical): FORCE RLS未適用 (= F-1)

### S-2 (High): SCIM User POSTでクロステナントユーザーが不可視/乗っ取り
- **ファイル**: `src/app/api/scim/v2/Users/route.ts` (行148-159)
- **問題**: RLS内でemail検索するため他テナントユーザーが不可視。emailのユニーク制約はグローバルなのでcreateがP2002で失敗。RLS無効時は他テナントのユーザーをメンバーとして登録してしまう
- **推奨修正**: email検索をbypassRlsで行い、tenantId一致を検証。P2002ハンドリング追加

### S-3 (High): IdPクレームがテナントIDとして直接使用される
- **ファイル**: `src/auth.ts` (行42-53), `src/lib/tenant-claim.ts`
- **問題**: 悪意のあるSAML IdPが既存テナントIDと一致するクレームを返すことで不正メンバーシップ取得
- **推奨修正**: 内部UUIDを使用しIdPクレームは外部IDとして管理。最低限、テナント自動作成の無効化

### S-4 (Medium): ブートストラップテナント判定がslugプレフィックスに依存
- **ファイル**: `src/auth.ts` (行82)
- **問題**: `slug?.startsWith("bootstrap-")` で判定。slug改竄でバイパス可能
- **推奨修正**: 専用booleanカラム `isBootstrap` を使用

### S-5 (Medium): `scim_group_mappings` がPhase 8トリガーに未登録
- **ファイル**: `prisma/migrations/20260227050000_tenant_id_trigger_defaults_phase8/migration.sql`
- **推奨修正**: `resolve_tenant_id_from_row` にケース追加

### S-6 (Medium): SCIM Group members valueにバリデーション不足
- **ファイル**: `src/lib/scim/validations.ts`
- **問題**: `members[].value` に長さ・形式制約なし
- **推奨修正**: `.max(255)` を追加

### S-7 (Low): SCIM token lastUsedAt更新のconsole.warn
- **ファイル**: `src/lib/scim-token.ts` (行108-116)
- **推奨修正**: 構造化ログ (getLogger()) に置換

---

## テスト観点の指摘

### T-1 (High): `tenant-context.ts` / `tenant-rls.ts` の単体テストが存在しない
- **推奨修正**: `src/lib/tenant-context.test.ts` を新規作成

### T-2 (High): SCIM Owner保護テストが全欠如
- **ファイル**: `src/app/api/scim/v2/Users/[id]/route.test.ts`
- **推奨修正**: PUT/PATCH/DELETEでOWNER保護の403テストを追加

### T-3 (Medium): `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` の403テスト欠如
- **ファイル**: `src/app/api/teams/route.test.ts`
- **推奨修正**: GET/POSTでマルチテナント拒否テストを追加

### T-4 (Medium): ブートストラップ移行テストで `account.updateMany` 検証欠如
- **ファイル**: `src/auth.test.ts` (行146-161)
- **推奨修正**: account.updateMany と tenantMember.upsert のアサーション追加

### T-5 (Medium): SCIM externalId競合409テスト欠如
- **ファイル**: `src/app/api/scim/v2/Users/[id]/route.test.ts` 他
- **推奨修正**: externalId競合の409レスポンステストを追加

### T-6 (Medium): SCIM Groups displayName不正形式400テスト欠如
- **ファイル**: `src/app/api/scim/v2/Groups/route.test.ts`
- **推奨修正**: displayName形式不正の400テストを追加

### T-7 (Low): SCIM テストで `withTenantRls` のtenantId値を未検証
- **推奨修正**: expect呼び出しで tenantId パラメータを検証

---

## 対応状況

### F-2: ブートストラップ移行でデータ孤立
- 対応: 移行トランザクション内でpasswordEntry/tag/folder/session/extensionToken/passwordEntryHistory/vaultKey/auditLogのtenant_idを一括更新
- Loop2修正: passwordEntryHistoryのwhere句からuserIdを除去（モデルに存在しない）、vaultKeyの移行を追加
- 修正ファイル: src/auth.ts

### F-3: 重複tenantMember.upsert
- 対応: ブートストラップ移行後に `return found` で早期リターン
- 修正ファイル: src/auth.ts

### F-5: auth-adapter.ts updateSession RLSなし
- 対応: `withBypassRls` で囲んだ
- 修正ファイル: src/lib/auth-adapter.ts

### F-6: passwords/route.ts 複数RLS呼び出し
- 対応: handlePOST内で1回のwithUserTenantRlsに統合
- 修正ファイル: src/app/api/passwords/route.ts

### F-8: slugifyTenantの空文字列
- 対応: SHA-256ハッシュによるフォールバックslugを生成
- 修正ファイル: src/lib/tenant-claim.ts

### S-2: SCIM User POST クロステナントemail衝突
- 対応: Prisma P2002エラーのキャッチを追加し409を返す
- 修正ファイル: src/app/api/scim/v2/Users/route.ts

### S-6: SCIM Group members valueバリデーション不足
- 対応: `.min(1).max(255)` を追加（POST/PUT）
- Loop2修正: PATCH経路の `parseMemberValues` にも同等のバリデーション追加
- 修正ファイル: src/lib/scim/validations.ts, src/lib/scim/patch-parser.ts

### S-7: console.warnの情報漏洩
- 対応: 構造化ログ (getLogger()) に置換
- 修正ファイル: src/lib/scim-token.ts

### T-1: tenant-context/tenant-rls単体テスト
- 対応: src/lib/tenant-context.test.ts を新規作成（10テスト）
- 修正ファイル: src/lib/tenant-context.test.ts

### T-2: SCIM Owner保護テスト
- 対応: PUT/PATCH/DELETEでOWNER保護の403テストを追加
- 修正ファイル: src/app/api/scim/v2/Users/[id]/route.test.ts

### T-4: ブートストラップ移行テストの検証強化
- 対応: account.updateMany、passwordEntry.updateMany等のアサーション追加
- Loop2修正: 残り6テーブル（tag/folder/session/extensionToken/passwordEntryHistory/auditLog）＋vaultKeyのアサーション追加
- 修正ファイル: src/auth.test.ts

### T-5: SCIM externalId競合テスト
- 対応: PUT時のexternalId競合409テストを追加
- 修正ファイル: src/app/api/scim/v2/Users/[id]/route.test.ts

### T-6: SCIM Groups displayNameバリデーションテスト
- 対応: displayName不正形式の400テストを追加
- 修正ファイル: src/app/api/scim/v2/Groups/route.test.ts

### 未対応（設計変更が必要）
- F-1/S-1: FORCE ROW LEVEL SECURITY — DBロール分離の設計判断が必要
- F-4: emergency-access-server.tsのRLSコンテキスト — FORCE RLS適用時に対応
- S-3: IdPクレームのテナントID直接使用 — テナントマッピング設計の変更が必要
- S-4: ブートストラップ判定のslugプレフィックス依存 — isBootstrapカラムの追加が必要
- S-5: scim_group_mappingsのPhase 8トリガー未登録 — マイグレーション追加が必要
