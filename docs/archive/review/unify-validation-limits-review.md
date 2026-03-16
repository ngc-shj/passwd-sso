# Plan Review: unify-validation-limits
Date: 2026-03-16
Review round: 2

## Changes from Previous Round
Round 1 の全 Major (F1, F2, S1, T1, T2) と全 Minor (F3-F5, S2-S4, T3) をプランに反映:
- `.max()` → `hexIv`/`hexAuthTag` 置換を仕様強化として明記
- `HISTORY_BLOB_MAX`, `SCIM_PATCH_OPERATIONS_MAX`, `SCIM_GROUP_MEMBERS_MAX` 追加
- `teamHistoryReencryptSchema` を明示、`encryptedFieldSchema` iv/authTag の hex 検証追加を Step 2 に追記
- `common.server.ts` 分離を明示的な実装ステップに昇格（Step 1 冒頭に配置基準を記載）
- `prisma-sync.test.ts` の仕様を詳細化（配置場所、選定基準、対象外の説明）
- 既存テスト更新リストを拡充（5ファイル、import 指示を追記）
- Testing Strategy にハードコード残存チェックと build 検証を追加
- `z.enum()` は string 型のみに適用する制約を明記
- `SHARE_PASSWORD_MAX_ATTEMPTS` のクライアント UX 用注釈を追加

## Functionality Findings (Round 2)

### F-R2-1 [Minor] `SEND_EXPIRY_MAP` と `EXPIRY_PERIODS` の重複
- `src/lib/constants/share-type.ts` の `SEND_EXPIRY_MAP` と `api/share-links/route.ts` のローカル `EXPIRY_MAP` が同一キー
- 範囲境界だが、将来メンテリスクあり → 実装時に検討

### F-R2-2 [Minor] `TAILNET_NAME_MAX_LENGTH` (63) vs Prisma VarChar(255) の差異
- 意図的な設計差異 → prisma-sync.test.ts の対象外として文書化済み

→ **No new Major findings**

## Security Findings (Round 2)

### S-R2-1 [Minor] `encryptedFieldSchema` iv/authTag に hex 形式検証追加
- Step 1d で対処予定、Step 2 の置換表にも明示済み

### S-R2-2 [Minor] `common.server.ts` 分離のタイミング
- Step 1 冒頭で配置基準を明記済み

→ **No new Major findings**

## Testing Findings (Round 2)

### T-R2-1a [Resolved] `@db.Text` フィールドが VarChar regex で捕捉できない
- prisma-sync.test.ts の「対象外」セクションに `@db.Text` の扱いを明記済み

### T-R2-1b [Resolved] 選定基準が未定義
- 選定基準を2カテゴリ（暗号hexパターンマッチ + 名前付きフィールド明示マッピング）で定義済み

### T-R2-2a [False positive] `src/lib/validations.test.ts` は実際に存在する

### T-R2-2b [Resolved] route.test.ts ハードコード値の網羅
- Step 5 のリストを詳細化済み

→ **No new Major findings**

## Adjacent Findings
(なし)

## Resolution Status
Round 1: F1-F5, S1-S4, T1-T3 — all resolved
Round 2: All findings Minor, no Major/Critical remaining
