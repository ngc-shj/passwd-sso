# コードレビュー: feat/batch-e（ブランチ全体）
日時: 2026-03-04
レビュー回数: 1回目（全指摘解消で完了）

## レビュー範囲

`main...feat/batch-e` の全差分（164ファイル、約15,800行）

## 機能観点の指摘（18件: 0 Critical, 2 High, 8 Medium, 8 Low）

### HIGH

#### F-H1: CLI パスワード生成のモジュロバイアス
- **ファイル**: `cli/src/commands/generate.ts:33`
- **問題**: `randomBytes(4).readUInt32BE(0) % charset.length` はモジュロバイアスがある。charset が 2^32 の約数でない場合、一部の文字が他より僅かに高い確率で選ばれる。
- **対応**: rejection sampling に変更。`limit = floor(2^32 / charset.length) * charset.length` を超える値を棄却。

#### F-H2: CC オートフィル .js に日本語月名がない
- **ファイル**: `extension/src/content/autofill-cc.js:29-34`
- **問題**: `.ts` 版（テスト用）には `"1月"`〜`"12月"` があるが、実際にブラウザで実行される `.js` 版にはない。日本語サイトの月選択セレクトボックスでマッチ失敗する。
- **対応**: `.js` の `MONTH_NAMES` に `"1月"`〜`"12月"` を追加。

### MEDIUM（スキップ、理由記載）

- **F-M1**: CLI トークンの平文保存 → keytar は OS キーチェーン（macOS Keychain / Windows Credential Manager）を使用しており業界標準。スキップ。
- **F-M2**: TOCTOU ウィンドウ（vault reset token） → `updateMany` の `where` 句に `expiresAt: { gt: new Date() }` を含むアトミック DB 操作で実質的な TOCTOU なし。スキップ。
- **F-M3**: URL フラグメントのリセットトークン → フラグメントはサーバーに送信されない設計。スキップ。
- **F-M4〜M8**: UI/UX 改善提案（ツールチップ追加、ローディング状態等）→ 現在のスコープ外。スキップ。

### LOW（8件）
機能的影響が軽微なコードスタイル・ドキュメント改善提案。スキップ。

---

## セキュリティ観点の指摘（9件: 0 Critical, 1 High, 3 Medium, 5 Low）

### HIGH

#### S-H1: CLI パスワード生成のモジュロバイアス
F-H1 と同一。対応済み。

### MEDIUM（スキップ、理由記載）

- **S-M1**: CLI トークン平文保存 → F-M1 と同一。keytar は OS キーチェーン利用。スキップ。
- **S-M2**: Watchtower メールテンプレートの appUrl スキーム検証不足 → **対応済み**。`admin-vault-reset.ts` と同様の `^https?://` チェックを追加。テストも追加。
- **S-M3**: TOCTOU ウィンドウ → F-M2 と同一。スキップ。

### LOW（5件）
軽微なセキュリティ改善提案。スキップ。

---

## テスト観点の指摘（7件: 0 Critical, 0 High, 2 Medium, 5 Low）

### MEDIUM

#### T-M1: CLI TOTP テストの非決定性
- **ファイル**: `cli/src/__tests__/unit/totp.test.ts:42-47`
- **問題**: `generateTOTPCode()` を2回連続呼び出し、同じコードを期待するが、30秒ステップ境界を跨ぐとテストが失敗する可能性がある。
- **対応**: `vi.useFakeTimers()` で時刻を固定。

#### T-M2: admin-reset expiresAt テストの時間依存性
- **調査結果**: `expect.any(Date)` ジェネリックマッチャー使用、`Date.now() + 3600_000`（1時間）の大きなマージン。実質的なフレーキーリスクなし。スキップ。

### LOW（5件）
テストカバレッジ拡充提案。スキップ。

---

## 対応状況

| 指摘ID | 概要 | 対応 | 修正ファイル |
|--------|------|------|-------------|
| F-H1 / S-H1 | CLI モジュロバイアス | rejection sampling | `cli/src/commands/generate.ts:32-37` |
| F-H2 | CC autofill .js 日本語月名 | 月名追加 | `extension/src/content/autofill-cc.js:29-38` |
| S-M2 | watchtower appUrl 検証 | スキーム検証追加 | `src/lib/email/templates/watchtower-alert.ts:38-40` |
| T-M1 | TOTP テスト非決定性 | fake timers | `cli/src/__tests__/unit/totp.test.ts:1,42-46` |

## 検証

- lint: 0 errors, 2 warnings（既存、対象外）
- test: 347 files, 3506 tests all pass
- build: success
