# 3-6 SCIM プロビジョニング — Plan

## Scope
- 対象: Org
- IdP 連携によるユーザー/グループの自動プロビジョニング

## MVP Requirements
- SCIM 2.0 互換エンドポイント
- User create/update/deactivate
- Group create/update/delete
- IdP からの同期

## Implementation Plan
1. SCIM API
- GET /scim/v2/ServiceProviderConfig
- GET /scim/v2/ResourceTypes
- GET /scim/v2/Schemas
- /scim/v2/Users
- /scim/v2/Groups

2. 認証
- SCIM Token (Bearer)
- Org ごとに token 発行

3. データモデル
- SCIMToken テーブル (orgId, tokenHash, createdAt)
- SCIMMapping (externalId <-> userId/groupId)

4. UI
- 組織設定に SCIM 有効化
- トークン生成/ローテーション

5. Tests
- SCIM 互換性テスト
- create/update/deactivate

## Detailed Scope (MVP)
### Users
- userName, name, emails, active, externalId

### Groups
- displayName, members

### Validation
- SCIM schema 準拠
- orgId 必須

## Open Questions
- IdP 対応範囲 (Okta, Azure AD, Google)
- グループの role mapping
