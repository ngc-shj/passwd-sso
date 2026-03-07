# コードレビュー: feat/batch-d-browser-extension-enhancement

日時: 2026-02-22T12:00:00+09:00
レビュー回数: 11回目 (clipboard clear fix 後)

## 前回からの変更

前回 (Round 10) 後に以下の変更:

- offscreen.js: クリップボードクリア時に空文字ではなくスペース文字を使用 (execCommand の制約回避)

## 機能観点の指摘

### F-1 (高) デフォルトスコープに `passwords:write` がなくログイン保存が403になる

- ファイル: src/lib/constants/extension-token.ts:16-19
- 問題: `EXTENSION_TOKEN_DEFAULT_SCOPES` に `passwords:write` が含まれないため、拡張機能からの SAVE_LOGIN / UPDATE_LOGIN が常に 403
- 推奨: デフォルトスコープに追加

### F-2 (中) `Cmd+Shift+I` が Chrome DevTools ショートカットと競合

- ファイル: extension/manifest.config.ts:49-52
- 問題: copy-username の `Command+Shift+I` は DevTools を開くデフォルトショートカットと衝突
- 推奨: `Ctrl+Shift+U` / `Command+Shift+U` に変更

### F-3 (中) ペンディング保存プロンプトが平文パスワードをメモリ保持

- 認識事項。TTL 30秒、clearVault時クリア、tabs.onRemoved時クリアが実装済み。対応不要。

### F-4 (中) `filled.length !== 1` が厳しすぎる

- 前回レビューで意図的に変更済み。スキップ。

### F-5 (低) `_locales/ja` で「ボールト」と「保管庫」が混在

- ファイル: extension/public/_locales/ja/messages.json:22
- 推奨: 「保管庫をロック」に統一

### F-6 (低) offscreen.html に html/body 要素がない

- 機能上問題なし。改善のみ。スキップ。

## セキュリティ観点の指摘

### S-1 (中) = F-1 と同一

### S-2 (低) DELETE が auth() のみで authOrToken 未使用

- 意図的設計。拡張からの DELETE は計画外。スキップ。

**エクスプロイト可能な脆弱性は検出されず。**

## テスト観点の指摘

### T-1 (中) invalidateContextMenu の動作テスト欠落

### T-2 (中) action: "update" レスポンス時のバナー表示テスト欠落

### T-3 (低) non-LOGIN エントリテストのキャッシュタイミング脆弱性

- テストは現在動作中。スキップ。

### T-4 (低) extractCredentialsFromPage で filled=2 のケース欠落

### T-5 (低) handleSaveLogin で swFetch 例外テスト欠落

### T-6 (低) input[type=submit] クリック経由の LOGIN_DETECTED テスト欠落

- ボタンクリックテストで間接的にカバー済み。スキップ。

### T-7 (低) PUT バリデーションエラー (400) テスト欠落

- 既存 route.test.ts パターンと同等。スキップ。

### T-8 (低) updateContextMenuForTab に url=undefined のテスト欠落

## 対応状況

commit: `3e07e27` -- review: fix R11 findings

### F-1/S-1: デフォルトスコープに passwords:write 追加

- 対応: `EXTENSION_TOKEN_DEFAULT_SCOPES` に `EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE` を追加
- 修正ファイル: src/lib/constants/extension-token.ts:17

### F-2: DevTools ショートカット競合

- 対応: copy-username のショートカットを `Ctrl+Shift+I` → `Ctrl+Shift+U` に変更
- 修正ファイル: extension/manifest.config.ts:50-51

### F-5: i18n 用語不統一

- 対応: `_locales/ja` の「ボールトをロック」→「保管庫をロック」に修正
- 修正ファイル: extension/public/_locales/ja/messages.json:21

### T-1: invalidateContextMenu テスト追加

- 対応: 同じホストでも invalidate 後にメニュー再構築されることを検証
- 修正ファイル: extension/src/__tests__/context-menu.test.ts

### T-2: update アクションバナーテスト追加

- 対応: LOGIN_DETECTED → action: "update" のレスポンスでバナー表示を検証
- 修正ファイル: extension/src/__tests__/login-detector.test.ts

### T-4: filled=2 テスト追加

- 対応: パスワードフィールド2つの場合に null を返すことを検証
- 修正ファイル: extension/src/__tests__/login-detector.test.ts

### T-5: swFetch 例外テスト追加

- 対応: swFetch がネットワークエラーで reject する場合のエラーハンドリングを検証
- 修正ファイル: extension/src/__tests__/background-login-save.test.ts

### T-8: url=undefined テスト追加

- 対応: URL が undefined の場合に子アイテムが削除されることを検証
- 修正ファイル: extension/src/__tests__/context-menu.test.ts
