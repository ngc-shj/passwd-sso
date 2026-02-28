# コードレビュー: feat/group-c-entry-types-custom-fields

日時: 2026-02-28T12:00:00+09:00
レビュー回数: 2回目

## 前回からの変更

1回目のレビュー指摘をすべて修正済み。2回目レビューで F-4 を検出・修正。ユーザーフィードバックで追加修正。

## 機能観点の指摘

### F-1 [高] Software License の `email` フィールドがエクスポート/インポート/チーム payload で欠落 — データ損失

- **問題**: `software-license-form.tsx` はフォームに `email` フィールドを持ち fullBlob に保存するが、以下3箇所で `email` が欠落:
  1. `export-format-common.ts` L278-285: JSON エクスポートの `softwareLicense` オブジェクトに `email` なし
  2. `password-import-payload.ts` L113-122: インポート fullBlob に `email` なし
  3. `team-entry-payload.ts` L119-127: チームの `entryFields` に `email` なし
- **影響**: エクスポート→インポートで `email` データ損失。チームの Software License で `email` が保存されない。
- **推奨対応**: 3ファイルすべてに `email` フィールドを追加。share-entry-view.tsx にも email 表示を追加。

### F-2 [中] インポート時の `accountNumberLast4` 導出が非数字を除去しない

- **問題**: `password-import-payload.ts` L86 で `entry.accountNumber.slice(-4)` だが、他の箇所（`bank-account-form.tsx`, `team-entry-payload.ts`）は `replace(/\D/g, "")` で非数字除去後に last4 を取得。
- **影響**: "123-456" のような入力で overviewBlob の last4 が "-456" になる。
- **推奨対応**: `replace(/\D/g, "")` を追加し、4桁未満の場合は `null` にする。

### F-3 [低] i18n ラベルの不整合 (Share.json vs 他ファイル)

- **問題**: 同一フィールドのラベルが Share.json と BankAccountForm.json / PasswordDetail.json で異なる（例: "口座名義" vs "口座名義人"、"ルーティング番号" vs "支店番号"）。
- **推奨対応**: Share.json のラベルを他ファイルと統一。

## セキュリティ観点の指摘

### S-1 [中] share-entry-view.tsx: BOOLEAN カスタムフィールドの表示がハードコード英語

- **問題**: L186 で `"Yes"` / `"No"` がハードコード。`password-detail-inline.tsx` では `tc("yes")` / `tc("no")` を使用。
- **推奨対応**: `useTranslations("Common")` を追加し `tc("yes")` / `tc("no")` に変更。

### S-2 [中] IBAN が平文表示（非マスク）

- **問題**: `share-entry-view.tsx` L321 と `password-detail-inline.tsx` L306-312 で IBAN が `renderField`（平文）表示。accountNumber/routingNumber は `renderSensitiveField` でマスク。IBAN は口座番号を含む機密情報。
- **推奨対応**: 両ファイルで IBAN を sensitiveField として実装。

### S-3 [低] Bitwarden/1Password CSV で bank/license 型が検出されない

- **問題**: `parseCsv` の bitwarden/onepassword ケースに `isBankAccount`/`isSoftwareLicense` 判定なし。
- **判断**: スキップ。Bitwarden/1Password はこれらの型をサポートしていないため、期待動作。

### S-4 [低] compatible CSV エクスポートで bank/license データが損失

- **判断**: スキップ。設計上の制約。JSON エクスポートまたは passwd-sso プロファイルでの利用を推奨。

### S-5 [低] IBAN/SWIFT BIC のフォーマットバリデーションなし

- **判断**: スキップ。任意フィールドであり、E2E 暗号化アーキテクチャではサーバー側検証不可。将来的な改善提案として記録。

## テスト観点の指摘

### T-1 [高] Export→Import 往復テスト（Round-trip test）の不在

- **問題**: BANK_ACCOUNT / SOFTWARE_LICENSE のエクスポートデータをインポートで復元できることのテストなし。
- **推奨対応**: `export-format-common.test.ts` に JSON/CSV 往復テストを追加。

### T-2 [高] `submitTeamPasswordForm` の SOFTWARE_LICENSE バリデーションエラーテスト不足

- **問題**: `team-password-form-actions.test.ts` で SOFTWARE_LICENSE の `expirationBeforePurchase` エラーパスが未検証。
- **推奨対応**: expirationDate < purchaseDate 時のエラー設定テストを追加。

### T-3 [高] `buildPersonalImportBlobs` のユニットテスト不在

- **問題**: `password-import-payload.ts` の BANK_ACCOUNT/SOFTWARE_LICENSE fullBlob/overviewBlob 構築のテストなし。
- **推奨対応**: `password-import-payload.test.ts` を新規作成。

### T-4 [中] `parseJson` でフィールド値の未検証

- **問題**: `parseJson` テストで entryType/title のみ検証、各フィールド値は未検証。
- **推奨対応**: bankName, accountNumber, softwareName, licenseKey 等のアサーション追加。

### T-5 [中] `buildTeamSubmitArgs` の新タイプテスト不足

- **推奨対応**: BANK_ACCOUNT/SOFTWARE_LICENSE のフラグとエラーコピーのテスト追加。

### T-6 [中] `buildTeamSubmitDisabled` の新タイプテスト不足

- **推奨対応**: BANK_ACCOUNT/SOFTWARE_LICENSE で title のみ必須の検証テスト追加。

### T-7 [中] `buildBaselineSnapshot`/`buildCurrentSnapshot` の新タイプテスト不足

- **推奨対応**: BANK_ACCOUNT/SOFTWARE_LICENSE の snapshot 構築テスト追加。

### T-8 [中] トグルコールバックテスト不足

- **推奨対応**: `onToggleAccountNumber`, `onToggleRoutingNumber`, `onToggleLicenseKey` のテスト追加。

### T-9 [中] カスタムフィールドのフォーマット検証テスト

- **判断**: スキップ。`filterNonEmptyCustomFields` はフォーマット検証を行わない設計。

### T-10 [低] `bankAccountLabels`/`softwareLicenseLabels` のテスト不足

- **推奨対応**: text-props テストに新ラベルのアサーション追加。

### T-11 [低] エクスポートテストで全フィールド未検証

- **推奨対応**: bank/license JSON エクスポートテストに全フィールドアサーション追加。

### T-12 [低] `specificFieldsProps` の新タイプテスト不足

- **推奨対応**: bankAccount/softwareLicense entryKind でのプロパティ構築テスト追加。

## 2回目レビュー結果

### F-4 [低] Software License の `email` が `password-detail-inline.tsx` で表示されない

- **問題**: `isSoftwareLicense` セクションに email フィールドの表示がない
- **対応**: email 表示ブロックを licensee の後に追加

### セキュリティ観点: 指摘なし
### テスト観点: 指摘なし

## ユーザーフィードバック

### UF-1 accountType の表示値が翻訳されていない

- **問題**: 一覧・詳細で "checking" が生のまま表示
- **対応**: PasswordDetail.json / Share.json に accountType 翻訳キーを追加。detail-inline.tsx / share-entry-view.tsx でマッピング

### UF-2 Software License の email バリデーション未実装

- **問題**: email フィールドにフォーマット検証なし
- **対応**: software-license-form.tsx に正規表現バリデーション + エラー表示追加

### UF-3 変更履歴の表示項目が不足

- **問題**: `entry-history-section.tsx` の `DISPLAY_KEYS` に Bank Account / Software License / Passkey のフィールドが未登録。変更履歴の「表示」でタイトルしか表示されない
- **対応**: DISPLAY_KEYS に全エントリタイプのフィールドを追加。SENSITIVE_KEYS に accountNumber, routingNumber, iban, licenseKey, credentialId を追加

## 対応状況

### F-1 Software License email 欠落
- 対応: 5ファイルに email フィールド追加
- 修正ファイル: export-format-common.ts, password-import-payload.ts, team-entry-payload.ts, password-import-parsers.ts, share-entry-view.tsx

### F-2 accountNumberLast4 非数字除去
- 対応: `replace(/\D/g, "")` + 4桁未満で null
- 修正ファイル: password-import-payload.ts:86-87

### F-3 i18n ラベル不整合
- 対応: Share.json (ja/en) のラベルを BankAccountForm.json / PasswordDetail.json と統一
- 修正ファイル: messages/ja/Share.json, messages/en/Share.json

### S-1 BOOLEAN ハードコード英語
- 対応: `useTranslations("Common")` で `tc("yes")` / `tc("no")` に変更
- 修正ファイル: share-entry-view.tsx:60,187

### S-2 IBAN 非マスク
- 対応: share-entry-view.tsx で renderSensitiveField に変更。detail-inline.tsx で showIban トグル追加
- 修正ファイル: share-entry-view.tsx:322, password-detail-inline.tsx:113,200-205,313-336

### F-4 Software License email 詳細表示
- 対応: isSoftwareLicense セクションに email 表示ブロック追加
- 修正ファイル: password-detail-inline.tsx

### UF-1 accountType 翻訳
- 対応: 翻訳キー追加 + ternary マッピング
- 修正ファイル: messages/*/PasswordDetail.json, messages/*/Share.json, password-detail-inline.tsx, share-entry-view.tsx

### UF-2 email バリデーション
- 対応: regex バリデーション + エラー表示
- 修正ファイル: software-license-form.tsx, messages/*/SoftwareLicenseForm.json

### UF-3 変更履歴表示
- 対応: DISPLAY_KEYS / SENSITIVE_KEYS 拡張
- 修正ファイル: entry-history-section.tsx:60-71

### T-1〜T-12 テスト追加
- 対応: Export→Import 往復テスト、バリデーションテスト、Import payload テスト等を追加
- 修正ファイル: export-format-common.test.ts, team-password-form-actions.test.ts, password-import-payload.test.ts, password-import-parsers.test.ts, team-password-form-submit-args.test.ts, use-team-password-form-derived.test.ts, team-password-form-derived-helpers.test.ts, team-entry-specific-fields-callbacks.test.ts, team-entry-specific-fields-text-props.test.ts

---

# レビュー3回目: requireReprompt/expiresAt 横展開コミット (9bfccd3)

日時: 2026-02-28T17:00:00+09:00

## 機能観点の指摘
**指摘なし。** 全7エントリータイプに一貫して追加済み。データフロー完全。

## セキュリティ観点の指摘
**指摘なし。** 認可チェック・RLS・Zodバリデーション全て適切。

## テスト観点の指摘

### R3-1（低）: `makeEntryForGET` デフォルトに `requireReprompt`/`expiresAt` 未設定
- `passwords/[id]/route.test.ts`

### R3-2（中）: Team GETリストの `requireReprompt`/`expiresAt` レスポンステスト欠落
- `passwords/route.test.ts`

### R3-3（中）: Team PUT `expiresAt: null` クリアテスト欠落
- `passwords/[id]/route.test.ts`

### R3-4（中）: Team POST/PUT `expiresAt` 不正フォーマットバリデーションテスト欠落
- `passwords/route.test.ts`, `passwords/[id]/route.test.ts`

### R3-5（低）: 複数テストフィクスチャの型整合性
- 複数ファイルの `values`/`setters` mockに新フィールド未追加

### R3-6（低）: `team-password-form-submit-args.test.ts` pass-through未検証

## 対応状況
（修正後に追記）
