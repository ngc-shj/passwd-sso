# コードレビュー: feat/batch-c-security-foundation
日時: 2026-02-20T17:30:00+09:00
レビュー回数: 4回目 (最終)

## 前回からの変更
Loop 1 の指摘を全て対応し、commit `41578e6` で修正。

## Loop 1: 機能観点の指摘 (9件)

### F-1 [解決済] password-card.tsx: Date計算の3重繰り返し
- 対応: 変数 `expiresMs`, `nowMs`, `thresholdMs`, `isExpired` に抽出
- 修正ファイル: src/components/passwords/password-card.tsx:490-506

### F-2 [解決済] password-card.tsx: 30日マジックナンバー
- 対応: `EXPIRING_THRESHOLD_DAYS` を `@/hooks/use-watchtower` からインポート
- 修正ファイル: src/components/passwords/password-card.tsx:58

### F-3 [解決済] DuplicateSection: Badge variant の冗長な三項演算子
- 対応: `<Badge variant="secondary">` に簡略化
- 修正ファイル: src/components/watchtower/issue-section.tsx:221

### F-4 [許容] entry-expiration-section.tsx: min={today} が既存過去日付の編集を妨げる可能性
- API側は過去日も受け入れるため UI 制約のみ。意図的設計として許容。

### F-5 [許容] formatExpiringDetails: 想定外 details 形式のフォールバックなし
- 既存 formatOldDetails / formatUnsecuredDetails も同パターン。プロジェクト慣例に合致。

### F-6 [確認済] expiring がスコアに含まれていない → 意図的設計
- テストでも検証済み。ユーザー設定のリマインダーであり品質指標ではない。

### F-7 [許容] DuplicateSection: key にインデックス使用
- 既存 ReusedSection も同パターン。静的リストなので問題なし。

### F-8 [確認済] Org の expiresAt カラムは dead column
- プラン文書で明記済み。後続バッチで API/フォーム対応予定。

### F-9 [解決済] entry-expiration-section.tsx: today が UTC ベース
- 対応: `getFullYear()/getMonth()/getDate()` でローカル日付を使用
- 修正ファイル: src/components/passwords/entry-expiration-section.tsx:23-24

## Loop 1: セキュリティ観点の指摘 (5件)

### S-1 [低リスク/延期] expiresAt の日付範囲制限なし
- 自ユーザー Vault 内に閉じるため低リスク。サーバー側通知実装時に対応。

### S-2 [情報提供] normalizeHostname の \0 区切り → 実質的影響なし

### S-3 [問題なし] DuplicateSection リンクのロケール → next-intl Link が自動付与

### S-4 [許容] expiresAt 平文保存 → requireReprompt 等と同パターン

### S-5 [解決済] Date 計算の繰り返し → F-1 と同時に修正

## Loop 1: テスト観点の指摘 (9件)

### T-1 [解決済] 境界値テスト (31日) のタイミング競合
- 対応: `vi.useFakeTimers()` + `vi.setSystemTime("2026-06-01T12:00:00Z")` で時刻固定
- 修正ファイル: src/hooks/use-watchtower.test.ts:1226-1250

### T-2 [解決済] 境界値テスト (30日) のタイミングリスク
- 対応: 同様に時刻固定
- 修正ファイル: src/hooks/use-watchtower.test.ts:1199-1224

### T-3 [解決済] entry-expiration-section: min属性テスト
- 対応: min 属性がローカル日付に設定されることを検証
- 修正ファイル: src/components/passwords/entry-expiration-section.test.tsx:99-113

### T-4 [解決済] duplicate-section: 複数グループテスト
- 対応: 2グループのフィクスチャでバッジ数と描画を検証
- 修正ファイル: src/components/watchtower/duplicate-section.test.tsx:112-143

### T-5 [解決済] duplicate-section: username=null テスト
- 対応: null usernameのエントリが描画されないことを検証
- 修正ファイル: src/components/watchtower/duplicate-section.test.tsx:145-165

### T-6 [解決済] use-watchtower: 重複のみスコアテスト
- 対応: 2エントリ重複のみでスコア95点を検証
- 修正ファイル: src/hooks/use-watchtower.test.ts:1291-1313

### T-7 [解決済] route.test.ts: 不正 expiresAt バリデーション
- 対応: `"not-a-date"` → 400エラーを検証
- 修正ファイル: src/app/api/passwords/route.test.ts:861-866

### T-8 [延期] password-card: バッジ表示ロジックのテスト不在
- 複雑なコンポーネント (多数のモック必要)。別バッチで対応。

### T-9 [解決済] state.test.ts: reused カウント検証
- 対応: reused entries + old の合計カウントを検証
- 修正ファイル: src/lib/watchtower/state.test.ts:69-81

## Loop 2: 再レビュー結果

### 機能観点: 指摘なし
- F-1, F-2, F-3, F-9 の修正がすべて正しく反映されていることを確認
- 新たな問題・見落としなし

### セキュリティ観点: 指摘なし
- 今回の修正で新たなセキュリティ問題は発生していない
- 前回の許容/延期判定も変更なし

### テスト観点: 指摘なし
- T-1〜T-9 (T-8延期を除く) の全対応が正しく実装されていることを確認
- `vi.useFakeTimers()` パターンが適切 (`try/finally` でクリーンアップ)
- 全2178テスト通過

## Loop 3: 再レビュー結果 (commit 5243b48 + 未コミット分)

### 機能観点: 指摘なし
### セキュリティ観点: 指摘なし
### テスト観点: 指摘1件
- format-details のテスト不在 → `format-details.ts` に関数抽出 + `format-details.test.ts` 追加で解決

## Loop 3 対応

### format-details テスト追加
- 対応: 5つのフォーマット関数を `watchtower/page.tsx` から `format-details.ts` に抽出、8テスト追加
- 修正ファイル: src/lib/watchtower/format-details.ts (新規), src/lib/watchtower/format-details.test.ts (新規)
- commit: `5243b48`

### expiresAt 編集フォーム未反映バグ修正
- 対応: `FormData` に `expiresAt` 追加、`setData()` で `raw.expiresAt` を読み込み
- 修正ファイル: src/components/passwords/password-edit-dialog.tsx:101,202
- commit: `51fdc70`

## Loop 4: 再レビュー結果

### 機能観点: 指摘なし
- 関数抽出は等価性が保たれており、ロケール対応日付フォーマットは適切
- expiresAt バグ修正は requireReprompt/folderId と一貫したパターン

### セキュリティ観点: 指摘なし
- 純粋なリファクタリングとデータフロー修正であり、新たなセキュリティリスクなし
- XSS: React の自動エスケープで保護、dangerouslySetInnerHTML 不使用
- API 側 Zod バリデーション (ISO 8601 datetime) で入力制約済み

### テスト観点: 指摘なし
- format-details.test.ts の8テストが実装と正しく整合
- expiresAt の CRUD は API テストで網羅的に検証済み

## Loop 5: 再レビュー結果 (commit d14f970: タイムゾーン誤判定修正)

### 機能観点: 指摘なし
- `T23:59:59.999Z` 保存 + 日付文字列比較への変更でタイムゾーン問題を適切に解消
- `YYYY-MM-DD` 辞書順比較は正しく動作、`daysDiff` も UTC midnight 同士で正確

### セキュリティ観点: 指摘なし
- `split("T")[0]` は安全（T なしでも元文字列が返るのみ）
- Zod バリデーションで不正形式の DB 保存を防止済み
- ローカル日付生成はクライアントサイドで意図通り

### テスト観点: 指摘なし
- 既存境界値テスト (30日/31日) が新ロジックを正しく検証
- 日付文字列比較への変更でタイムゾーン問題が構造的に排除

## 検証結果

- vitest: 257 files, 2186 tests passed
- tsc: pre-existing errors only (no new errors)
- lint: clean
- build: successful
