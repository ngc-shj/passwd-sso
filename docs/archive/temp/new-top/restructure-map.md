# Docs Restructure Map (non-breaking)

このマップは **現行ファイルを移動せず** に、論理的な配置を定義するものです。

## 1. Governance / Readiness

- `docs/production-readiness.md`
- `docs/security-review.md`
- `docs/feature-gap-analysis.md`

## 2. Security / Compliance

- `docs/security-considerations.ja.md`
- `docs/security-considerations.en.md`
- `docs/license-policy.md`
- `docs/cors-policy.md`

## 3. Deployment / Operations

- `docs/deployment.md`
- `docs/backup-recovery.ja.md`
- `docs/backup-recovery.en.md`
- `docs/setup.*.ja.md` / `docs/setup.*.en.md`

## 4. Reviews

- `docs/review/*.md`（恒久的なレビュー結果）

## 5. Working Notes (volatile)

- `docs/temp/*.md`
  - 例: `feat-*.md`, `*-plan.md`, `*-manual-test.md`, `*-review.md`

## 6. Archived

- `docs/archive/*.md`

---

## 命名規約（提案）

`docs/temp/`:
- 機能計画: `feat-<topic>.md`
- 手動テスト: `feat-<topic>-manual-test.md`
- レビュー草案: `<branch>-review.md`
- 一時メモ: `<date>-<topic>-note.md`

`docs/review/`:
- `YYYY-MM-DD-<scope>-review.md`（将来的に統一）

## 廃棄ポリシー（提案）

- `docs/temp/` はマージ後 14〜30 日で削除候補化
- `docs/review/` は残す（監査トレイル）
