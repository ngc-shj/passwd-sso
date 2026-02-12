# 3-7 パスキー / WebAuthn — Plan

## Scope
- 対象: Personal + Org
- WebAuthn によるパスキー認証

## MVP Requirements
- パスキー登録
- パスキーでログイン
- 複数パスキー管理

## Implementation Plan
1. API
- POST /api/webauthn/register (options)
- POST /api/webauthn/verify (attestation)
- POST /api/webauthn/login (options)
- POST /api/webauthn/verify-login (assertion)

2. データモデル
- WebAuthnCredential テーブル
  - id, userId, credentialId, publicKey, counter
  - transports, createdAt

3. UI/UX
- セキュリティ設定にパスキー管理
- 登録/削除/名前変更

4. セキュリティ
- RP ID, origin チェック
- フィッシング対策

5. Tests
- 登録/ログインのフロー
- Reuse/Replay 防止

## Detailed Scope (MVP)
### Libraries
- @simplewebauthn/server
- @simplewebauthn/browser

### Validation
- origin, rpId, challenge, user verification

## Open Questions
- 既存Auth.jsとの統合方式
- パスワード/SSOとの併用ルール
