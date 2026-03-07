# コードレビュー: 1391a67 fix(tags): accept null color in updateTagSchema

日時: 2026-02-20T13:30:00+09:00
レビュー回数: 2回目 (完了)

## 前回からの変更

- T-1 対応: `src/app/api/tags/[id]/route.test.ts` に `color: null` リグレッションテスト追加

## 機能観点の指摘

指摘なし

## セキュリティ観点の指摘

指摘なし

## テスト観点の指摘

指摘なし

## 対応状況

| 指摘 | 対応 | 修正ファイル |
| ---- | ---- | ------------ |
| F-1 (低) | スキップ (Org タグに色編集 UI なし) | - |
| T-1 (中) | テスト追加 | `src/app/api/tags/[id]/route.test.ts` |
