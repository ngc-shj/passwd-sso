# 2-6 パスワード保護エクスポート — Plan

## Scope
- 対象: Personal + Org の両方
- 既存の CSV/JSON エクスポートに暗号化オプションを追加

## MVP Requirements
- エクスポート時にパスワードを指定
- 生成物は暗号化されたファイル
- 復号は別ツール/インポート時に可能
- 失効/期限は設けない（MVP）

## Implementation Plan
1. 暗号化方式
- AES-256-GCM
- パスワードから鍵導出: PBKDF2 (>= 600k)
- salt/iv/authTag をヘッダーに含める

2. データフォーマット
- JSON 形式を暗号化（CSVはJSONに変換して暗号化）
- メタ情報: version, createdAt, cipher, kdf, salt, iv, authTag

3. API
- POST /api/passwords/export (body: format, encrypted, exportPassword)
- POST /api/orgs/{orgId}/passwords/export
- (Option) client-side export to avoid server seeing plaintext

4. UI/UX
- Export ダイアログに「パスワード保護」トグル
- パスワード入力（confirm）
- 注意文: 忘れると復号不可

5. Tests
- 暗号化/復号ユニットテスト
- API 経由のエクスポート検証

## Detailed Scope (MVP)
### Encryption Details
- KDF: PBKDF2-HMAC-SHA256
- iterations: 600,000
- salt: 16 bytes (random)
- iv: 12 bytes
- authTag: 16 bytes
- key length: 32 bytes

### File Structure (JSON)
```
{
  "version": 1,
  "createdAt": "ISO-8601",
  "cipher": "AES-256-GCM",
  "kdf": {
    "name": "PBKDF2-HMAC-SHA256",
    "iterations": 600000,
    "salt": "<hex>"
  },
  "iv": "<hex>",
  "authTag": "<hex>",
  "ciphertext": "<hex>"
}
```

### Validation
- exportPassword: required when encrypted=true, min 8
- format: csv | json

### API Endpoints (Proposed)
- Personal
  - POST /api/passwords/export
- Org
  - POST /api/orgs/{orgId}/passwords/export

### API Field Checks (Proposed)
- format: required, enum
- encrypted: optional boolean
- exportPassword: required if encrypted=true, min 8

## Open Questions
- 暗号化を client-side にするか server-side にするか
- 既存のエクスポートCSV/JSONとの互換性
- インポート側の復号実装タイミング
