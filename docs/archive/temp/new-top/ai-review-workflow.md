# AI Auto-Review Workflow (same-branch)

## 背景

同一ブランチ上で AI が自動レビューと commit を行う運用では、
「レビュー結果」と「修正履歴」が混在しやすい。

## 最低ルール

1. レビュー記録は `docs/review/` または `docs/temp/` に分離して保存
2. コード修正 commit はレビュー記録 commit と分ける
3. セキュリティ指摘は severity を付与（High/Medium/Low）
4. レビュー対象コミット SHA を明記する
5. `docs/temp/` の長期残置を避ける（定期棚卸し）

## 推奨フォーマット

- 対象: ブランチ名 / コミット SHA
- 観点: 機能 / セキュリティ / テスト
- 指摘: 重大度順（ファイル:行）
- 対応: 修正内容、テスト結果、未対応理由

## 反映先

- 確定レビュー: `docs/review/`
- 作業中レビュー: `docs/temp/`
