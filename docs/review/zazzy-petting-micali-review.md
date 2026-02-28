# プランレビュー: zazzy-petting-micali.md (Group C)

日時: 2026-02-28T16:00:00+09:00
レビュー回数: 5回目 (最終)

## 前回からの変更

- 2回目: F-23, F-24, F-28 をプランに反映
- 3回目: F-29 (チームフォームフックアーキテクチャ) を中心とした重大な構造的指摘を受け Phase 6.9 を全面書き換え
- 4回目: F-41 (formatExportCsv isLogin), S-4 (isSafeHref 実装仕様), T-NEW-11 (parsePasswdSsoPayload) を反映
- 5回目: セキュリティ・テスト専門家が指摘なし。機能専門家の指摘は実装詳細のみ → レビュー完了

---

## 機能観点の指摘 (3回目: 12件中 有効8件)

### F-29 [高] Phase 6.9 がチームフォームのフックアーキテクチャと不整合

- **問題**: プランは `team-password-form.tsx` に直接 `useState` / `useTranslations` を追加する記述だったが、実際のフォームは `useTeamPasswordFormModel` に全委譲し、12以上のフックファイルで状態管理している
- **影響**: プラン通りに実装するとアーキテクチャ違反。hasChanges/submitDisabled/ライフサイクルが動作しない
- **対応**: Phase 6.9 を 6.9.1〜6.9.12 に分割し、全フックファイルの変更を明記

### F-30 [中] チームフォーム翻訳がフック経由で提供される

- **問題**: Phase 6.9 の `useTranslations("BankAccountForm")` が Phase 2.5 と重複
- **対応**: Phase 6.9 から削除。翻訳は Phase 2.5 のフック経由のみ

### F-34 [高] `team-password-form-actions.ts` が未記載

- **問題**: submit フローの `SubmitTeamPasswordFormArgs` にフィールド追加が必要
- **対応**: Phase 6.9.11 に追加

### F-35 [高] フック関連12ファイルが Modified files から漏れ

- **対応**: File Summary を ~52 modified files に更新

### F-36 [中] `use-team-password-form-derived.ts` のバリデーション

- **対応**: Phase 6.9.8 + 6.9.9 に追加

### F-37 [低] accountNumberLast4 導出ロジック未指定

- **対応**: Phase 3.1 + 6.7 に具体的な導出ルールを明記

### F-32 [低] `csvEntryType` 戻り値型の拡張

- **対応**: Phase 7.4 に return type union の拡張を明記

### F-38 [中] purchaseDate/expirationDate vs issueDate/expiryDate 命名

- **判断**: スキップ。意味的に異なるフィールド（購入日 vs 発行日、ライセンス有効期限 vs 書類有効期限）のため、別名を維持。i18n ラベルで表示を区別。

### スキップした指摘

- F-31 [Info]: filterNonEmptyCustomFields は BOOLEAN "false" を正しく通過。修正不要
- F-33 [Info]: 既存パスキーCSV未検出 → 対応済み（isPasskey フラグ追加 + テスト追加）
- F-39 [Info]: CSV bank/license は passwd-sso 形式のみ。期待動作
- F-40 [中]: Phase 7.4 に `passwdSsoCsvPayload()` 既に記載済み

---

## セキュリティ観点の指摘 (3回目: 4件中 有効3件)

### S-C-1 [高] share-entry-view.tsx の href に未検証 URL — XSS リスク

- **問題**: `href={String(data.url)}` と `href={f.value}` (カスタムフィールド URL) でプロトコル検証なし。`javascript:` スキーム注入が可能
- **影響**: Share リンク受信者がリンククリック時に任意 JS 実行
- **対応**: Phase 7.7 に URL プロトコルホワイトリスト (`http:`, `https:` のみ) を追加

### S-C-2 [中] 既存日付フィールドに .max() 制約なし

- **問題**: `creationDate`, `dateOfBirth`, `issueDate`, `expiryDate` が `z.string().nullish()` のまま
- **対応**: Phase 7.6 に既存4フィールドの `.max(50)` 追加を明記

### S-C-4 [低] accountNumberLast4 導出仕様不足

- **対応**: F-37 と統合。Phase 3.1 + 6.7 に明記済み

### スキップした指摘

- S-C-3 [中]: Phase 6.7 (F-1) で全7タイプの overviewBlob 分岐として対応済み

---

## テスト観点の指摘 (3回目: 8件中 有効5件)

### T-NEW-1 [高] filterNonEmptyCustomFields の BOOLEAN 空文字テスト

- **対応**: Phase 9.8 に `"false"` (非空) と `""` (空) 両方のテストケースを明記

### T-NEW-3 [中] overviewBlob 未テスト型の正確な特定

- **問題**: 「5型すべて未テスト」は不正確。CREDIT_CARD のみ overviewBlob 未テスト
- **対応**: Phase 9.1 の記述を「CREDIT_CARD overviewBlob 未テスト + 全型フィールド網羅確認」に修正

### T-NEW-5 [中] team-entry-specific-fields テストの前提条件

- **対応**: Phase 9.6 に `vi.mock` 登録 + props 拡張の前提条件を明記

### T-NEW-6 [中] import parsers の type 判定仕様

- **対応**: Phase 9.3 に CSV/JSON/Bitwarden 形式別のテスト仕様を明記

### T-NEW-8 [低] DATE/MONTH_YEAR の blob 内 type 保存検証

- **対応**: Phase 9.8 に customFields 配列の `type` フィールド保存確認を明記

### スキップした指摘

- T-NEW-2 [高]: csvEntryType フォールスルー防止 — 既存テストパターンで `toBe("bankaccount")` が十分
- T-NEW-4 [中]: ValidateTeamEntryInput 拡張前提 — Phase 6.8 で記載済み
- T-NEW-7 [低]: ExportEntry 拡張 — Phase 7.4 で記載済み

---

## 4回目レビュー結果 (有効指摘のみ)

### 機能: F-41 [高] formatExportCsv の isLogin フラグ

- **対応**: Phase 7.4 に `isLogin` 除外条件の修正を追記

### セキュリティ: S-4 [高] isSafeHref 実装仕様

- **対応**: Phase 7.7 に `new URL().protocol` ベースのコードスニペットを追記

### テスト: T-NEW-11 [中] parsePasswdSsoPayload フィールドデコード

- **対応**: Phase 7.2 に14フィールドのデコード処理追加を明記

### その他反映

- F-44 [中]: SOFTWARE_LICENSE の setExpiryError 再利用パターン → Phase 6.9.11 に追記

---

## 5回目レビュー結果 (最終)

- 機能専門家: 実装詳細の要求7件（コードスニペット、関数配置、enum定義）→ プランレベルの問題なし、スキップ
- セキュリティ専門家: **指摘なし**
- テスト専門家: **指摘なし**

---

## レビュー完了サマリー

| 項目 | 値 |
|------|-----|
| 総ループ回数 | 5回 |
| 最終状態 | セキュリティ・テスト指摘なし、機能指摘は実装詳細のみ（全観点クリア） |
| プランファイル | `~/.claude/plans/zazzy-petting-micali.md` |
| レビューファイル | `docs/review/zazzy-petting-micali-review.md` |
