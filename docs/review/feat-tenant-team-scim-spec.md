# コードレビュー: feat/tenant-team-scim-spec
日時: 2026-02-28T03:00:00+09:00
レビュー回数: 3回目 (Loop 1-2: 設計変更前, Loop 3: 設計変更後)

## 前回からの変更
Loop 1-2の設計変更要件 (F-1/S-1, F-4, S-3, S-4, S-5) を実装済み:
- FORCE RLS 全28テーブル適用
- externalId + isBootstrap カラム追加
- tenant-claim.ts サニタイゼーション強化
- emergency-access-server.ts を RLS コンテキスト内に移動
- check-bypass-rls.mjs CI ガードスクリプト追加

---

## 機能観点の指摘

### F1 [Critical] ネストされた $transaction が FORCE RLS 下で失敗する — FALSE POSITIVE
- prisma.ts の Proxy (L143-153) がネスト $transaction を明示的にハンドル
- callback 方式: `arg(active)` で外側の RLS スコープ付き tx を再利用
- batch 方式: `Promise.all(arg)` で Proxy 経由実行

### F2 [Critical] rotate-key の同一問題 — FALSE POSITIVE
- F1 と同じ理由

### F3 [Medium] P2002 slug コリジョン時のリトライにフォールバック slug がない
- 問題: `slugifyTenant` が同一 slug を返し続ける場合、P2002 (slug ユニーク制約) でエラー
- 推奨: P2002 リトライ時に slug が衝突した場合のハンドリング追加

### F4 [Medium] ブートストラップマイグレーションに不足テーブルがある
- 問題: auth.ts の bootstrap migration で `emergencyAccessGrant`, `emergencyAccessKeyPair`, `passwordShare`, `shareAccessLog`, `attachment` が移行されない
- 推奨: これらのテーブルも `updateMany` に含める

### F5 [Low] CI スクリプトの rg 依存 — SKIP
- 既存スクリプト (check-team-auth-rls.mjs) と一貫性がある

### F6 [Low] u-* テナントの backfill — SKIP
- Phase 7 のオーファン解決で生成されたテナントであり、設計上除外が正しい

---

## セキュリティ観点の指摘

### S1 [High] check-bypass-rls.mjs が CI/package.json に未登録
- 問題: スクリプトが存在するが CI で実行されない
- 推奨: package.json の scripts に追加し、CI ワークフローで実行

### S2 [Medium] slug の bootstrap-/u- プレフィックスコリジョン
- 問題: slugifyTenant が偶然 `bootstrap-` や `u-` で始まる slug を生成する可能性
- 推奨: 予約プレフィックスの排除ロジックを追加

### S3 [Medium] tenants テーブルに RLS なし — SKIP (意図的)
- tenants テーブルは RLS の対象外（テナント解決の起点）

### S4 [Medium] check-bypass-rls の import マッチング — SKIP
- `content.includes("withBypassRls")` は十分実用的

### S5 [Medium] F4 と同一 — bootstrap migration の不足テーブル

### S6 [Low] 制御文字のサニタイゼーションが NUL バイトのみ
- 問題: `\0` 以外の制御文字 (U+0001-U+001F, U+007F-U+009F) が通過
- 推奨: 全制御文字を除去

---

## テスト観点の指摘

### T1-A [High] P2002 リトライで findUnique が null を返すケース
- 推奨: テスト追加

### T1-B [Low] isBootstrap が undefined のケース — SKIP
- existingTenant?.isBootstrap は undefined に対し !!undefined = false で正しく動作

### T1-C [Low] existingTenant が null のケース — SKIP
- existingTenant?.isBootstrap は null に対し null?.isBootstrap = undefined で正しく動作

### T1-D [Low] slugifyTenant に空文字列を渡すケース
- 推奨: テスト追加

### T2-B [Low] externalId が create data に含まれないことの検証 — 既存
- auth.test.ts L251-252 で既に検証済み

### T3-A [Medium] 非文字列型の入力テスト
- 推奨: tenant-claim.test.ts に数値/boolean/object 入力テスト追加

### T3-B [Medium] 空白のみのクレーム値テスト
- 推奨: " " が null を返すことを検証

### T3-C [Medium] NULL バイト除去の境界テスト
- 推奨: "\0abc\0" → "abc" を検証

### T3-D [Low] AUTH_TENANT_CLAIM_KEYS の一貫性 — SKIP
- 既にデフォルト値テストが存在 (L20-22)

### T4-A [High] RLS スコープ検証
- 推奨: rotate-key テストで withUserTenantRls のコール検証

### T4-B [Low] vaultKey.create の tenantId 検証
- 推奨: テスト追加

---

## 対応状況

### F3: P2002 slug コリジョンフォールバック
- 対応: P2002 後 findUnique が null の場合 (slug 衝突)、randomBytes(4) サフィックス付き slug で再作成
- 修正ファイル: src/auth.ts

### F4/S5: ブートストラップ移行の不足テーブル
- 対応: emergencyAccessGrant, emergencyAccessKeyPair, passwordShare, shareAccessLog, attachment を移行対象に追加
- 修正ファイル: src/auth.ts

### S1: check-bypass-rls.mjs を CI に登録
- 対応: package.json に `check:bypass-rls` スクリプト追加、ci.yml に実行ステップ追加
- 修正ファイル: package.json, .github/workflows/ci.yml

### S2: 予約 slug プレフィックスの排除
- 対応: `bootstrap-` / `u-` で始まる slug に `t-` プレフィックスを付与
- 修正ファイル: src/lib/tenant-claim.ts

### S6: 制御文字サニタイゼーション拡張
- 対応: `\0` のみ → C0 (U+0000-U+001F) + DEL (U+007F) + C1 (U+0080-U+009F) 全制御文字を除去
- 修正ファイル: src/lib/tenant-claim.ts

### テスト追加
- auth.test.ts: P2002 slug collision fallback テスト、slugifyTenant 空文字列テスト、bootstrap 移行の新テーブルアサーション
- tenant-claim.test.ts: 非文字列型、空白のみ、制御文字境界、予約プレフィックス排除テスト
- rotate-key/route.test.ts: withUserTenantRls スコープ検証テスト
