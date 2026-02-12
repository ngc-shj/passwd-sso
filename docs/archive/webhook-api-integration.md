# 3-5 Webhook / API 連携 — Plan

## Scope
- 対象: Org
- 外部システム連携向けにイベント通知

## MVP Requirements
- Webhook の登録/編集/削除
- 署名付きWebhook送信
- リトライ/失敗管理

## Implementation Plan
1. データモデル
- WebhookEndpoint テーブル
  - id, orgId, url, secret, events[], isActive
  - createdAt, updatedAt
- WebhookDelivery テーブル
  - id, webhookId, status, attempts, lastError
  - payload, deliveredAt

2. API
- POST /api/orgs/{orgId}/webhooks
- GET /api/orgs/{orgId}/webhooks
- PUT /api/orgs/{orgId}/webhooks/{id}
- DELETE /api/orgs/{orgId}/webhooks/{id}

3. Event Types
- entry.created
- entry.updated
- entry.deleted
- sharelink.created
- sharelink.revoked
- member.invited
- member.role_updated

4. Delivery
- 署名: HMAC-SHA256 (secret)
- ヘッダ: X-Passwd-Signature, X-Passwd-Timestamp
- リトライ: exponential backoff (max 5)

5. UI/UX
- 組織設定にWebhook管理画面
- テスト送信ボタン
- 失敗履歴の表示

6. Tests
- Webhook署名
- 配送/リトライ
- 権限

## Detailed Scope (MVP)
### Payload
```
{
  "id": "evt_xxx",
  "type": "entry.created",
  "orgId": "org_xxx",
  "createdAt": "ISO-8601",
  "data": { ... }
}
```

### Validation
- url: required, https only
- events: required, non-empty
- secret: auto-generated

### API Field Checks (Proposed)
- url: required, https
- events: array enum
- isActive: boolean

## Open Questions
- delivery queue (db vs background worker)
- rate limit / burst
- retry policy
