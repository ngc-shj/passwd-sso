# docs/new-top (draft)

このディレクトリは、現在の `./docs` を **壊さずに再構成するための新トップ設計** です。

前提:
- 同一ブランチ上で AI 自動レビュー + commit が走る
- `docs/temp/*.md` に作業中レビュー・計画メモが増え続ける
- 既存リンクを壊さずに、参照導線だけ先に整理したい

## 目的

1. 「正式ドキュメント」と「作業中メモ」を分離する
2. セキュリティ/運用/実装計画の入口を明確にする
3. レビュー時に見るべきファイルを最短で辿れるようにする

## いまの運用ルール（新）

- `docs/` 直下: 正式ドキュメント（恒久）
- `docs/review/`: レビュー結果（恒久、要約）
- `docs/temp/`: 作業中メモ（短期、変動大）
- `docs/archive/`: 旧計画・凍結資料（参照のみ）

## 推奨トップ導線

1. 本番準備/進捗確認: `docs/production-readiness.md`
2. デプロイ手順: `docs/deployment.md`
3. セキュリティ方針: `docs/security-considerations.ja.md` / `docs/security-considerations.en.md`
4. ライセンス監査: `docs/license-policy.md`
5. 差分/不足分析: `docs/feature-gap-analysis.md`
6. 最新レビュー記録: `docs/review/`
7. 開発中タスク・評価メモ: `docs/temp/`

## 再構成対象（段階移行）

- Phase A: 入口整備（このファイル + `docs/README.md` 更新）
- Phase B: `docs/temp/` の命名規約と寿命管理
- Phase C: `docs/review/` のテンプレート統一
- Phase D: 必要なら物理移動（リンク更新を伴う）

詳細マップは `docs/temp/new-top/restructure-map.md` を参照。
