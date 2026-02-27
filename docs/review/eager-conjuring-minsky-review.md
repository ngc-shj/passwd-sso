# プランレビュー: eager-conjuring-minsky.md

日時: 2026-02-27T20:30:00+09:00
レビュー回数: 2回目

## 前回からの変更

Loop 1で採用した10件の指摘をプランに反映:

1. Step 1: `externalId` に `@db.VarChar(255)` 追加
2. Step 2: バックフィルWHERE条件に `AND "slug" NOT LIKE 'u-%'` 追加
3. Step 3: テーブルオーナー検証DOブロック追加
4. Step 4c: `withBypassRls` → `withUserTenantRls` 方式に変更
5. Step 4c(新規): `extractTenantClaimValue` にNULLバイト除去 + 長さ制限追加
6. Step 5a: P2002リトライテスト、create引数検証、isBootstrapネガティブテスト追加
7. Step 5b(新規): auth-adapter.test.ts に isBootstrap アサーション追加
8. Step 5d(新規): tenant-claim.test.ts に長さ制限 + NULLバイト除去テスト追加
9. デプロイ手順セクション追加
10. 検証手順にCIガード追加
11. 変更ファイル一覧に rotate-key/route.ts, route.test.ts, check-bypass-rls.mjs 追加

## 機能観点の指摘

**指摘なし。** 4件の指摘すべてが正しく反映されている。軽微な確認事項として、markGrantsStaleForOwnerの.catch(() => {})維持の判断は実装時に対応可能。

## セキュリティ観点の指摘

**指摘なし。** 4件の指摘すべてが正しく反映されている。新規指摘1件(Low): CIガードスクリプトの変更ファイル一覧への記載漏れ → 対応済み。

## テスト観点の指摘

**概ね指摘なし。** 5件中4件完了、1件(5c)は部分的だがブロッカーではない。

新規指摘(低~中):
- tenant-claim.test.tsの境界値テスト(255文字ちょうど、NULLバイトのみ) → 実装時に追加推奨
- バックフィルSQL検証手順(u-%テナントのIdPサインイン動作) → デプロイ検証で確認
