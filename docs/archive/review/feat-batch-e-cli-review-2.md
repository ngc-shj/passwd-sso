# コードレビュー: feat/batch-e (CLI修正)
日時: 2026-03-04
レビュー回数: 2回目

## 前回からの変更
レビュー1回目の全17指摘（F-1〜F-6, S-1〜S-6, T-1〜T-5）に対し、コミット 8d859c4 で修正実施。
解決済み: F-1〜F-6, S-1〜S-5, T-1, T-3, T-4

## 機能観点の指摘

### F-7 [中] `readPassphrase` で `onEnd` リスナーがリーク
- **ファイル:** `cli/src/commands/unlock.ts:43-55`
- **問題:** `onData` パスで `end` リスナーを除去していない。逆も同様
- **推奨:** 両方のコールバックで `removeListener("data", onData)` と `removeListener("end", onEnd)` を呼ぶ

### F-8 [中] `get --field totp` でオブジェクトが `[object Object]` になる
- **ファイル:** `cli/src/commands/get.ts:69-81`
- **問題:** `blob["totp"]` はオブジェクトだが `String(value)` で `[object Object]` になる
- **推奨:** `typeof value === "object"` の場合は `JSON.stringify(value)` を使用

### F-10 [低] clipboard の `setTimeout` が `unref()` されていない
- **ファイル:** `cli/src/lib/clipboard.ts:35`
- **問題:** ワンショットコマンドでプロセスが30秒間終了しない可能性
- **推奨:** `clearTimer.unref()` を追加

## セキュリティ観点の指摘
指摘なし — 前回の S-1〜S-5 は全て解決済み。S-6 はCLIのローカル実行文脈で対応不要と判断。

## テスト観点の指摘

### R-1 [高] api-client.test.ts 401リフレッシュテストがFAIL
- **ファイル:** `cli/src/__tests__/unit/api-client.test.ts:69-92`
- **問題:** mockレスポンスに `expiresAt` がなく検証で弾かれる。`saveConfig` も未モック
- **推奨:** `expiresAt` をレスポンスに追加、`saveConfig: vi.fn()` をモックに追加

### R-2 [中] proactive refresh (`isTokenExpiringSoon`) パスのテストなし
- **ファイル:** `cli/src/lib/api-client.ts:123-129`
- **問題:** プロアクティブリフレッシュのパスが未テスト
- **推奨:** `setTokenCache` で期限切れ間近のトークンを設定し、リフレッシュ後のトークンで実際のリクエストが行われることを検証

## 対応状況
(修正後に追記)
