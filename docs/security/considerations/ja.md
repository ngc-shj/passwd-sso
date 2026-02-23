# セキュリティ考慮事項

本ドキュメントは `passwd-sso`（Web アプリ + ブラウザ拡張）の実運用で重要なセキュリティ観点をまとめたものです。

## 1. 脅威モデル（概要）

- 個人保管庫はクライアント側 E2E 暗号化。サーバーは暗号文のみ保持。
- 組織保管庫は E2E（クライアント側）暗号化。組織鍵配布は ECDH-P256 のメンバー鍵交換で行う。
- ブラウザ拡張は利便性機能であり、保管庫の安全性を下げない設計が前提。

## 1.1 構成図（AA）

```text
┌──────────────────────────────────────────────┐
│                Browser / Extension           │
│  - Web App (Next.js UI)                      │
│  - MV3 Extension (Popup/Background/Content)  │
│  - Web Crypto (E2E encrypt/decrypt)          │
└───────────────┬──────────────────────────────┘
                │ HTTPS (Auth/API)
                ▼
┌──────────────────────────────────────────────┐
│              Next.js App Server              │
│  - Auth.js session                           │
│  - API routes                                │
│  - Share links / sends server-side crypto    │
└───────────┬───────────────────┬──────────────┘
            │ TLS               │ TLS
            ▼                   ▼
     ┌──────────────┐     ┌──────────────┐
     │ PostgreSQL   │     │ Redis        │
     │ (ciphertext) │     │ rate limit   │
     └──────────────┘     └──────────────┘
            │
            │ TLS (optional)
            ▼
     ┌──────────────┐
     │ Blob Storage │
     │ attachments  │
     └──────────────┘
```

## 1.2 通信フロー（要点）

```text
[Sign-in]
Browser -> Auth Provider/NextAuth -> session established

[Personal Vault Write]
Browser(WebCrypto) encrypts -> API -> DB stores ciphertext

[Personal Vault Read]
API returns ciphertext -> Browser(WebCrypto) decrypts in-memory

[Extension Fill]
Popup/Content -> Background -> API(ciphertext) -> decrypt in extension runtime
-> fill to target form (user action required)
```

## 1.3 暗号パラメータ（実装値）

### 個人保管庫（Web Crypto API / `src/lib/crypto-client.ts`）

#### 鍵導出フロー（パスフレーズ起点）

```text
passphrase
  + accountSalt(32 bytes)
    └─ PBKDF2-HMAC-SHA-256 (600,000)
       └─ wrappingKey (AES-256-GCM)
          ├─ unwrap encryptedSecretKey -> secretKey(32 bytes)
          └─ (setup時) wrap secretKey

secretKey
  ├─ HKDF-SHA-256(info="passwd-sso-enc-v1")
  │   └─ encryptionKey (AES-256-GCM)  // エントリ暗号化/復号
  └─ HKDF-SHA-256(info="passwd-sso-auth-v1")
      └─ authKey (HMAC-SHA-256)
          └─ SHA-256(raw authKey) = authHash  // サーバー検証用
```

#### unlock 時の検証フロー（要点）

```text
Client:
  passphrase -> wrappingKey -> secretKey
  secretKey -> authKey -> authHash
  POST /api/vault/unlock { authHash }

Server:
  serverHash == SHA-256(authHash + serverSalt) ? valid : invalid

Client(valid時):
  secretKey -> encryptionKey
  verificationArtifact を decrypt できることを確認
```

- KDF（ラッピング鍵）: `PBKDF2-HMAC-SHA-256`
- 反復回数: `600,000`
- ラッピング鍵用途: `AES-256-GCM`（`encrypt/decrypt`）
- `secretKey`: ランダム `32 bytes`（256-bit）
- `accountSalt`: ランダム `32 bytes`（256-bit）
- `secretKey` ラップ時 IV: `12 bytes`（96-bit）
- AES-GCM 認証タグ: `16 bytes`（128-bit）
- HKDF（暗号鍵導出）:
  - hash: `SHA-256`
  - salt: 32-byte ゼロバッファ
  - info: `passwd-sso-enc-v1`
  - 出力鍵: `AES-256-GCM`
- HKDF（認証鍵導出）:
  - hash: `SHA-256`
  - salt: 32-byte ゼロバッファ
  - info: `passwd-sso-auth-v1`
  - 出力鍵: `HMAC-SHA-256`（256-bit）
- 検証アーティファクト平文: `passwd-sso-vault-verification-v1`
- すべての主要 `CryptoKey` は非抽出（`extractable: false`）を基本

#### AAD（Additional Authenticated Data）

- AES-GCM の `additionalData` に **AAD** を設定し、暗号文を文脈へバインドする
- 実装: `src/lib/crypto-aad.ts`
- スコープ:
  - `PV`（Personal Vault）: `userId`, `entryId`
  - `OV`（Org Vault）: `orgId`, `entryId`, `vaultType(blob|overview)`
  - `AT`（Attachment）: `entryId`, `attachmentId`
- 形式:
  - 2-byte scope + 1-byte `aadVersion` + 1-byte field count + length-prefixed UTF-8 fields
- 目的:
  - エントリ間/ユーザー間の暗号文すり替え（transplant/replay）を防止

### パスフレーズ検証器（Verifier）

- バージョン: `VERIFIER_VERSION = 1`
- `PBKDF2-HMAC-SHA-256` / `600,000` 回 / `256-bit` 出力
- ドメイン分離 prefix: `verifier`
- DB 保存時は `hmacVerifier(verifierHash)` を格納
  - HMAC: `SHA-256`
  - 鍵: `VERIFIER_PEPPER_KEY`（本番必須、64 hex）
  - 非本番のみ `ORG_MASTER_KEY` から導出フォールバック

### 共有リンク / Send（Server Crypto / `src/lib/crypto-server.ts`）

- アルゴリズム: `aes-256-gcm`（Node `crypto`）
- `ORG_MASTER_KEY`: 64 hex（256-bit）
- IV: `12 bytes`、AuthTag: `16 bytes`
- サーバー暗号化される共有リンク / Send の暗号化に利用

### エクスポート暗号化（`src/lib/export-crypto.ts`）

- cipher: `AES-256-GCM`
- kdf: `PBKDF2-HMAC-SHA256`
- iterations: `600,000`

## 1.4 認証/拡張トークンパラメータ（実装値）

### Vault unlock 検証（サーバー側）

- クライアントは `authHash`（`SHA-256(raw authKey)`）を送信
- サーバー保存値: `serverHash = SHA-256(authHash + serverSalt)`
- unlock 時は同式で再計算して比較
- unlock レート制限: 5分あたり 5 回（`/api/vault/unlock`）

- 拡張トークン TTL: `15分`（`EXTENSION_TOKEN_TTL_MS`）
- 拡張トークン refresh バッファ: `2分前`（拡張 background）
- 既定スコープ:
  - `passwords:read`
  - `vault:unlock-data`
- 同時アクティブトークン上限: `3`（超過時は古いものを失効）
- 発行/refresh レート制限:
  - issue: 15分あたり 10 回
  - refresh: 15分あたり 20 回

## 1.5 保持場所とライフタイム（現行実装）

- Web アプリ:
  - Vault 復号鍵はランタイムメモリ中心で扱う
  - 自動ロック: 非操作 15 分 / 非表示 5 分
- ブラウザ拡張:
  - token は `chrome.storage.session` に保持（ブラウザ終了でクリア）
  - vault 復号再導出用の `vaultSecretKey` も `chrome.storage.session` で保持
  - `autoLockMinutes` により vault ロックタイマー制御（既定 15 分）

## 2. 基本コントロール

- 本番は常に HTTPS を使用する。
- `AUTH_SECRET` / `ORG_MASTER_KEY` はシークレットマネージャで管理（Git 管理禁止）。
- DB / Redis / Blob は TLS 接続を強制する。
- 本番は `REDIS_URL` を有効化し、アンロック試行制限を維持する。
- CSP は有効のまま運用し、`unsafe-*` 緩和を安易に追加しない。

## 3. 認証・セッション

- Auth.js の DB セッションを利用（ブラウザ localStorage に JWT セッションを置かない）。
- セッション有効期間と失効手順を運用で明確化する。
- `GOOGLE_WORKSPACE_DOMAIN` や IdP 側ポリシーでサインイン対象を制限する。

## 4. Vault と鍵の取り扱い

- 個人保管庫の復号鍵はアンロック中のランタイムメモリのみに置く。
- 自動ロック設定はセキュリティ設定として扱い、無効化を常態化しない。
- クリップボードコピーは短時間でクリアする（実装は 30 秒）。

## 5. ブラウザ拡張の注意点

- 自動補完より手動補完を基本にする（無操作補完を避ける）。
- passwd-sso 同一オリジンではインライン候補を抑止し、誤操作/ノイズを回避する。
- host permissions は最小権限を維持する。
- 拡張トークンは短命・最小スコープ運用にする。
- 復号素材（vault key 相当）の永続化は慎重に扱う。

## 6. デプロイ時チェックリスト

- 本番環境変数がすべて設定済みである。
- `prisma migrate deploy` を本番反映前に実行している。
- DB / Jackson の内部エンドポイントを外部公開していない。
- セキュリティヘッダー / CSP レポートが有効である。
- 秘密情報のローテーション手順が定義されている。

## 7. 脆弱性報告

報告手順は `SECURITY.md` を参照してください。

## 8. PQC（耐量子計算機）準備

現時点の主経路（PBKDF2/HKDF/AES-GCM）は対称鍵系が中心であり、  
「今すぐ破綻」ではありません。一方で、長期的には以下の準備が必要です。

### 8.1 設計原則

- `crypto agility`（アルゴリズム差し替え容易性）を維持する
- 暗号データには `version` を必ず持たせる（段階移行を可能にする）
- 旧版と新版を並行運用できる移行期間を前提にする

### 8.2 実装レベルでの準備項目

- ラップ/鍵交換系に `wrapVersion` を維持し、v2 以降を追加可能にする
- `src/lib/crypto-emergency.ts` のコメントどおり、将来の
  `HYBRID-ECDH-P256-MLKEM768` への移行経路を確保する
- API と DB スキーマは「鍵素材」「salt」「version」を後方互換で拡張できる形に保つ
- 暗号パラメータは定数集中管理し、ランダム分散実装を避ける

### 8.3 運用レベルの準備項目

- NIST 標準化の更新を定期レビューする（ML-KEM / ML-DSA）
- ライブラリ更新ポリシーを定義し、暗号依存を長期間固定しない
- 「新規作成データは新方式、既存データは読める限り旧方式」の移行手順を文書化する

### 8.4 このプロダクトでの現実的な優先順

1. 鍵交換・共有系（緊急アクセスなど）を先にハイブリッド化  
2. データ暗号本体（AES-GCM）は対称鍵として継続しつつ鍵管理を強化  
3. 署名/認証まわりは依存基盤（Auth/IdP）のPQC対応状況に合わせて段階導入

## 9. Assumptions / Non-Goals

### Assumptions（前提）

- HTTPS/TLS が有効であること
- ブラウザ実行環境が改ざんされていないこと
- サーバー秘密情報（`AUTH_SECRET` / `ORG_MASTER_KEY` など）が適切に保護されること

### Non-Goals（非目標）

- 端末マルウェア感染時の情報窃取防止
- XSS が成立した同一オリジン実行コンテキスト内での完全防御
- スクリーンキャプチャやキーロガーに対する完全防御

## 10. Key Lifecycle（鍵ライフサイクル）

- 生成:
  - 個人: `secretKey` / `accountSalt` をクライアントで生成
  - 組織: クライアント側 org key を ECDH-P256 でメンバー配布
- 保存:
  - 個人: `secretKey` は `wrappingKey` でラップして保存
  - 組織: メンバーごとのラップ済み org key を `OrgMemberKey` に保存
- 利用:
  - unlock 後に復号鍵をランタイムへ展開
- ローテーション:
  - `keyVersion` 付きで段階移行
- 破棄/失効:
  - lock / logout / expiry で鍵素材を破棄
  - 拡張トークンは revoke + TTL で失効

## 11. Extension Trust Boundary

- `popup`: ユーザー操作/UI 表示
- `background (SW)`: token 管理、API 通信、復号処理オーケストレーション
- `content script`: ページDOMとの橋渡し（最小権限）
- 境界ルール:
  - content script に秘密情報を恒久保持しない
  - site origin と extension origin の責務を分離
  - 同一 `serverUrl` origin ではインライン候補抑止

## 12. Incident Response Runbook（最小手順）

### 12.1 拡張トークン漏えい疑い

1. `DELETE /api/extension/token` で即時失効  
2. セッション無効化（必要に応じて全端末ログアウト）  
3. 監査ログ確認（発行元IP・時刻・操作履歴）

### 12.2 サーバー秘密情報漏えい疑い

1. `AUTH_SECRET` / `ORG_MASTER_KEY` / `VERIFIER_PEPPER_KEY` をローテーション  
2. 影響範囲（共有リンク/Send の復号可否、セッション）を評価  
3. 必要時は鍵再発行・ユーザー再認証を実施

### 12.3 DB 漏えい疑い

1. 露出経路を遮断しフォレンジック保全  
2. トークン/セッションを失効  
3. パスフレーズ変更・鍵ローテーションのガイダンスを案内

## 13. Security Test Matrix（実装とリスクの対応）

- AAD 改ざん・すり替え: 復号失敗を確認
- Vault unlock:
  - 正常 passphrase で unlock 成功
  - 誤 passphrase で失敗 + rate limit 動作
- Extension token:
  - TTL 失効
  - refresh 成功/失敗
  - revoke 後アクセス拒否
- CSP:
  - 違反レポート到達
  - `unsafe-*` を導入しないことを確認
- 拡張機能:
  - 同一 origin で inline suppress
  - 手動補完フローのみで埋め込み動作

## 14. ストレージ保持項目と許容理由（現行実装）

### 14.1 Web アプリ側

- `memory`:
  - `encryptionKey`（`CryptoKey`）
  - `secretKeyRef`（`Uint8Array`）
  - 理由: 復号鍵を永続ストレージへ置かないため（攻撃面を最小化）
- `sessionStorage`:
  - `psso:skip-beforeunload-once`（一時フラグ）
  - 理由: 「拡張接続後にタブを閉じる」等の UX 制御のみ。秘密情報を含まない
- `localStorage`:
  - Watchtower の表示設定/最終確認時刻等の UI 補助情報
  - 理由: 利便性向上。秘密情報は保存しない

### 14.2 ブラウザ拡張側

- `chrome.storage.local`:
  - `serverUrl`, `autoLockMinutes`
  - 理由: 設定値の永続化が必要。秘密情報ではない
- `chrome.storage.session`:
  - `token`, `expiresAt`, `userId`, `vaultSecretKey`（再導出用）
  - 理由:
    - MV3 Service Worker 再起動で状態が消えるため、運用可能な UX を維持
    - ブラウザ終了時にクリアされるスコープで限定
    - token は短命（15分）+ refresh + revoke で被害時間を抑制
    - `vaultSecretKey` は利便性とセキュリティのトレードオフとして採用
- `background memory`:
  - `encryptionKey`, `currentToken` など
  - 理由: 実処理時に必要。lock/expiry 時にクリア

### 14.3 明示的に保存しないもの

- パスフレーズ平文
- 復号後のエントリ平文
- `AUTH_SECRET` / `ORG_MASTER_KEY` 等のサーバー秘密

### 14.4 設計判断メモ（なぜ許容するか）

- 原則は「秘密はメモリ中心」。ただし拡張 MV3 の SW 再起動特性により、  
  完全メモリのみだと再ログイン/再アンロック頻度が過大となる
- そのため、拡張では `chrome.storage.session` を限定採用し、  
  TTL・scope・revoke・auto-lock でリスクを制御する
- ここは実装方針として将来再評価対象（ポリシー変更時は優先して見直す）

## 15. 鍵の共有機能（Emergency Access）

### 15.1 共有対象と非対象

- 共有対象: owner の `secretKey`（復号可能にするための鍵素材）
- 非対象: パスフレーズ平文、恒久 private key の平文保存

### 15.2 鍵交換・ラップ方式（現行）

- 実装: `src/lib/crypto-emergency.ts`
- 方式: `wrapVersion=1`（`ECDH-P256`）
- フロー:
  1. grantee が ECDH 鍵ペアを生成
  2. grantee private key は grantee 自身の `encryptionKey` で暗号化保存
  3. owner が ephemeral ECDH 鍵ペアを生成
  4. `ECDH(ownerEphemeralPriv, granteePub)` から共有秘密を導出
  5. HKDF(`SHA-256`, random 32-byte salt, info=`passwd-sso-emergency-v1`)
  6. 共有 AES-256-GCM 鍵で owner `secretKey` をラップ

### 15.3 AAD バインディング

- AAD は固定順の `grantId|ownerId|granteeId|keyVersion|wrapVersion`
- JSON ではなく固定順連結でバイト列を決定（順序差異リスク回避）
- 目的: grant 間の ciphertext transplant/replay 防止

### 15.4 DB に保持される主データ

- `ownerEphemeralPublicKey`
- `encryptedSecretKey`, `secretKeyIv`, `secretKeyAuthTag`
- `hkdfSalt`
- `wrapVersion`, `keyVersion`

### 15.5 失効・ローテーション

- grant の状態遷移（申請/承認/失効）で利用可否を制御
- `keyVersion` により鍵ローテーション後の整合性を担保
- 将来の `wrapVersion=2`（PQC ハイブリッド）へ段階移行可能な設計
