# コードレビュー: feat/batch-e
日時: 2026-03-04T20:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### 指摘 F1 (High): CC 自動入力で postalCode フィールドが欠落
- **ファイル**: extension/src/content/autofill-cc-lib.ts
- **問題**: 住所フォームの自動入力で postalCode フィールドの処理が欠落している可能性
- **推奨対応**: postalCode フィールドの処理を追加

### 指摘 F2 (High): Zod import の不統一
- **ファイル**: src/app/api/vault/admin-reset/route.ts
- **問題**: Zod v4 のインポートパターンが他ファイルと不統一
- **推奨対応**: プロジェクト統一パターンに合わせる

### 指摘 F3 (Medium): adminName 二重エスケープの可能性
- **ファイル**: src/lib/email/templates/admin-vault-reset.ts
- **問題**: adminName が二重エスケープされる可能性
- **推奨対応**: エスケープ処理の確認

### 指摘 F4 (Low): proxy.ts の tenant API パス保護が将来的に広すぎる
- **ファイル**: src/proxy.ts:116
- **問題**: `/api/tenant` 配下の全パスがセッション認証で保護される
- **推奨対応**: ルートハンドラー側の認可チェック漏れ注意のコメント追加

### 指摘 F5 (Low): 日本語翻訳で「ボールト」と「保管庫」が混在
- **ファイル**: messages/ja/VaultReset.json
- **問題**: 同じアプリ内で用語が不統一
- **推奨対応**: 「保管庫」に統一

## セキュリティ観点の指摘

### 指摘 S1 (High): CLI `--insecure` フラグで TLS 警告が抑圧される
- **ファイル**: cli/src/lib/api-client.ts:13-28
- **問題**: Node.js のセキュリティ警告を `process.emit` オーバーライドで握りつぶしている
- **推奨対応**: 警告抑圧の削除、明示的な stderr 警告出力の追加

### 指摘 S2 (High): CLI プロセス終了時にクリップボードのパスワードが残る
- **ファイル**: cli/src/lib/clipboard.ts:60-75
- **問題**: exit ハンドラでタイマーとハッシュのみクリア、クリップボード本体は残る
- **推奨対応**: `execSync` でプラットフォーム固有のクリアコマンドを同期実行

### 指摘 S3 (Medium): CLI トークンファイル書き込みの TOCTOU 競合
- **ファイル**: cli/src/lib/config.ts:84-92
- **問題**: symlink チェックと書き込みの間にレースコンディション
- **推奨対応**: `O_NOFOLLOW` フラグで直接オープン

### 指摘 S4 (Medium): resetUrl の URI スキーム検証なし
- **ファイル**: src/lib/email/templates/admin-vault-reset.ts:13-27
- **問題**: `href` 属性に使用される resetUrl が https:// で始まることの検証がない
- **推奨対応**: URL スキームのアサーション追加

### 指摘 S5 (Medium): vault-reset/admin ページのトークン正規表現の長さ制限なし
- **ファイル**: src/app/[locale]/vault-reset/admin/page.tsx:29
- **問題**: クライアント側で任意長の hex string を受け付ける
- **推奨対応**: `/token=([a-f0-9]{64})(?:$|&)/` に変更

### 指摘 S6 (Medium): executeVaultReset が FavoritedEntry を削除していない
- **ファイル**: src/lib/vault-reset.ts:38-100
- **問題**: Vault リセットで FavoritedEntry テーブルのレコードが明示的に削除されていない
- **推奨対応**: cascade delete の確認、なければ明示的削除追加

### 指摘 S7 (Medium): OWNER/ADMIN 権限の同一性の設計意図不明
- **ファイル**: src/lib/tenant-auth.ts:21-31
- **問題**: OWNER と ADMIN が全く同じ権限セットを持っている設計が文書化されていない
- **推奨対応**: 意図的であればコメント追加

### 指摘 S8 (Low): CLI パスワード生成の微小モジュロバイアス
- **ファイル**: cli/src/commands/generate.ts:33
- **問題**: `randomBytes(4).readUInt32BE(0) % charset.length` にモジュロバイアス
- **推奨対応**: リジェクションサンプリング実装

### 指摘 S9 (Low): CLI export で平文パスワードが stdout に出力される際の警告なし
- **ファイル**: cli/src/commands/export.ts:113-114
- **問題**: stdout 出力時にパスワードが永続化されるリスクの警告がない
- **推奨対応**: stderr に警告メッセージ出力

### 指摘 S10 (Low): CC 自動入力で CVV のメモリクリアが content script 側のみ
- **ファイル**: extension/src/content/autofill-cc.js:226-228
- **問題**: background script 側のオリジナルオブジェクトに影響しない
- **推奨対応**: background script 側でもクリア追加

## テスト観点の指摘

### 指摘 T1 (High): CLI コマンドのテスト欠如（8ファイル）
- **ファイル**: cli/src/commands/*.ts
- **問題**: export, get, list, login, totp, unlock, status, generate の8コマンドにテストなし
- **推奨対応**: 少なくとも export, get, unlock のテスト作成

### 指摘 T2 (High): watchtower/alert の resolveUserLocale 等がモックされていない
- **ファイル**: src/app/api/watchtower/alert/route.test.ts:1-50
- **問題**: 実装が使用するモジュールのモックが不足
- **推奨対応**: resolveUserLocale, serverAppUrl, notification messages のモック追加

### 指摘 T3 (Medium): watchtower/alert テストの withUserTenantRls モック動作不整合
- **ファイル**: src/app/api/watchtower/alert/route.test.ts:60
- **問題**: 成功ケースでコールバックを実行せず直接値を返している
- **推奨対応**: コールバック実行パターンに変更

### 指摘 T4 (Medium): admin-vault-reset テストで token SHA-256 ハッシュ検証欠如
- **ファイル**: src/app/api/vault/admin-reset/route.test.ts:46-57
- **問題**: ハッシュの正しさが検証されていない
- **推奨対応**: 実際の SHA-256 ハッシュ値で検証

### 指摘 T5 (Medium): notification-messages.ts のテスト欠如
- **ファイル**: src/lib/notification-messages.ts
- **問題**: 4つのメッセージキーの分岐が未テスト
- **推奨対応**: テストファイル新規作成

### 指摘 T6 (Medium): vault-reset.test.ts の User update フィールド完全性テスト不足
- **ファイル**: src/lib/vault-reset.test.ts:121-135
- **問題**: objectContaining でフィールド欠落を検出できない
- **推奨対応**: キー数の検証追加

### 指摘 T7 (Medium): email テンプレートの text 出力検証不足
- **ファイル**: src/lib/email/templates/admin-vault-reset.ts:47
- **問題**: テキスト本文の生 adminName の明示的テストなし
- **推奨対応**: テスト追加

### 指摘 T8 (Low): admin-vault-reset テストで token バリデーションエッジケース不足
- **ファイル**: src/app/api/vault/admin-reset/route.test.ts
- **問題**: 大文字 hex、短い/長い文字列のテスト欠如
- **推奨対応**: バリデーションエッジケーステスト追加

### 指摘 T9 (Low): CLI api-client テストで saveToken/saveConfig 検証不足
- **ファイル**: cli/src/__tests__/unit/api-client.test.ts:70-96
- **問題**: リフレッシュ成功時の永続化検証がない
- **推奨対応**: saveToken, saveConfig のアサーション追加

### 指摘 T10 (Low): url-helpers.ts (serverAppUrl) のテスト欠如
- **ファイル**: src/lib/url-helpers.ts:38-41
- **問題**: テストが存在しない
- **推奨対応**: テストファイル新規作成

### 指摘 T11 (Low): vault-reset.ts の passwordShare.deleteMany where 条件の個別検証なし
- **ファイル**: src/lib/vault-reset.test.ts
- **問題**: createdById であることの個別検証がない
- **推奨対応**: 個別アサーション追加

### 指摘 T12 (Low): CC autofill テストで select の初期値による誤検知
- **ファイル**: extension/src/__tests__/content/autofill-cc.test.ts:161-181
- **問題**: hidden select のテストで変更の有無が区別できない
- **推奨対応**: デフォルト選択を空に変更

### 指摘 T13 (Low): tenant members POST テストで tokenHash 形式検証なし
- **ファイル**: src/app/api/tenant/members/[userId]/reset-vault/route.test.ts:264-275
- **問題**: `expect.any(String)` では hex 形式の検証ができない
- **推奨対応**: `expect.stringMatching(/^[0-9a-f]{64}$/)` に変更
