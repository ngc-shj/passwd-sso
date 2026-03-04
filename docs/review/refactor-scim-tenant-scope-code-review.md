# コードレビュー: refactor/scim-tenant-scope

日時: 2026-03-05
レビュー回数: 2回目

## 前回からの変更

Round 1 の指摘 POST-1, POST-2, POST-3, DEL-1, GRP-1, GRP-2, MEM-1 を修正済み。

## Round 1 指摘（全件解決済み）

### 機能観点の指摘

| # | 深刻度 | ファイル | 指摘内容 | 対応 |
|---|--------|---------|---------|------|
| F-1 | Low | `prisma/migrations/` | マイグレーションファイルが未作成 | 運用対応 |
| F-2 | Info | `src/lib/scim-token.ts` L95-97 | `tenantId` null チェック | 対応不要（防御的コーディング） |
| F-3 | Medium | 旧 API パス | 旧パスへの 410 Gone スタブがない | リリースノートで対応 |
| F-4 | High | デプロイ順序 | コード先行 → マイグレーション後行 | 運用対応 |

### セキュリティ観点の指摘

| # | 影響度 | 指摘内容 | 対応 |
|---|--------|---------|------|
| S-1 | 低 | $transaction ネストのコメント追加推奨 | 低リスク、対応外 |
| S-2 | 中 | マイグレーション時のデータ整合性確認 | 運用対応 |

### テスト観点の指摘

| ID | ファイル | 深刻度 | 指摘内容 | 対応 |
|---|---|---|---|---|
| POST-1 | `tenant/scim-tokens/route.test.ts` | Medium | `expiresInDays > 3650` 上限テスト | テスト追加済み |
| POST-2 | `tenant/scim-tokens/route.test.ts` | Medium | `expiresInDays: null` テスト | テスト追加済み |
| POST-3 | `tenant/scim-tokens/route.test.ts` | Low | POST の rethrow テスト | テスト追加済み |
| DEL-1 | `tenant/scim-tokens/[tokenId]/route.test.ts` | Low | DELETE の rethrow テスト | テスト追加済み |
| GET-1 | `tenant/scim-tokens/route.test.ts` | Low | `withTenantRls` 引数未検証 | 間接カバー |
| GET-2 | `tenant/scim-tokens/route.test.ts` | Low | `findMany` クエリ形状未検証 | 間接カバー |
| GRP-1 | `scim/v2/Groups/route.test.ts` | Medium | 空スラッグテスト | テスト追加済み |
| GRP-2 | `scim/v2/Groups/route.test.ts` | Medium | 無効ロールテスト | テスト追加済み |
| MEM-1 | `teams/[teamId]/members/[memberId]/route.test.ts` | Medium | Transaction アサーション | 修正済み |

## Round 2 レビュー結果

### 機能観点

新規の機能バグ・ロジック不整合なし。

| # | 深刻度 | 指摘内容 | 対応 |
|---|--------|---------|------|
| F-5 | Info | Groups POST に `logAudit` がない（pre-existing） | 本 PR スコープ外 |
| F-6 | Low | DEV-1 の ScimExternalMapping スコープ拡大 | 動作に問題なし（対応不要） |
| F-7 | Info | ScimToken の `onDelete: Restrict` によるテナント削除ブロック | 意図的設計（対応不要） |

### セキュリティ観点

**指摘なし。** 認証・認可・テナント境界・トークンセキュリティ・監査ログ・入力バリデーション・情報漏洩・レート制限すべて良好。

### テスト観点

| ID | ファイル | 深刻度 | 指摘内容 | 対応 |
|---|---|---|---|---|
| NEW-4 | `scim/v2/Groups/[id]/route.test.ts` | Low | PATCH add テナント外ユーザー 400 テスト | テスト追加済み |
| NEW-5 | `scim/v2/Groups/[id]/route.test.ts` | Medium | PUT SCIM_NO_SUCH_MEMBER レスポンスボディ未検証 | アサーション追加済み |
| NEW-7 | `scim/v2/Users/[id]/route.test.ts` | Medium | PUT externalId 新規設定の正常系パス未テスト | テスト追加済み |
| NEW-1 | `tenant/scim-tokens/route.test.ts` | Low | 境界値正常系テスト (1, 3650) | 対応外（エラー境界でカバー） |
| NEW-2 | `tenant/scim-tokens/route.test.ts` | Low | POST create 引数形状未検証 | 対応外（レスポンス検証でカバー） |
| NEW-3 | `scim/v2/Groups/[id]/route.test.ts` | Low | PUT displayName 不一致+OWNER | 対応外（エッジケース of エッジケース） |
| NEW-6 | `scim/v2/Users/[id]/route.test.ts` | Info | PATCH PatchParseError 詳細検証 | 対応外（現行で十分） |
| NEW-8 | `scim/v2/Users/route.test.ts` | Info | POST エラーハンドリングカバレッジ | 対応外（問題なし） |
| NEW-9 | `scim/v2/Users/[id]/route.test.ts` | Info | DELETE rethrow パス | 対応外（他ハンドラでパターン済み） |
| NEW-10 | `scim/v2/Users/[id]/route.test.ts` | Info | resolveUserId 255文字制限テスト | 対応外（ユーティリティ内部ロジック） |
| NEW-11 | `scim/v2/Groups/route.test.ts` | Info | GET フィルタ大文字小文字テスト | 対応外（toLowerCase 実装で保証） |

## 対応状況

### Round 1 修正（commit: review(1)）

#### POST-1: `expiresInDays > 3650` 上限テスト

- 対応: テスト追加 — `expiresInDays: 3651` で 400 を返すことを検証
- 修正ファイル: `src/app/api/tenant/scim-tokens/route.test.ts`

#### POST-2: `expiresInDays: null` テスト

- 対応: テスト追加 — `expiresInDays: null` で `expiresAt: null` のトークンが作成されることを検証
- 修正ファイル: `src/app/api/tenant/scim-tokens/route.test.ts`

#### POST-3: POST の rethrow テスト

- 対応: テスト追加 — POST での予期しないエラーの再 throw を検証
- 修正ファイル: `src/app/api/tenant/scim-tokens/route.test.ts`

#### DEL-1: DELETE の rethrow テスト

- 対応: テスト追加 — DELETE での予期しないエラーの再 throw を検証
- 修正ファイル: `src/app/api/tenant/scim-tokens/[tokenId]/route.test.ts`

#### GRP-1: 空スラッグ `:ADMIN` テスト

- 対応: テスト追加 — `":ADMIN"` (separator=0) で 400 を返すことを検証
- 修正ファイル: `src/app/api/scim/v2/Groups/route.test.ts`

#### GRP-2: 無効ロール `core:OWNER` テスト

- 対応: テスト追加 — OWNER ロールは SCIM_GROUP_ROLES に含まれないため 400 を返すことを検証
- 修正ファイル: `src/app/api/scim/v2/Groups/route.test.ts`

#### MEM-1: Transaction アサーション改善

- 対応: `mockTransaction` の配列アサーション（undefined 配列を検証していた）を個別の `toHaveBeenCalledWith` に置換
- 修正ファイル: `src/app/api/teams/[teamId]/members/[memberId]/route.test.ts`

### Round 2 修正（commit: review(2)）

#### NEW-4: PATCH add テナント外ユーザー 400 テスト

- 対応: テスト追加 — テナントにもチームにも存在しないユーザーを add した場合に 400 + "Referenced member" を返すことを検証
- 修正ファイル: `src/app/api/scim/v2/Groups/[id]/route.test.ts`

#### NEW-5: PUT SCIM_NO_SUCH_MEMBER レスポンスボディ検証

- 対応: 既存テストにレスポンスボディアサーション追加 — `body.detail` が "Referenced member" を含むことを検証
- 修正ファイル: `src/app/api/scim/v2/Groups/[id]/route.test.ts`

#### NEW-7: PUT externalId 新規設定の正常系テスト

- 対応: テスト追加 — `externalId: "ext-new"` を送信した場合に `deleteMany` + `create` が正しい引数で呼ばれることを検証
- 修正ファイル: `src/app/api/scim/v2/Users/[id]/route.test.ts`

### 対応外（運用・スコープ外）

- F-1: マイグレーションファイル — デプロイ時に `npm run db:migrate` で生成
- F-3: 旧APIスタブ — リリースノートに旧パス廃止を明記で対応
- F-4: デプロイ順序 — コード先行 → マイグレーション後行を遵守
- F-5: Groups POST の logAudit — pre-existing、フォローアップ Issue で対応
- S-1: $transaction ネスト — Proxy 実装で正しくハンドルされており低リスク
- S-2: データ整合性 — マイグレーション時に NOT NULL チェックで対応
- GET-1, GET-2: Low priority — withTenantRls/findMany の引数検証は RLS の正確性テストで間接的にカバー
- NEW-1, NEW-2, NEW-3: Low priority — エラー境界・レスポンス検証でカバー済み
- NEW-6〜NEW-11: Info level — 現行テストで十分なカバレッジ
