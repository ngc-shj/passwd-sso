# コードレビュー: feat/group-c-entry-types-custom-fields

日時: 2026-02-28T11:30:00+09:00
レビュー回数: 1回目

## 前回からの変更

初回レビュー

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

## 対応状況

(修正後に追記)
