# Plan Review: ux-send-hibp-google-warnings
Date: 2026-04-05
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Minor]: parseAllowedGoogleDomains() を再利用すべき
- **Problem**: NEW-5 で `process.env.GOOGLE_WORKSPACE_DOMAINS` を直接パースする計画だが、`src/lib/google-domain.ts` に `parseAllowedGoogleDomains()` が既存。空白トリム・lowercase・空エントリ除去の正規化処理が重複する。
- **Impact**: トレーリングカンマ等でカウントが乖離し、単一ドメインなのにマルチドメインヒントが表示される可能性。
- **Recommended action**: `parseAllowedGoogleDomains()` をインポートして使用する。

### F2 [Minor]: バナー配置位置が不適切
- **Problem**: NEW-3 のバナーを line ~204（DialogDescription の下）に置くと、`createdUrl` が設定された後（URL表示画面）にも表示される。
- **Impact**: 作成後の画面に不要な通知が残り、視覚的ノイズになる。
- **Recommended action**: `createdUrl` が null のブランチ内（フォーム表示部分の先頭）に配置する。

## Security Findings

### S1 [Minor]: 暗号化アーキテクチャの文言表現
- **Problem**: "server-side encryption (not E2E)" という否定形はアーキテクチャ詳細の開示にあたる。
- **Impact**: 増分リスクは限定的（既存の `personalShareWarning` で同等情報が公開済み）。
- **Recommended action**: ポジティブな表現に調整（例: "Sends are encrypted in transit and at rest on the server"）。E2Eとの明示的比較は避ける。

## Testing Findings

### T1 [Major]: send-dialog.test.tsx にバナーテスト不足
- **Problem**: 新バナーのレンダリングを検証するテストが計画にない。「ビジュアル検証」は CI で機能しない。
- **Impact**: バナー翻訳キーの欠落や条件分岐誤りが CI で検出されない。
- **Recommended action**: 既存のモックパターンを使い、バナーのレンダリングテストを追加。

### T2 [Major]: signin page テストにマルチドメインヒントテスト不足
- **Problem**: 多ドメインヒントの条件分岐テストが計画にない。既存テストに `process.env` 操作パターンがあり拡張容易。
- **Impact**: 条件分岐の破損や情報漏洩の回帰が CI で検出されない。
- **Recommended action**: `GOOGLE_WORKSPACE_DOMAINS` の有無で2ケース（表示/非表示）のテストを追加。

### T3 [Minor]: 翻訳キーハードコードの照合リスク
- **Problem**: テストで翻訳キー名をハードコードするパターン。キー名変更時に乖離が生じうる。
- **Impact**: 軽微。プロジェクト全体の既存パターンと同じ。
- **Recommended action**: PR レビュー時にキー名一致を確認。定数化は不要。

## Adjacent Findings
None

## Quality Warnings
None
