# コードレビュー: feat/batch-e (CLI修正)
日時: 2026-03-04
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### F-1 [高] `export.ts` の TOTP 型不整合
- **ファイル:** `cli/src/commands/export.ts:30`
- **問題:** `totp?: string` だが実際はオブジェクト。CSV エクスポートで `[object Object]` が出力される
- **推奨:** 型をオブジェクトに修正し、CSV 出力時は `totp.secret` を使用

### F-2 [高] EOF (Ctrl+D) でクリーンアップが行われない
- **ファイル:** `cli/src/index.ts:92-190`
- **問題:** `for await` ループ終了後に `stopBackgroundRefresh`, `lockVault`, `clearPendingClipboard` が呼ばれない
- **推奨:** ループ後にクリーンアップ処理を追加

### F-3 [中] `clearTokenCache()` が `cachedExpiresAt` をクリアしない
- **ファイル:** `cli/src/lib/api-client.ts:40-42`
- **推奨:** `cachedExpiresAt = null` を追加

### F-4 [中] Warning monkey-patch が全 Warning を抑制
- **ファイル:** `cli/src/lib/api-client.ts:17-19`
- **推奨:** TLS 関連の警告のみフィルタリング

### F-5 [低] `readPassphrase` でパイプ入力 EOF 未処理
- **ファイル:** `cli/src/commands/unlock.ts:35-64`
- **推奨:** `stdin.on("end")` ハンドラ追加

### F-6 [低] login のトークン有効期限が推定値
- **ファイル:** `cli/src/commands/login.ts:47`
- **推奨:** コメント追加(サーバー側 TTL との同期が必要な旨)

## セキュリティ観点の指摘

### S-1 [高] エクスポートファイルのパーミッションが umask 依存
- **ファイル:** `cli/src/commands/export.ts:91,108`
- **問題:** 平文パスワード含むファイルが `0o644` で作成される可能性
- **推奨:** `{ mode: 0o600 }` を指定

### S-2 [中] `lock` コマンドで `clearTokenCache()` が呼ばれない
- **ファイル:** `cli/src/index.ts:157-165`
- **推奨:** `clearTokenCache()` を追加

### S-3 [中] トークンリフレッシュのレスポンス検証不足
- **ファイル:** `cli/src/lib/api-client.ts:88`
- **推奨:** `typeof data.token === "string"` と `data.expiresAt` の存在チェック追加

### S-4 [低] `hexDecode` に入力検証がない
- **ファイル:** `cli/src/lib/crypto.ts:35-41`
- **推奨:** 長さチェックと hex 文字検証追加

### S-5 [低] AAD のフィールド長 65535 バイト制限チェック欠落
- **ファイル:** `cli/src/lib/crypto-aad.ts:46-51`
- **推奨:** Web 版同様の `> 0xffff` チェック追加

### S-6 [低] API パスへの入力バリデーションなし
- **ファイル:** `cli/src/commands/get.ts:50`, `totp.ts:44`
- **推奨:** UUID 形式チェック追加

## テスト観点の指摘

### T-1 [高] `crypto-aad.ts` のテストがない
- **推奨:** `cli/src/__tests__/unit/crypto-aad.test.ts` 作成（既知ベクタ、バイナリフォーマット、決定性、エラー）

### T-2 [中] `api-client.test.ts` がトークンリフレッシュ新ロジック未カバー
- **推奨:** `setInsecure`, `isTokenExpiringSoon`, `startBackgroundRefresh` のテスト追加

### T-3 [中] `crypto.test.ts` が `buildPersonalEntryAAD` との結合テスト未実施
- **推奨:** AAD 付き暗号化/復号の結合テスト追加

### T-4 [低] `vault-state.ts` のテストがない
- **推奨:** userId 状態管理のテスト作成

### T-5 [低] `config.test.ts` が `tokenExpiresAt` 未テスト
- **推奨:** 永続化・読み取りテスト追加

## 対応状況
(修正後に追記)
