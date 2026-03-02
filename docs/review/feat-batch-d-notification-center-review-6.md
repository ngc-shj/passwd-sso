# コードレビュー: feat/batch-d-notification-center (149fec0)

日時: 2026-03-02T20:05:00+09:00
レビュー回数: 6回目 (share permission fix のみ)

## 前回からの変更

- `applySharePermissions` にエントリータイプ別フィールド定義を追加
- `InlineDetailData` に `title` フィールドを追加
- `ShareE2EEntryView` のハイドレーションミスマッチを修正
- テスト 21 ケース追加

## ループ 1: 機能観点の指摘

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

## ループ 1: セキュリティ観点の指摘

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

## ループ 1: テスト観点の指摘

### T-1 (中): 未知の entryType に対するフォールバック動作テストがない

- ファイル: `src/lib/constants/share-permission.test.ts`
- 推奨: HIDE_PASSWORD + "FUTURE_TYPE" → LOGIN フォールバックを確認するテスト追加

### T-2 (中): ENTRY_TYPE_VALUES との同期検証テストがない

- 推奨: 全 ENTRY_TYPE で applySharePermissions がエラーなく動作するスモークテスト

### T-3 (低): VIEW_ALL + entryType 指定のテストがない

- 評価: 実装上 entryType を参照せず early return するため実質不要

## ループ 1: 対応状況

### F-1: SENSITIVE_FIELDS/OVERVIEW_FIELDS の型を EntryTypeValue に変更

- 対応: `Record<string, Set<string>>` → `Record<EntryTypeValue, Set<string>>` に変更し export
- コミット: 0588727

### F-2: team-archived-list の createDetailFetcher にフィールド追加

- 対応: 銀行口座・ソフトウェアライセンスの 14 フィールドを追加
- コミット: 0588727

### F-3: VIEW_ALL 時に浅いコピーを返却

- 対応: `return data` → `return { ...data }` に変更
- コミット: 0588727

### S-1: 未知 permission の fail-closed 化

- 対応: 未知 permission → OVERVIEW_ONLY フォールバック追加
- コミット: 0588727

### T-1: 未知 entryType フォールバックテスト追加

- 対応: 3 テスト追加 (HIDE_PASSWORD/OVERVIEW_ONLY/fail-closed)
- コミット: 0588727

### T-2: ENTRY_TYPE_VALUES 同期検証テスト追加

- 対応: 3 テスト追加 (全エントリータイプの Set 存在確認 + スモークテスト)
- コミット: 0588727

---

## ループ 2: 機能観点の指摘

### F-4 (低): SENSITIVE_FIELDS/OVERVIEW_FIELDS が index.ts から再エクスポートされていない

- ファイル: `src/lib/constants/index.ts` 行 68-73
- 問題: コードベース慣例として定数は `@/lib/constants` 経由で公開する設計

### F-5 (情報): swiftBic が BANK_ACCOUNT の SENSITIVE_FIELDS に含まれていない

- 評価: 設計判断として妥当（公開金融機関識別子）。コメントで意図を明記

### F-6 (情報): entryType パラメータ型が string のまま

- 評価: 呼び出し元が string で渡すため妥当。JSDoc で意図を明記

## ループ 2: セキュリティ観点の指摘

### S-4 (中): customFields が HIDE_PASSWORD をバイパスする

- ファイル: `src/lib/constants/share-permission.ts`
- 問題: HIDE_PASSWORD は拒否リスト方式のため customFields がパススルーされる
- 推奨: 全エントリータイプの SENSITIVE_FIELDS に customFields を追加

### S-5 (低): DEFAULT_SENSITIVE/DEFAULT_OVERVIEW が参照共有

- 問題: 同一 Set インスタンスへの参照で将来の変更リスク
- 推奨: `new Set(...)` で防御コピー

### S-6 (低): export された Set がミュータブル

- 推奨: `ReadonlySet<string>` + `Readonly<Record<...>>` に変更

## ループ 2: テスト観点の指摘

### T-4 (低): フォールバックテストで url/notes 検証欠落

- 推奨: backward compatibility テストと同等の検証範囲に拡張

### T-5 (中): sampleData 不一致でスモークテストが実質検証不足

- 推奨: SENSITIVE_FIELDS/OVERVIEW_FIELDS の非空検証テスト追加

## ループ 2: 対応状況

### F-4: index.ts に SENSITIVE_FIELDS/OVERVIEW_FIELDS を追加

- 対応: re-export リストに追加

### F-5: swiftBic の意図をコメントで明記

- 対応: `// swiftBic is intentionally excluded: ...` コメント追加

### F-6: entryType パラメータの JSDoc 改善

- 対応: JSDoc に `string` 型を受け入れる理由を明記

### S-4: customFields を SENSITIVE_FIELDS に追加

- 対応: 全 7 エントリータイプの SENSITIVE_FIELDS に `"customFields"` を追加

### S-5: DEFAULT_* を防御コピーに変更

- 対応: `new Set(SENSITIVE_FIELDS.LOGIN)` / `new Set(OVERVIEW_FIELDS.LOGIN)` に変更

### S-6: ReadonlySet + Readonly<Record<...>> に変更

- 対応: `Readonly<Record<EntryTypeValue, ReadonlySet<string>>>` に型変更

### T-4: フォールバックテストに url/notes 検証追加

- 対応: `expect(result).toHaveProperty("url", ...)` / `expect(result).toHaveProperty("notes", ...)` 追加

### T-5: 非空 Set 検証テスト追加

- 対応: SENSITIVE_FIELDS/OVERVIEW_FIELDS の全エントリータイプで `size > 0` 検証 + customFields 専用テスト 3 件追加
