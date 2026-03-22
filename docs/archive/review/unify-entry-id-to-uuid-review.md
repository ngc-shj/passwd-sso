# Plan Review: unify-entry-id-to-uuid
Date: 2026-03-21
Review round: 2

## Changes from Previous Round
- Step 3: `createTeamE2ESchema.id` と `createTeamE2EPasswordSchema.id` を required に変更
- Step 4: team attachment route の二重 UUID regex を簡素化、`.toLowerCase()` 追加
- Step 7: `validations.test.ts` の更新を追加
- Requirements: TeamPasswordEntry の aadVersion >= 1 制約を明記

## Round 1 Findings (resolved)

| ID | Severity | Status | Summary |
|---|---|---|---|
| F1 | Major | Resolved | `createTeamE2ESchema.id` optional → required |
| F2 | Major | Resolved | attachment clientId 検証を Step 6 に追加 |
| F3 | Minor | Resolved | Requirements に TeamPasswordEntry 制約を明記 |
| S1 | Minor | Resolved | `.toLowerCase()` 正規化を Step 4 に追加 |
| S2 | Minor | Out of scope | share.ts passwordEntryId — 将来改善 |
| T1 | Major | Resolved | rotate-key UUID v4 fixture を Step 7 に追加 |
| T2 | Major | Resolved | bulk ops UUID v4 fixture を Step 7 に追加 |
| T3 | Minor | Resolved | Migration SQL チェックリストを Step 2 に追加 |
| T4 | Minor | Resolved | team-password-service fixture を Step 7 に追加 |

## Round 2 Findings

### Functionality Findings

#### F3-R2 (Minor → Resolved): `createTeamE2EPasswordSchema.id` も必須化が必要
- **Problem**: Step 3 が `createTeamE2ESchema` のみ対象で `createTeamE2EPasswordSchema` が漏れていた
- **Resolution**: Step 3 のスコープに追加済み

#### F4-R2 (Minor → Out of scope): attachment route の aadVersion デフォルト非対称
- **Problem**: 個人用 aadVersion デフォルト=0、チーム用=1
- **Decision**: 既存設計の問題。本タスクのスコープ外として記録

### Security Findings

#### S4-R2 (Minor → Resolved): team attachment route の二重 UUID regex
- **Problem**: 厳格 UUID v4 regex + 緩い UUID_RE の二重チェックが保守性リスク
- **Resolution**: Step 4 で簡素化（検証済み clientId を直接使用）

### Testing Findings

#### N1-R2 (Major → Resolved): validations.test.ts の更新が Step 7 に欠落
- **Problem**: `createTeamE2ESchema.id` を required にすると既存テストの `valid` オブジェクトに `id` がなく失敗する
- **Resolution**: Step 7 に validations.test.ts の更新を追加

## Adjacent Findings
なし
