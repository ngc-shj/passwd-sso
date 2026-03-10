# Plan Review: fix-sso-tenant-first-signin
Date: 2026-03-11
Review round: 1

## Changes from Previous Round
Initial review

## Local LLM Pre-screening Results

10 findings (3 Critical, 4 Major, 3 Minor). After evaluation:
- 4 false positives (tenant claim trust, race condition, provider support, audit logging scope)
- 4 already addressed in plan (ALS propagation, circular dependency, role assignment)
- 2 valid points incorporated (ALS context guarantee clarification, MEMBER role design rationale)

## Functionality Findings

### F-1 [Major] `findOrCreateSsoTenant` の RLS コンテキスト管理が曖昧
- **Problem**: Step 2 では "Must be called inside `withBypassRls` context" と記載。Step 5b の疑似コードでは `withBypassRls` の外で呼んでいる。`findOrCreateSsoTenant` が内部で `withBypassRls` を呼ぶのか、呼び出し元に委ねるのかが矛盾。
- **Impact**: RLS バイパスが欠如した場合テナント作成がエラー。二重ネストでの予期せぬ動作。
- **Recommended action**: `findOrCreateSsoTenant` は RLS コンテキストを呼び出し元が保証する前提とし、Step 5b の疑似コードを `withBypassRls` ブロック内に移動する。

### F-2 [Major] Step 5b のトランザクション境界設計が不明確
- **Problem**: `findOrCreateSsoTenant` がトランザクション外で実行され、ユーザー作成とアトミックでない。
- **Impact**: 同時サインアップ時にテナント作成とユーザー作成の一貫性の問題。
- **Recommended action**: Step 5b にトランザクション分岐の具体的疑似コードを追加。

### F-3 [Minor] Step 3c の型キャスト欠落
- **Problem**: `params.profile` に `as Record<string, unknown> | null` キャストが疑似コードで省略。
- **Impact**: TypeScript エラー。
- **Recommended action**: キャストを追加。

## Security Findings

### S-1 [Major] (= F-1 と同根) `withBypassRls` のネスト問題
- 機能レビューの F-1 と統合。

### S-2 [Major] (= F-2 と同根) テナント作成とユーザー作成のアトミシティ
- 機能レビューの F-2 と統合。

### S-3 [Minor] `tenantClaimStorage` のクリア
- **Problem**: 使い終わった後にストアの `tenantClaim` がリセットされない。
- **Impact**: 現状は実害なし。将来の変更時にリスク。
- **Recommended action**: コメントで使用スコープを明記。

## Testing Findings

### T-1 [Major] (= F-1 と同根) RLS コンテキスト整合性
- 機能レビューの F-1 と統合。

### T-2 [Major] トランザクション内分岐のテスト網羅性不足
- **Problem**: SSO テナントパスで `tenant.create` が呼ばれないこと、`user.create` の `tenantId`、`tenantMember.create` の `role` の検証が Step 6b に明示されていない。
- **Recommended action**: Step 6b に具体的アサーションを追加。

### T-3 [Major] `findOrCreateSsoTenant` が null 返却時の `createUser` フォールバックテスト欠如
- **Problem**: claim があるが slug 化できない場合のフォールバック動作テストが計画にない。
- **Recommended action**: Step 6b に追加。

### T-4 [Minor] signIn テストの `tenantClaimStorage` 検証戦略未記載
- **Problem**: テスト内で ALS ストアへの書き込みを検証する方法が不明確。
- **Recommended action**: `tenantClaimStorage.run()` でラップして検証する戦略を Step 6a に追記。
