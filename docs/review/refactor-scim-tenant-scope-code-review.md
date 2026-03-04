# コードレビュー: refactor/scim-tenant-scope
日時: 2026-03-05
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘
| # | 深刻度 | ファイル | 指摘内容 |
|---|--------|---------|---------|
| F-1 | Low | `prisma/migrations/` | マイグレーションファイルが未作成（運用対応） |
| F-2 | Info | `src/lib/scim-token.ts` L95-97 | `tenantId` null チェックは防御的コーディングとして妥当（対応不要） |
| F-3 | Medium | 旧 API パス | 旧パスへの 410 Gone スタブがない（リリースノートで対応） |
| F-4 | High | デプロイ順序 | コード先行 -> マイグレーション後行を遵守する必要あり（運用対応） |

ブロッカーとなる機能バグなし。

## セキュリティ観点の指摘
| # | 影響度 | 指摘内容 |
|---|--------|---------|
| S-1 | 低 | $transaction ネストは Proxy 経由で RLS が維持されるが、コメント追加推奨 |
| S-2 | 中 | マイグレーション時のデータ整合性確認を推奨（運用対応） |

セキュリティブロッカーなし。認証・認可・テナント境界・トークンセキュリティ・監査ログは適切。

## テスト観点の指摘
| ID | ファイル | 深刻度 | 指摘内容 |
|---|---|---|---|
| POST-1 | `tenant/scim-tokens/route.test.ts` | Medium | `expiresInDays > 3650` 上限テスト不足 |
| POST-2 | `tenant/scim-tokens/route.test.ts` | Medium | `expiresInDays: null`（無期限）テスト不足 |
| POST-3 | `tenant/scim-tokens/route.test.ts` | Low | POST の rethrow テスト不足 |
| DEL-1 | `tenant/scim-tokens/[tokenId]/route.test.ts` | Low | DELETE の rethrow テスト不足 |
| GET-1 | `tenant/scim-tokens/route.test.ts` | Low | `withTenantRls` の tenantId 引数未検証 |
| GET-2 | `tenant/scim-tokens/route.test.ts` | Low | `findMany` クエリ形状未検証 |
| GRP-1 | `scim/v2/Groups/route.test.ts` | Medium | 空スラッグ `:ADMIN` エッジケーステスト不足 |
| GRP-2 | `scim/v2/Groups/route.test.ts` | Medium | 無効ロール `core:OWNER` テスト不足 |
| MEM-1 | `teams/[teamId]/members/[memberId]/route.test.ts` | Medium | Transaction アサーションが `undefined` 配列を検証している |

## 対応状況

### POST-1: `expiresInDays > 3650` 上限テスト
- 対応: テスト追加 — `expiresInDays: 3651` で 400 を返すことを検証
- 修正ファイル: `src/app/api/tenant/scim-tokens/route.test.ts`

### POST-2: `expiresInDays: null` テスト
- 対応: テスト追加 — `expiresInDays: null` で `expiresAt: null` のトークンが作成されることを検証
- 修正ファイル: `src/app/api/tenant/scim-tokens/route.test.ts`

### POST-3: POST の rethrow テスト
- 対応: テスト追加 — POST での予期しないエラーの再 throw を検証
- 修正ファイル: `src/app/api/tenant/scim-tokens/route.test.ts`

### DEL-1: DELETE の rethrow テスト
- 対応: テスト追加 — DELETE での予期しないエラーの再 throw を検証
- 修正ファイル: `src/app/api/tenant/scim-tokens/[tokenId]/route.test.ts`

### GRP-1: 空スラッグ `:ADMIN` テスト
- 対応: テスト追加 — `":ADMIN"` (separator=0) で 400 を返すことを検証
- 修正ファイル: `src/app/api/scim/v2/Groups/route.test.ts`

### GRP-2: 無効ロール `core:OWNER` テスト
- 対応: テスト追加 — OWNER ロールは SCIM_GROUP_ROLES に含まれないため 400 を返すことを検証
- 修正ファイル: `src/app/api/scim/v2/Groups/route.test.ts`

### MEM-1: Transaction アサーション改善
- 対応: `mockTransaction` の配列アサーション（undefined 配列を検証していた）を個別の `toHaveBeenCalledWith` に置換
- 修正ファイル: `src/app/api/teams/[teamId]/members/[memberId]/route.test.ts`

### 対応外（運用で対応）
- F-1: マイグレーションファイル — デプロイ時に `npm run db:migrate` で生成
- F-3: 旧APIスタブ — リリースノートに旧パス廃止を明記で対応
- F-4: デプロイ順序 — コード先行 → マイグレーション後行を遵守
- S-1: $transaction ネスト — Proxy 実装で正しくハンドルされており低リスク
- S-2: データ整合性 — マイグレーション時に NOT NULL チェックで対応
- GET-1, GET-2: Low priority — withTenantRls/findMany の引数検証は RLS の正確性テストで間接的にカバー
