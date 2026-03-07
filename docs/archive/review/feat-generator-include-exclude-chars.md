# コードレビュー: feat/generator-include-exclude-chars
日時: 2026-03-01T18:22:00+09:00
レビュー回数: 2回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### F-1 (高): `excludeAmbiguous` が `includeChars` に不適用、クライアント/サーバー乖離
- **ファイル:** `src/lib/password-generator.ts:68-78`
- **問題:** `filterAmbiguous` は uppercase/lowercase/numbers/symbols にのみ適用され、`includeChars` には適用されない。一方 `buildEffectiveCharset()` は includeChars 追加後に excludeAmbiguous を適用する。`excludeAmbiguous=true, includeChars="O"` でサーバーは `O` を含むがクライアントの estimateBits は除外する。
- **推奨:** includeChars にも `filter()` を適用する。

### F-2 (中): `includeChars` 保証が `excludeChars` 重複時に確率的に破れる
- **ファイル:** `src/lib/password-generator.ts:68-91`
- **問題:** `required.push(randomChar(uniqueInclude))` は excludeSet 適用前。`includeChars="ab", excludeChars="a"` で `randomChar` が `"a"` を返すと required から削除され保証消失。
- **推奨:** excludeSet を考慮した後の有効文字から required を選択する。

### F-3 (中): `CHARSETS` 定数の重複定義
- **ファイル:** `src/lib/password-generator.ts:16-20`, `src/lib/generator-prefs.ts:93-97`
- **問題:** 同一内容の CHARSETS が両ファイルに private 定義。drift リスク。
- **推奨:** `generator-prefs.ts` から export し、`password-generator.ts` でインポート。

### F-4 (中): APIバリデーションエラーがサイレントに握り潰される
- **ファイル:** `src/components/passwords/password-generator.tsx:94-129`
- **問題:** `res.ok` が false の場合何もしない。非ASCII文字ペースト時に 400 が返るがUIに反映されない。
- **推奨:** エラーステートを追加してフィードバック表示。

### F-5 (低): `new Set(charset).size` の冗長な重複排除
- **ファイル:** `src/components/passwords/password-generator.tsx:50`
- **問題:** `buildEffectiveCharset()` は既に重複排除済み。`charset.length` で十分。
- **推奨:** `new Set` を除去。

## セキュリティ観点の指摘

F-1, F-2 と同一。追加のセキュリティ脆弱性なし。

## テスト観点の指摘

### T-1 (低): excludeChars優先テストが残存includeChars保証を検証しない
- **ファイル:** `src/lib/password-generator.test.ts:141-152`
- **推奨:** `expect(password).toMatch(/[bc]/)` を追加。

### T-2 (中): includeChars/excludeCharsのmax(128)境界未検証
- **ファイル:** `src/lib/validations.test.ts`
- **推奨:** 128文字OK、129文字NG のテスト追加。

### T-3 (中): excludeCharsのemoji拒否未検証
- **ファイル:** `src/lib/validations.test.ts`
- **推奨:** `excludeChars: "abc\u{1F600}"` 拒否テスト追加。

### T-4 (中): API route統合テスト未追加
- **ファイル:** `src/app/api/passwords/generate/route.test.ts`
- **推奨:** includeChars/excludeChars付きリクエストのテスト追加。

### T-5 (低): ASCII printable境界文字(\x7F, \x20)未検証
- **ファイル:** `src/lib/validations.test.ts`
- **推奨:** DEL文字拒否、スペース許可のテスト追加。

## 対応状況

### F-1 (高): excludeAmbiguous が includeChars に不適用
- 対応: `generatePassword()` の includeChars 処理に `filter()` を適用。さらに `excludeSet` も事前考慮し、有効な文字のみを charset と required に追加するよう変更。
- 修正ファイル: `src/lib/password-generator.ts:68-82`

### F-2 (中): includeChars 保証が確率的に破れる
- 対応: F-1 と同時修正。`effectiveInclude` (ambiguous + exclude 適用後) から required を選択するよう変更。
- 修正ファイル: `src/lib/password-generator.ts:68-82`

### F-3 (中): CHARSETS 重複定義
- 対応: `generator-prefs.ts` の `CHARSETS` を `export` し、`password-generator.ts` のローカル定義を削除してインポートに変更。
- 修正ファイル: `src/lib/generator-prefs.ts:93`, `src/lib/password-generator.ts:2`

### F-4 (中): APIバリデーションエラーがサイレント
- 対応: `generate()` の `!res.ok` 時に `setGenerated("")` でクリア。generate() を1関数に統合。
- 修正ファイル: `src/components/passwords/password-generator.tsx:94-119`

### F-5 (低): 冗長な new Set
- 対応: `new Set(charset).size` → `charset.length` に変更。
- 修正ファイル: `src/components/passwords/password-generator.tsx:50`

### T-1 (低): excludeChars優先テストの不足
- 対応: `expect(password).toMatch(/[bc]/)` を追加。
- 修正ファイル: `src/lib/password-generator.test.ts:152`

### T-2 (中): max(128)境界テスト追加
- 対応: includeChars/excludeChars の 128文字OK・129文字NG テスト追加。
- 修正ファイル: `src/lib/validations.test.ts`

### T-3 (中): excludeChars emoji拒否テスト追加
- 対応: `excludeChars: "abc\u{1F600}"` 拒否テスト追加。
- 修正ファイル: `src/lib/validations.test.ts`

### T-4 (中): API route統合テスト追加
- 対応: includeChars/excludeChars付きリクエスト + 非ASCII拒否テスト追加。
- 修正ファイル: `src/app/api/passwords/generate/route.test.ts`

### T-5 (低): ASCII境界テスト追加
- 対応: DEL (0x7F) 拒否 + スペース (0x20) 許可テスト追加。
- 修正ファイル: `src/lib/validations.test.ts`
