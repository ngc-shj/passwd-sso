# コードレビュー: feat/batch-d-notification-center (149fec0)
日時: 2026-03-02T20:05:00+09:00
レビュー回数: 6回目 (share permission fix のみ)

## 前回からの変更
- `applySharePermissions` にエントリータイプ別フィールド定義を追加
- `InlineDetailData` に `title` フィールドを追加
- `ShareE2EEntryView` のハイドレーションミスマッチを修正
- テスト 21 ケース追加

## 機能観点の指摘

### F-1 (中): SENSITIVE_FIELDS/OVERVIEW_FIELDS のキーが EntryTypeValue と型同期されていない
- ファイル: `src/lib/constants/share-permission.ts` 行 26-44
- 問題: `Record<string, Set<string>>` 型のため、新エントリータイプ追加時にキー追加忘れがコンパイルで検出されない
- 推奨: `Record<EntryTypeValue, Set<string>>` に変更

### F-2 (中): team-archived-list の createDetailFetcher に銀行口座・ソフトウェアライセンスのフィールド欠落
- ファイル: `src/components/team/team-archived-list.tsx` 行 327-373
- 問題: bankName, accountNumber, softwareName, licenseKey 等が未抽出
- 推奨: teamId/page.tsx 側と同じフィールドを追加

### F-3 (低): VIEW_ALL 時に入力データの参照を直接返却
- ファイル: `src/lib/constants/share-permission.ts` 行 64-65
- 問題: HIDE_PASSWORD/OVERVIEW_ONLY はコピーを返すが VIEW_ALL は参照を返す（非対称）
- 推奨: 現在の呼び出し元では実害なし。JSDoc に明記するか `{ ...data }` に変更

## セキュリティ観点の指摘

### S-1 (中): 未知の permission 文字列で全データが返る (fail-open)
- ファイル: `src/lib/constants/share-permission.ts` 行 88
- 問題: VIEW_ALL/OVERVIEW_ONLY/HIDE_PASSWORD のいずれにも該当しない場合、フィルタリングなしで全データを返す
- 推奨: fail-closed に変更（未知 permission → OVERVIEW_ONLY 相当を適用）

### S-2 (情報): IDENTITY の HIDE_PASSWORD で住所・電話等の PII が残る
- ファイル: `src/lib/constants/share-permission.ts` 行 30
- 問題: idNumber のみ除外で address/phone/dateOfBirth が残る設計判断
- 評価: 設計判断として妥当。UI で共有範囲を明示すべきか要検討

### S-3 (情報): E2E share のフラグメント削除タイミング改善
- ファイル: `src/components/share/share-e2e-entry-view.tsx` 行 112
- 評価: 鍵パース前にフラグメント削除するようになり、セキュリティ改善

## テスト観点の指摘

### T-1 (中): 未知の entryType に対するフォールバック動作テストがない
- ファイル: `src/lib/constants/share-permission.test.ts`
- 推奨: HIDE_PASSWORD + "FUTURE_TYPE" → LOGIN フォールバックを確認するテスト追加

### T-2 (中): ENTRY_TYPE_VALUES との同期検証テストがない
- 推奨: 全 ENTRY_TYPE で applySharePermissions がエラーなく動作するスモークテスト

### T-3 (低): VIEW_ALL + entryType 指定のテストがない
- 評価: 実装上 entryType を参照せず early return するため実質不要

## 対応状況

### F-1: SENSITIVE_FIELDS/OVERVIEW_FIELDS の型を EntryTypeValue に変更

- 対応: `Record<string, Set<string>>` → `Record<EntryTypeValue, Set<string>>` に変更し export
- 修正ファイル: `src/lib/constants/share-permission.ts:28-47`

### F-2: team-archived-list の createDetailFetcher にフィールド追加

- 対応: bankName, accountType, accountHolderName, accountNumber, routingNumber, swiftBic, iban, branchName, softwareName, licenseKey, version, licensee, purchaseDate, expirationDate を追加
- 修正ファイル: `src/components/team/team-archived-list.tsx:368-381`

### F-3: VIEW_ALL 時に浅いコピーを返却

- 対応: `return data` → `return { ...data }` に変更
- 修正ファイル: `src/lib/constants/share-permission.ts:67`

### S-1: 未知 permission の fail-closed 化

- 対応: 未知の permission 文字列 → OVERVIEW_ONLY (最も制限的) を適用するフォールバック追加
- 修正ファイル: `src/lib/constants/share-permission.ts:90-96`

### S-2: IDENTITY の PII 残留 (情報)

- 判断: 設計判断として妥当。HIDE_PASSWORD は「機密性の高い識別番号」のみ除外する設計意図
- 対応不要

### T-1: 未知 entryType フォールバックテスト追加

- 対応: HIDE_PASSWORD + "FUTURE_TYPE" / OVERVIEW_ONLY + "FUTURE_TYPE" / 未知 permission の fail-closed テスト追加
- 修正ファイル: `src/lib/constants/share-permission.test.ts:325-356`

### T-2: ENTRY_TYPE_VALUES 同期検証テスト追加

- 対応: 全 ENTRY_TYPE で SENSITIVE_FIELDS/OVERVIEW_FIELDS の存在確認 + applySharePermissions がエラーなく動作するスモークテスト追加
- 修正ファイル: `src/lib/constants/share-permission.test.ts:358-387`
