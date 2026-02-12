# Browser Extension (Chrome/Edge) — Plan

## Scope
- Chrome/Edge (Manifest V3)
- MVP: URLに基づくID/PASSWORDの手動補完

## Security-First Decisions
- 自動補完は禁止（ユーザー操作必須）
- iframe 内の補完はデフォルト無効
- eTLD+1 または完全一致でマッチ
- 表示時にホスト名を明示
- クリップボードへの自動コピー禁止（明示操作のみ）
- 認証は **拡張専用 API トークン（短命・スコープ限定）** を使用
- Vault 鍵は **メモリのみ保持**（永続ストレージに保存しない）

## MVP Requirements
- 拡張内でログイン（Auth.js/SSO → **短命トークン発行**）
- Vault 解除（短時間のみメモリ保持）
- 現在URLにマッチする候補表示
- クリックでID/PASSWORD入力
- パスワード生成は後回し

## Extension Architecture
- Service Worker (background)
- Content Script (入力フィールド検出/注入)
- Extension UI (popup)
- Optional: offscreen document for crypto
- Token Broker (web app) — 拡張向け短命トークン発行

## Auth Flow
1. Popup からログインを開始
2. 既存 Web の Auth.js/SSO へリダイレクト
3. Web アプリ側で **拡張用短命トークン** を発行
4. 拡張は token を **memory only** で保持

## Vault Flow
- Popup でマスターパスフレーズ入力
- 鍵をメモリに保持（TTL 5〜15分）
- 解除中のみ補完可能

## URL Matching
- default: eTLD+1 match
- exact match option
- login URL のパス優先（将来）

## API Integration
- 既存 API を使用
  - GET /api/passwords (list)
  - GET /api/passwords/{id}
- Org 対応は後で追加

## UI/UX
- ポップアップで候補一覧
- ショートカット: Cmd/Ctrl+Shift+L で補完
- フィールドは username/password を自動検出

## Data Handling
- パスワードは暗号化状態で取得
- 復号は extension 内で実行
- メモリからの即時破棄
- **token / key は永続保存しない**

## Tests
- URL マッチ
- フィールド検出
- Vault TTL

## Open Questions
- Token Broker の仕様（発行/失効/スコープ）
- offscreen document での WebCrypto 実装方針
- Org + personal の切替

## Competitive References (Browser Extension)
### 1Password (Browser Security)
- 拡張はブラウザのサンドボックス環境で動作し、Web ページ側から直接アクセスできない設計
- Popup はページ外で動作し、インライン UI は拡張内リソースの iframe で提供（同一生成元で保護）
- 拡張内コンポーネント間は messaging API で通信（DOM 経由の盗聴・改ざん回避）
- CSP を厳格化して外部リソース読み込みを制限

### Bitwarden (Autofill Behavior)
- Autofill は「拡張 UI からの手動 Fill」「クリックで Fill」「コンテキストメニュー」「キーボードショートカット」など複数手段
- untrusted iframe への autofill は警告/制限される
- HTTP サイトで HTTPS に紐づく資格情報を autofill する場合は警告が出る
- inline autofill menu を提供（フォームフィールド上の候補表示）

---

# Implementation Design (Security-first)

この節は **実装可能なレベル**まで落とし込んだ設計です。既存コードの現状（API/暗号/認証）を踏まえています。

## 0. 現行コードからの前提
- 認証は Auth.js（NextAuth）セッションで保護される API が中心。
- Personal Vault のデータ取得:
  - `GET /api/passwords`（一覧、暗号化 overview）
  - `GET /api/passwords/{id}`（暗号化 blob）
- Vault unlock 情報:
  - `GET /api/vault/unlock/data`（accountSalt / encryptedSecretKey など）
  - `POST /api/vault/unlock`（検証用）
- クライアント側で復号（`crypto-client.ts` / `vault-context.tsx`）し、
  **secretKey をメモリのみ保持**している（ロック時に zeroize）。

## 1. Extension Architecture (MV3)
- **Service Worker (background)**:
  - token の保持（memory only）
  - API proxy（/api/passwords, /api/vault/unlock/data）
  - TTL 管理 & zeroize
- **Popup UI**:
  - ログイン/トークン取得
  - Vault Unlock（パスフレーズ入力）
  - マッチ候補一覧・手動 Fill
- **Content Script**:
  - フィールド検出・注入（手動操作のみ）
  - iframe は default 無効
- **Offscreen Document (optional)**:
  - WebCrypto を隔離する場合の選択肢

## 2. Auth / Token Broker (New)
### 要件
- Cookie を拡張に保存しない（漏洩リスク回避）
- **短命トークン（例: 5〜15分）** + **スコープ限定**
- トークン失効を即時に行える

### 追加API案（サーバ側）
- `POST /api/extension/token`  
  - Auth.js セッション必須（Web 側でログイン後に発行）
  - scope 例: `passwords:read`, `vault:unlock-data`
  - exp 例: 10分
- `DELETE /api/extension/token`  
  - 失効（ログアウト/TTL切れ前の手動無効化）

### トークンの扱い
- 拡張は **memory only** で保持
- `chrome.storage` には保存しない
- 失効時は `401` を受けて再ログインへ

## 3. Vault Unlock (Extension)
### フロー
1. `GET /api/vault/unlock/data` で `accountSalt`, `encryptedSecretKey` 取得
2. Popup でパスフレーズ入力
3. `crypto-client.ts` 相当の処理を拡張内で実行（WebCrypto）
4. secretKey を memory に保持（TTL 5〜15分）
5. Fill 操作時のみ復号処理を実行

### Security
- secretKey は **memory only**
- TTL で強制 zeroize
- popup close / inactivity で zeroize

## 4. URL Matching / Fill
### URL Matching
- default: eTLD+1 match
- exact match option（設定で切替）
- login URL のパス優先（将来）

### Fill
- 手動操作のみ（自動補完禁止）
- Field detection: username / password / otp を推定
- iframe は default 無効（オプションで許可）

## 5. API Access Patterns
### MVP
- `GET /api/passwords` (overview)
- `GET /api/passwords/{id}` (blob)
- これらに **extension token** を適用

### 将来
- Org Vault 対応
- 添付/共有/監査ログ

## 6. Security Hardening Checklist
- CSP / Trusted Types
- Content script の DOM API 最小化
- メモリ保持のみ (token / secretKey)
- クリップボード自動コピー禁止
- HTTP/HTTPS ミスマッチ警告
- iframe フィルター (default 無効)

## 7. Test Plan
- URL match (eTLD+1 / exact)
- Field detection (username / password)
- Vault TTL zeroize
- Token expiry handling
- 非許可 iframe では補完不可

## 8. TODO (Implementation)
1. `extension-token` API をサーバ側に追加
2. MV3 プロジェクト初期化 (manifest/popup/background/content)
3. Vault unlock + decrypt 実装
4. URL match + Fill UI
5. セキュリティ hardening
