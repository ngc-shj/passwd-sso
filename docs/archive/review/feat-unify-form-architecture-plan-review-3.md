# プランレビュー: feat/unify-form-architecture
日時: 2026-03-03T00:00:00+09:00
レビュー回数: 3回目

## 前回からの変更
ラウンド2の採用8件を反映済み（F-1, F-4, F-5, S-7, S-8, S-9, T-7, T-8, T-10）。

## 機能観点の指摘

### R3-1: Phase 1 削除順序の明示 (却下)
- **問題**: 削除対象の依存順序が明示されていない
- **判定**: プランの表は暗黙に依存順序で並べており、i18n namespaceクリーンアップも記載済み。`NS_DASHBOARD_CORE` は `namespace-groups.ts` の一部であり既にカバーされている

### R3-2: Phase 1 の `variant: "page"` 書き換え方針が不明確 (採用)
- **問題**: `PasswordFormPageShell` 削除後、`PasswordForm` の `variant === "page"` 分岐をどう書き換えるかが曖昧
- **推奨対応**: `SecureNoteForm` 等と同じインラインpage variant rendering（`ArrowLeft` + `Card` パターン）に書き換えることを明記

### R3-3: Phase 3a/3b の `useTeamBaseFormModel` 登場タイミング不整合 (採用)
- **問題**: Phase 3a のコード構造例に Phase 3b で作成されるベースフックが既に登場している
- **推奨対応**: Phase 3a では現行 `useTeamPasswordFormModel` をそのまま使用し、Phase 3b でベースフックに分離する旨を明記

## セキュリティ観点の指摘

### S-10: MEMBER編集ボタンの詳細化 (却下)
- **問題**: Phase 4のMEMBER権限分岐の実装詳細が不足
- **判定**: S-7採用として既にPhase 4に `createdBy.id === session.user.id` の分岐追加を明記済み。実装詳細レベルでありプランで十分

### S-11: createTeamE2EPasswordSchema refinement未追加 (却下 — プラン上は対応済み)
- **問題**: コード上でrefinementがまだ追加されていない
- **判定**: S-8採用としてPhase 3セキュリティ制約に明記済み。プラン策定フェーズであり実装は未開始。プランの記載で十分

### S-12: overviewBlobへのentryType包含判断 (却下 — プラン上は対応済み)
- **問題**: overviewBlobにentryTypeが含まれておらず型定義も未作成
- **判定**: S-6採用として「entryTypeフィールドの包含可否を型定義設計時に決定し文書化」と記載済み。実装時の詳細

## テスト観点の指摘

### T-17: Phase 3d の `team-entry-submit` grepパターンが曖昧 (採用)
- **問題**: `team-entry-submit` は削除対象だが、依存先の切り替えが前提条件として必要。grepヒット時の判断基準が不明確
- **推奨対応**: チェックリストに依存切り替え前提のコメントを追加

### T-18: 最低テスト項目の位置づけ (却下)
- **問題**: 最低テスト項目にフォルダ0件テストが含まれない
- **判定**: プランが「全テストケース移植」を義務付けているため、最低テスト項目はサマリーとして十分
