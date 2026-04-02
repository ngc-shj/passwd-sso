# Plan Review: improve-i18n-security-terminology
Date: 2026-04-02
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F-1 [Minor] `subTabBreakglass` missing from Break Glass spelling normalization (Step 4)
- **Problem**: `AuditLog.json` の `subTabBreakglass` キーの値が `Break-Glass` のまま残り、他の変更後も古い表記が混在する。
- **Impact**: UI タブラベルで `Break Glass` と `Break-Glass` が混在。
- **Recommended action**: Step 4 テーブルに `AuditLog.json` `subTabBreakglass` を追加。

### F-2 [Minor] WebAuthn Credential ID exclusion not documented (Step 2)
- **Problem**: Step 2 で `クレデンシャル` → `認証情報` の統一対象に WebAuthn `credentialId` が含まれていない。これは技術固有名詞のため変更不要だが、除外理由が明記されていない。
- **Impact**: 実装者が意図を誤解して変更するリスク。
- **Recommended action**: Step 2 に除外理由を追記。

## Security Findings

### S-1 [Minor] `無効化` and `取り消し` coexistence on SA management screen
- **Problem**: SA 管理画面で `無効化`(deactivate, 可逆) と `取り消し`(revoke, 不可逆) が共存し、ユーザーが混同する可能性。
- **Impact**: 誤って SA を削除（不可逆）するリスク。可用性への影響。
- **Recommended action**: 実装フェーズで UI 上の区別が視覚的に担保されていることを確認。プラン自体は変更不要。

## Testing Findings

No findings.

## Adjacent Findings

None.

## Quality Warnings

None.

## Resolution

All findings were Minor severity. Resolved in plan update:
- F-1: Added `subTabBreakglass` to Step 4 table
- F-2: Added WebAuthn Credential ID exclusion note to Step 2
- S-1: Recorded as implementation-phase UI check (no plan change needed — existing UI already separates deactivate/delete as distinct actions with separate confirmation dialogs)
