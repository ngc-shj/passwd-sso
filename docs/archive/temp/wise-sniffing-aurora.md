# 評価結果: wise-sniffing-aurora.md

作成日: 2026-02-17

## 対象
- 指定された `~/.claude/plans/wise-sniffing-aurora.md` は存在しなかったため、現在開いている `~/.claude/plans/delegated-tinkering-quiche.md` を評価対象とした。
- 本レポートは `main.md` との差分比較を含まない。

## 主要指摘（重大度順）

1. `High` ライセンス例外承認の証跡として不十分
- 参照: `/Users/noguchi/.claude/plans/delegated-tinkering-quiche.md:64`, `/Users/noguchi/.claude/plans/delegated-tinkering-quiche.md:104`
- 現状案は「Git history = 承認履歴」としているが、実運用では「誰が法務判断したか」「いつ失効するか」「再レビュー条件」が曖昧。
- `license-allowlist.json` に `approvedBy`, `ticket`, `expiresAt`, `scope`（runtime/dev/optional）を必須化しないと、監査耐性が弱い。

2. `Medium` LGPL系の判断根拠が技術的前提に依存しすぎ
- 参照: `/Users/noguchi/.claude/plans/delegated-tinkering-quiche.md:61`
- `@img/sharp-*` を一括で「義務なし」と断定しているが、配布形態（コンテナ配布・オンプレ配布）で評価が変わる。
- 例外理由は「配布形態と法務見解へのリンク」を必須化すべき。

3. `Medium` strict 導入方針に回帰テスト戦略が不足
- 参照: `/Users/noguchi/.claude/plans/delegated-tinkering-quiche.md:66`, `/Users/noguchi/.claude/plans/delegated-tinkering-quiche.md:124`
- CLI スクリプトに機能追加（allowlist + strict）を行うのに、ユニットテスト/スナップショットテストの計画がない。
- 検証手順は手動中心で、将来の仕様変更で壊れやすい。

## 観点別評価

## 1. 機能
- 評価: 概ね妥当。
- 良い点:
  - `--strict` 導入で未レビュー依存の混入を CI で止める設計は適切。
  - `allowlisted` と `unreviewed` を分ける方針は運用に有効。
- 懸念:
  - allowlist のキー設計が package + license のみだと、同名パッケージの派生・複数配布物（platform-specific package）で管理が粗い。

## 2. セキュリティ/コンプライアンス
- 評価: 改善方向だが、監査証跡の粒度が不足。
- 良い点:
  - Review-required を CI fail に昇格する設計は強い。
- 懸念:
  - 例外承認のメタ情報不足（承認者・根拠リンク・期限）。
  - missing metadata の扱いで「npm registry 確認済み」の再現手順が明文化されていない。

## 3. テスト
- 評価: 不十分（自動テスト不足）。
- 良い点:
  - 手動検証観点（allowlist削除で fail）は妥当。
- 不足:
  - `scripts/check-licenses.mjs` のユニットテストが未計画。
  - 想定ケース（allowlist malformed / duplicate entry / unknown license / extension lockfile）の回帰確認が不足。

## 推奨アクション

1. `scripts/license-allowlist.json` のスキーマを強化
- 必須: `approvedBy`, `ticket`, `reviewedAt`, `expiresAt`, `scope`, `evidenceUrl`。

2. `scripts/check-licenses.mjs` に自動テスト追加
- ケース: strict pass/fail, allowlist未登録, allowlist重複, JSON不正, missing metadata。

3. `docs/license-policy.md` に法務判断フローを明記
- 「技術判断者」「法務承認者」「再レビュー条件（依存更新時）」を分離。
