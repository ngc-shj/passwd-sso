# Plan Review: unify-team-display
Date: 2026-03-16
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### Finding 1 — Major (Resolved)
**Problem:** Member list タブの TeamRoleBadge が children スロット導入で内側（テキスト下）に移動し、現在の右端配置から視覚的レグレッションが発生する。
**Impact:** 非 admin ユーザーや自分自身のエントリで TeamRoleBadge の配置が変わる。
**Resolution:** MemberInfo は Avatar+Name+Email ブロックのみを担当。TeamRoleBadge は MemberInfo の sibling として外側に維持。children は transfer タブのみで使用（現在の内側配置と一致）。

### Finding 2 — Major (Resolved)
**Problem:** TenantMembersCard での isCurrentUser 渡しの有無が計画に未定義。渡すと "(you)" ラベルが新たに表示され振る舞いが変わる。
**Impact:** テナントメンバー画面の意図しない表示変更。
**Resolution:** TenantMembersCard では isCurrentUser を渡さないことを明示。

### Finding 3 — Minor (Accepted)
**Problem:** useTranslations("Team") の namespace が TenantMembersCard コンテキストで不適切。
**Impact:** namespace の混在による将来的な保守性リスク。
**Resolution:** isCurrentUser が渡されない場合、"(you)" ラベルは出力されないため実質的な問題はない。将来的な namespace 整理で対応可能。現時点では minor として受容。

## Security Findings

No findings.

## Testing Findings

### Finding 1 — Major (Resolved)
**Problem:** 影響を受ける既存コンポーネントにテストが存在せず、リファクタリングの正確性を保証するテストがない。
**Resolution:** MemberInfo コンポーネントのユニットテストを実装ステップに追加。prop バリエーション（null 組み合わせ、isCurrentUser、tenantName）をカバー。

### Finding 2 — Major (Resolved)
**Problem:** Transfer ownership タブのメール表示修正に対する自動テストが計画にない。
**Resolution:** MemberInfo のユニットテストでカバー（name+email 両方存在時にメールが表示されること）。

### Finding 3 — Minor (Resolved)
**Problem:** MemberInfo の prop バリエーションテストが未計画。
**Resolution:** テスト戦略に null/undefined 境界値ケースを含むテスト計画を追加。

## Adjacent Findings

None.
