# Code Review: webauthn-l3-minpin-largeblob
Date: 2026-03-16
Review round: 1

## Functionality Findings

### F-1 (Major) — RESOLVED
- **File:** src/app/api/webauthn/register/verify/route.ts:165
- **Problem:** `minPinLength === null` を policy violation として 400 を返すため、PIN を報告しないプラットフォーム認証器（Touch ID, Face ID, Windows Hello）がテナントポリシー設定時に一律ブロックされる
- **Fix:** 条件を `minPinLength !== null && minPinLength < requireMinPin` に変更。未報告時は許可（ベストエフォート強制）

## Security Findings
No findings.

## Testing Findings

### T-1 (Major) — RESOLVED
- **Problem:** tenant/policy 境界値テスト（4, 63）欠落
- **Fix:** `requireMinPinLength=4` と `63` の accept テストを追加

### T-2 (Minor) — RESOLVED
- **Problem:** credentials レスポンスの minPinLength/largeBlobSupported 値確認なし
- **Fix:** json[0]/json[1] のフィールド値アサーション追加

### T-3 (Minor) — RESOLVED
- **Problem:** register/verify ポリシーテスト「未報告時は 400」→ 仕様変更で 201 に
- **Fix:** テストを「allows registration when minPinLength not reported」に変更

## Resolution Status
All findings resolved in round 1. Total tests: 4801 (all pass).
