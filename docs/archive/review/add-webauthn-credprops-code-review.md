# Code Review: add-webauthn-credprops
Date: 2026-03-16
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 (Major) — RESOLVED
- **File:** src/components/settings/passkey-credentials-card.tsx:282
- **Problem:** hasPrf判定がcred属性ベースで、実際のPRF出力を確認していない
- **Fix:** `startPasskeyAuthentication`の`prfOutput`を使って判定

### F2 (Major) — SKIPPED
- **Problem:** req.json()の空ボディ対応
- **Reason:** try/catchで意図的にフォールバック、コメント記載済み

### F3 (Minor) — RESOLVED
- **File:** src/components/settings/passkey-credentials-card.tsx:147
- **Problem:** prfOutput.fill(0)後の参照が読みにくい
- **Fix:** fill(0)前に`hadPrf`フラグを保存

### F4 (Minor) — RESOLVED
- **File:** src/components/settings/passkey-credentials-card.tsx:230
- **Problem:** handleRenameの引数名`credentialId`がDB UUIDを指しており、WebAuthn credentialIdと混同
- **Fix:** 引数名を`id`に変更

## Security Findings

### S1 (Minor) — SKIPPED
- **Problem:** チャレンジキー上書き
- **Reason:** 同一ユーザーの連続操作で影響は最小限

### S2 (Minor) — RESOLVED
- **File:** src/app/api/webauthn/authenticate/options/route.ts:54
- **Problem:** credentialIdの長さバリデーションなし
- **Fix:** `body.credentialId.length <= 256` チェック追加

### S3 (Minor) — SKIPPED
- **Problem:** DBコメントで用途明記
- **Reason:** コード内コメント（route.ts:127-128）で十分に明記済み

## Testing Findings

### T1 (Critical) — RESOLVED
- **Problem:** authenticate/options のテストなし
- **Fix:** route.test.ts新規作成（7テスト: credentialIdターゲティング4ケース + 認証/エラー3ケース）

### T2 (Critical) — RESOLVED
- **Problem:** isNonDiscoverable のテストなし
- **Fix:** is-non-discoverable.test.ts新規作成（6テスト: discoverable true/false/null × deviceType/backedUp組み合わせ）

### T3 (Major) — SKIPPED
- **Problem:** rk:null と credProps absent の意図不明
- **Reason:** 両ケースとも仕様上 `null` が正しい（typeof null !== "boolean"）

### T4 (Minor) — RESOLVED
- **File:** src/app/api/webauthn/register/verify/route.test.ts
- **Problem:** audit log discoverable=false ケース欠落
- **Fix:** テストケース追加

## Adjacent Findings
None.

## Resolution Status
All Critical/Major findings resolved. Minor findings resolved or skipped with documented reasons.
