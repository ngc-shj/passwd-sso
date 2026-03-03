# 組織 Vault E2E 暗号化 (ECDH-P256)

## Context

現在の組織 Vault はサーバーサイド暗号化 (`ORG_MASTER_KEY` → per-org key → AES-256-GCM) を使用しており、サーバーが平文にアクセス可能。個人 Vault と同レベルの Zero-knowledge E2E 暗号化に移行し、サーバーは暗号化ブロブの透過保存のみ行う設計にする。

**決定事項:**
- 完全 E2E (全組織を公開鍵暗号方式に移行)
- ECDH-P256 (既存 `crypto-emergency.ts` のパターンを再利用)
- 手動鍵ローテーション (Admin が明示的に実行)
- Invite → Accept → Confirm フロー (1Password/Bitwarden と同等)

**ユーザー体験: 変化なし (公開鍵暗号を意識させない設計)**

ECDH 秘密鍵は個人 Vault の secretKey と同じ方式で管理する。ユーザーが別途鍵を保管・入力する必要は一切ない:

```
パスフレーズ入力 (既存と同じ)
  → PBKDF2 → wrapping key → secretKey 復号
    → HKDF → encryptionKey
      → encryptionKey で ECDH 秘密鍵も自動復号 (バックグラウンド)
        → org symmetric key の復号が可能に
```

- **セットアップ時**: パスフレーズ入力のみ。裏で ECDH 鍵ペアが自動生成され、encryptionKey で暗号化してサーバーに保存
- **アンロック時**: パスフレーズ入力のみ。裏で ECDH 秘密鍵が自動復号されメモリに保持
- **ロック時**: 裏で ECDH 秘密鍵がメモリからゼロクリア
- **鍵の管理**: 不要。1Password/Bitwarden と同じ方式

---

## Phase 1: 暗号基盤

### 1.1 Prisma スキーマ変更 — `prisma/schema.prisma`

**User モデルに ECDH 鍵ペアを追加:**

```prisma
ecdhPublicKey              String?  @map("ecdh_public_key") @db.Text
encryptedEcdhPrivateKey    String?  @map("encrypted_ecdh_private_key") @db.Text
ecdhPrivateKeyIv           String?  @map("ecdh_private_key_iv") @db.VarChar(24)
ecdhPrivateKeyAuthTag      String?  @map("ecdh_private_key_auth_tag") @db.VarChar(32)
```

**新規 OrgMemberKey テーブル:**

```prisma
model OrgMemberKey {
  id                 String   @id @default(cuid())
  orgId              String   @map("org_id")
  userId             String   @map("user_id")
  encryptedOrgKey    String   @map("encrypted_org_key") @db.Text
  orgKeyIv           String   @map("org_key_iv") @db.VarChar(24)
  orgKeyAuthTag      String   @map("org_key_auth_tag") @db.VarChar(32)
  ephemeralPublicKey String   @map("ephemeral_public_key") @db.Text
  hkdfSalt           String   @map("hkdf_salt") @db.VarChar(64)
  wrapVersion        Int      @default(1) @map("wrap_version")
  keyVersion         Int      @default(1) @map("key_version")
  createdAt          DateTime @default(now()) @map("created_at")
  updatedAt          DateTime @updatedAt @map("updated_at")

  org  Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  user User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([orgId, userId, keyVersion])
  @@index([userId])
  @@map("org_member_keys")
}
```

**Organization モデル変更:**

```prisma
// 既存フィールドを nullable に (移行完了後に削除)
encryptedOrgKey   String?  ...
orgKeyIv          String?  ...
orgKeyAuthTag     String?  ...

// 新規
orgKeyVersion          Int      @default(0) @map("org_key_version")
e2eEnabled             Boolean  @default(false) @map("e2e_enabled")  // 一方向: false → true のみ
migrationInProgress    Boolean  @default(false) @map("migration_in_progress")
memberKeys             OrgMemberKey[]
```

**OrgMember に鍵配布フラグ追加:**

```prisma
keyDistributed  Boolean  @default(false) @map("key_distributed")
```

**OrgPasswordEntry に orgKeyVersion 追加:**

```prisma
orgKeyVersion  Int  @default(0) @map("org_key_version")
```

**OrgPasswordEntryHistory に orgKeyVersion 追加:**

```prisma
orgKeyVersion  Int  @default(0) @map("org_key_version")
```

History restore 時: `history.orgKeyVersion !== org.orgKeyVersion` の場合、旧キーで復号 → 現キーで再暗号化してから restore。`orgKeyVersion = 0` はサーバー暗号化 (legacy) を示す。

### 1.2 crypto-org.ts — 新規 `src/lib/crypto-org.ts`

`crypto-emergency.ts` のパターンを再利用。主要関数:

| 関数 | 目的 | 再利用元 |
|------|------|---------|
| `generateOrgSymmetricKey()` | 256-bit ランダム org key 生成 | — |
| `deriveOrgEncryptionKey(orgKey)` | HKDF(org key, "passwd-sso-org-enc-v1") → AES-256-GCM | `crypto-client.ts` の HKDF パターン |
| `wrapOrgKeyForMember()` | ECDH + HKDF → org key を wrap | `wrapSecretKeyForGrantee` (crypto-emergency.ts) |
| `unwrapOrgKey()` | ECDH + HKDF → org key を unwrap | `unwrapSecretKeyAsGrantee` (crypto-emergency.ts) |
| `createOrgKeyEscrow()` | ephemeral 鍵生成 + wrap の一括処理 | `createKeyEscrow` (crypto-emergency.ts) |
| `encryptOrgEntry()` / `decryptOrgEntry()` | AES-256-GCM with AAD | `encryptData` / `decryptData` (crypto-client.ts) |

HKDF パラメータ:

- wrapping: info=`"passwd-sso-org-v1"`, salt=`SHA-256(orgId)` (S-9)
- data encryption: info=`"passwd-sso-org-enc-v1"`, salt=empty (org key 自体が org ごとに一意のため salt 不要) (S-14)
- emergency access: info=`"passwd-sso-emergency-v1"` (既存、ドメイン分離)

**AAD 設計 (OrgMemberKey wrapping):**

`crypto-aad.ts` の `buildAADBytes` と同じバイナリ長さプレフィックス形式を使用:

- スコープ: `"OK"` (Org Key)
- フィールド: `orgId | memberKeyId | fromUserId | toUserId | keyVersion | wrapVersion`
- ciphertext transplant attack を防止するため、memberKeyId を含める

**HKDF salt:**

- `wrapOrgKeyForMember()` の HKDF salt は `SHA-256(orgId)` を使用 (org 間のドメイン分離)

### 1.3 Vault Setup への ECDH 鍵ペア追加

**`src/lib/vault-context.tsx` の `setup` 関数:**
1. 既存: secretKey 生成 → wrappingKey 導出 → wrap → 検証アーティファクト作成
2. 追加: `generateECDHKeyPair()` → 公開鍵を JWK export → 秘密鍵を PKCS8 export → encryptionKey で暗号化
3. POST body に `ecdhPublicKey`, `encryptedEcdhPrivateKey`, `ecdhPrivateKeyIv`, `ecdhPrivateKeyAuthTag` を追加

**`src/app/api/vault/setup/route.ts`:** setupSchema に 4 フィールド追加、User update に含める

**VaultContextValue に追加:**

```typescript
getEcdhPrivateKeyBytes: () => Uint8Array | null;
getEcdhPublicKeyJwk: () => string | null;
```

- `unlock` 成功時に ECDH 秘密鍵を復号して `useRef` に保持
- `lock` / `pagehide` でゼロクリア
- `changePassphrase`: encryptionKey は secretKey のみから導出 (HKDF, salt=empty) されるため、パスフレーズ変更で encryptionKey は不変。ECDH 秘密鍵の再暗号化は不要
- Recovery Key リセット: 同上。secretKey 自体は不変のため encryptionKey も不変。ECDH 再暗号化不要

**ECDH 秘密鍵の暗号化鍵 (S-11):** `encryptionKey` を直接使わず、secretKey から HKDF ドメイン分離で導出:
`secretKey → HKDF("passwd-sso-ecdh-v1") → ecdhWrappingKey` (個人パスワード暗号化とは別鍵)

**Vault Reset 時の処理 (F-9):**

- ECDH フィールド 4 つを null にクリア
- 該当ユーザーの全 OrgMemberKey レコードを削除
- 全 OrgMember の `keyDistributed` を false にリセット
- Admin への通知 (鍵再配布が必要)
- 変更対象: `src/app/api/vault/reset/route.ts`

**`src/app/api/vault/unlock/data/route.ts`:** レスポンスに ECDH フィールド追加。ただし Extension Token 認証時は ECDH フィールドを除外 (拡張は現時点で個人 Vault のみ対応、org Vault は対象外)

### 1.4 テスト

- `src/lib/crypto-org.test.ts` — 全関数のユニットテスト (`crypto-emergency.test.ts` と同パターン)。AAD `"OK"` スコープ構築関数も `crypto-org.ts` に含め、同ファイルでテスト (T-7: `crypto-aad.ts` ではなく `crypto-org.ts` に実装)
- `src/app/api/vault/setup/route.test.ts` — ECDH フィールド含むセットアップテスト更新
- `src/app/api/vault/unlock/data/route.test.ts` — レスポンスに ECDH フィールドが含まれることの検証 + Extension Token 時は除外されることの検証 (T-12)
- `src/app/api/vault/reset/route.test.ts` — Vault Reset 時の ECDH null 化 + OrgMemberKey 削除 + keyDistributed リセットの検証 (F-9)
- `vitest.config.ts` — `coverage.include` に `src/lib/crypto-org.ts` を追加

---

## Phase 2: 組織作成 & メンバーキー配布

### 2.1 組織作成の E2E 化

**`src/app/api/orgs/route.ts` POST 変更:**

現在: サーバーが `generateOrgKey()` + `wrapOrgKey()` (crypto-server.ts)
変更後: クライアントが暗号化済み OrgMemberKey データを送信、サーバーはそのまま保存

```typescript
// POST body に追加:
{
  orgMemberKey: {
    encryptedOrgKey, orgKeyIv, orgKeyAuthTag,
    ephemeralPublicKey, hkdfSalt, keyVersion: 1
  }
}
```

**Vault アンロック前提条件:** クライアントで `vaultStatus !== "unlocked"` の場合は組織作成ダイアログを開かない (ECDH 秘密鍵がメモリにないため暗号化不可)。サーバーでも `orgMemberKey` 必須バリデーション。

サーバー: `Organization.create` + `OrgMemberKey.create` (owner用) + `e2eEnabled: true, orgKeyVersion: 1`

### 2.2 OrgVaultContext — 新規 `src/lib/org-vault-context.tsx`

```typescript
interface OrgVaultContextValue {
  getOrgEncryptionKey: (orgId: string) => Promise<CryptoKey | null>;
  invalidateOrgKey: (orgId: string) => void;
  clearAll: () => void;
}
```

- `Map<string, { key: CryptoKey; keyVersion: number; cachedAt: number }>` でキャッシュ
- `getOrgEncryptionKey`:
  1. キャッシュヒット + TTL 5分以内 → return
  2. `GET /api/orgs/[orgId]/member-key` で自分の OrgMemberKey 取得 (レスポンスに keyVersion 含む)
  3. キャッシュの keyVersion と不一致 → 再取得 (鍵ローテーション検知)
  4. VaultContext の `getEcdhPrivateKeyBytes()` で ECDH 秘密鍵取得
  5. `unwrapOrgKey()` → `deriveOrgEncryptionKey()` → キャッシュ
- vault lock 時に `clearAll()`
- メンバー除外後もキャッシュ TTL 満了まで一時的にアクセス継続 (許容範囲)

### 2.3 Invite → Accept → Confirm フロー

**Step 1 Invite:** 変更なし (既存の招待作成ロジック)

**Step 2 Accept:** `src/app/api/orgs/invitations/accept/route.ts`

- 既存: `OrgMember.create` + `invitation.status = ACCEPTED`
- 追加: invitee の `ecdhPublicKey` チェック
  - `ecdhPublicKey` が存在: `OrgMember.create` + `keyDistributed: false` → Admin の自動 Confirm を待つ
  - `ecdhPublicKey` が null (Vault 未セットアップ): `OrgMember.create` + `keyDistributed: false` で作成は許可。ただしレスポンスに `vaultSetupRequired: true` を返し、クライアントで Vault セットアップを促す UI を表示
  - Vault セットアップ完了後: `ecdhPublicKey` が登録され、次回の Admin ポーリングで自動鍵配布がトリガーされる
- レスポンスに `needsKeyDistribution: true` 追加

**Step 3 Confirm (新規 API):** `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.ts`

```
POST /api/orgs/[orgId]/members/[memberId]/confirm-key
Body: { encryptedOrgKey, orgKeyIv, orgKeyAuthTag, ephemeralPublicKey, hkdfSalt, keyVersion }
```

Admin のクライアントが:
1. OrgVaultContext から org key を取得 (復号済み)
2. 新メンバーの `ecdhPublicKey` を取得
3. `createOrgKeyEscrow()` で wrap → POST

サーバーが: `OrgMemberKey.upsert` (@@unique 制約 `[orgId, userId, keyVersion]` でレースコンディション防止) + `OrgMember.update({ keyDistributed: true })`

### 2.4 自動 Confirm (バックグラウンド鍵配布)

`vault-context.tsx` の `confirmPendingEmergencyGrants` と同様のパターン:

- unlock 成功後に `GET /api/orgs/pending-key-distributions` で未配布メンバー一覧取得
- Admin 権限がある org のメンバーに対して自動的に鍵配布
- 2 分間隔ポーリング (既存の EA と同じ)

**鍵配布待ち UX (F-3):**

- 新メンバーが Accept 後、鍵未配布の場合は org パスワード一覧にバナー表示: 「管理者がオンラインになるまでお待ちください」
- Admin 側: ダッシュボードに未配布メンバー数のバッジ通知
- `keyDistributed === false` の OrgMember は暗号化エントリにアクセス不可 (クライアントで OrgMemberKey なしを検知してガード)

### 2.5 公開鍵フィンガープリント表示 (S-1/S-7)

メンバー一覧 UI に各ユーザーの ECDH 公開鍵フィンガープリント (SHA-256 の先頭 16 文字) を表示。Admin が目視で確認可能。PoP (Proof of Possession) は過剰設計として見送り (1Password/Bitwarden と同等の設計)。

### 2.6 新規 API エンドポイント

| エンドポイント | メソッド | 目的 |
|---|---|---|
| `/api/orgs/[orgId]/member-key?keyVersion=N` | GET | 自分の OrgMemberKey 取得 (省略時は最新 keyVersion、旧バージョン指定で history restore 用) |
| `/api/orgs/[orgId]/members/[memberId]/confirm-key` | POST | メンバーへの鍵配布 |
| `/api/orgs/pending-key-distributions` | GET | 全 org の未配布メンバー一覧 |

### 2.7 テスト

既存テストはプロジェクトの配置パターンに従う (colocate 方式: ルートハンドラと同ディレクトリに `.test.ts`):

- `src/app/api/orgs/route.test.ts` — E2E 組織作成テスト (Vault アンロック前提条件含む)
- `src/app/api/orgs/invitations/accept/route.test.ts` — ecdhPublicKey チェック + Vault 未設定ユーザーの Accept
- `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.test.ts` — 鍵配布テスト (upsert 重複防止含む)
- `src/lib/org-vault-context.test.tsx` — キャッシュ動作テスト (`// @vitest-environment jsdom` ディレクティブ必須)
- `vitest.config.ts` — `coverage.include` に `src/lib/org-vault-context.tsx` を追加

---

## Phase 3: 組織 CRUD API 移行

### 3.1 GET /api/orgs/[orgId]/passwords (一覧)

`src/app/api/orgs/[orgId]/passwords/route.ts`

変更: サーバーの `decryptServerData` を削除。暗号化ブロブ (encryptedOverview, overviewIv, overviewAuthTag) をそのまま返す。
クライアント: OrgVaultContext で org encryption key を取得 → `decryptOrgEntry()` → overview 展開

Dual-read: `org.e2eEnabled` で分岐 (移行期間中は legacy モードも維持)

### 3.2 GET /api/orgs/[orgId]/passwords/[id] (詳細)

`src/app/api/orgs/[orgId]/passwords/[id]/route.ts`

変更: 暗号化ブロブ (encryptedBlob, blobIv, blobAuthTag) をそのまま返す。
クライアント: 復号して各フィールドに展開

### 3.3 POST /api/orgs/[orgId]/passwords (作成)

`src/app/api/orgs/[orgId]/passwords/route.ts`

変更: クライアントが暗号化済みブロブを送信 → サーバーはそのまま保存
新規 Zod スキーマ:

```typescript
const createOrgPasswordE2ESchema = z.object({
  encryptedBlob: z.string().min(1),
  blobIv: z.string().regex(/^[0-9a-f]{24}$/),
  blobAuthTag: z.string().regex(/^[0-9a-f]{32}$/),
  encryptedOverview: z.string().min(1),
  overviewIv: z.string().regex(/^[0-9a-f]{24}$/),
  overviewAuthTag: z.string().regex(/^[0-9a-f]{32}$/),
  aadVersion: z.number().int().min(1),
  orgKeyVersion: z.number().int().min(1),
  entryType: z.nativeEnum(EntryType).default("LOGIN"),
  tagIds: z.array(z.string()).optional(),
  orgFolderId: z.string().nullable().optional(),
});
```

### 3.4 PUT /api/orgs/[orgId]/passwords/[id] (更新)

`src/app/api/orgs/[orgId]/passwords/[id]/route.ts`

**最大の変更:** サーバーサイドの decrypt → merge → re-encrypt を廃止
→ **全文置換方式** (クライアントが復号 → 編集 → 全体を再暗号化して送信)
1Password/Bitwarden と同じパターン。個人 Vault の PUT と同等。

History 保存: 旧暗号化ブロブをそのまま history にコピー + `orgKeyVersion` も記録。
History restore: `history.orgKeyVersion !== org.orgKeyVersion` の場合、旧キーで復号 → 現キーで再暗号化してから restore (re-encrypt-on-restore)。

### 3.5 バッチ一覧 (アーカイブ/ゴミ箱)

`src/app/api/orgs/archived/route.ts`, `src/app/api/orgs/trash/route.ts`

変更: E2E org のエントリは暗号化 overview をそのまま返す。クライアントが復号。

### 3.6 クライアントサイド変更

org 関連の全コンポーネントで `OrgVaultContext.getOrgEncryptionKey(orgId)` を使用:
- `org-password-form-actions.ts` — 作成/更新時にクライアント暗号化
- `org-password-detail.tsx` — 詳細表示時にクライアント復号
- `org-password-card.tsx` — 一覧の overview 復号
- `org-archived-list.tsx`, `org-trash-list.tsx` — バッチ一覧の復号

### 3.7 テスト

既存 org password API route テストを E2E モード用に更新:

**テスト更新方針 (T-5):** サーバーサイド暗号関数 (`encryptServerData`/`decryptServerData`) のモックは維持。`e2eEnabled` 分岐ロジックのテストを追加し、E2E モードではサーバーが暗号化ブロブをそのまま保存/返却することを検証。

**更新対象テストファイル (colocate 方式):**

- `src/app/api/orgs/[orgId]/passwords/route.test.ts` — GET (一覧) + POST (作成)
- `src/app/api/orgs/[orgId]/passwords/[id]/route.test.ts` — GET/PUT/DELETE + history restore re-encrypt-on-restore
- `src/app/api/orgs/archived/route.test.ts` — アーカイブ一覧
- `src/app/api/orgs/trash/route.test.ts` — ゴミ箱一覧

---

## Phase 4: Share Link & Attachment 移行

### 4.1 Share Link — クライアント暗号化方式

`src/app/api/share-links/route.ts`

現在 (org entry): サーバーが org key で復号 → master key で再暗号化
変更後: **クライアント暗号化 + URL fragment 方式** (E2E 保証を維持)

フロー:

1. クライアントが org key で復号 → TOTP 削除
2. ランダム share key (256-bit) を生成
3. share key で平文データを AES-256-GCM 暗号化
4. 暗号化ブロブをサーバーに POST (サーバーはそのまま保存、master key 暗号化不要)
5. Share URL の fragment (`#key=<base64url>`) に share key を埋め込み
6. 閲覧者: URL fragment から share key を取得 → サーバーから暗号化ブロブを GET → クライアントで復号

理由: 平文をサーバーに送信するパターンは E2E の目標と矛盾するため、share link もクライアント暗号化に統一。URL fragment はサーバーに送信されないため、サーバーは平文にアクセスできない。

**ブラウザ履歴対策 (S-15):** 閲覧ページで `history.replaceState(null, "", location.pathname + location.search)` を実行し、fragment を即座に除去。既存 CSP (proxy.ts) で外部スクリプトを制限。

### 4.2 Attachment

`src/app/api/orgs/[orgId]/passwords/[id]/attachments/route.ts`

Upload: クライアントが org encryption key でファイルを暗号化 → 暗号化データ + iv + authTag を送信 → サーバーはそのまま保存
Download: サーバーが暗号化データをそのまま返却 → クライアントが復号

レスポンスヘッダに `X-Attachment-Iv`, `X-Attachment-AuthTag` を追加

### 4.3 テスト

**テスト更新方針:** Phase 3.7 と同パターン。`e2eEnabled` 分岐テストを追加。

**更新対象テストファイル:**

- `src/app/api/share-links/route.test.ts` — org entry の share link テスト更新: E2E モードではクライアント暗号化ブロブをそのまま保存、`mockDecryptServerData` 呼び出しなしを検証。URL fragment 方式の閲覧ページテスト (`history.replaceState` 呼び出し確認)
- `src/app/api/orgs/[orgId]/passwords/[id]/attachments/route.test.ts` — E2E モードでの暗号化 upload/download テスト

---

## Phase 5: 移行ツール & 鍵ローテーション

### 5.1 Migration API — 新規 `src/app/api/orgs/[orgId]/migrate-e2e/route.ts`

**Admin (OWNER/ADMIN) のクライアントで実行する移行フロー:**

**移行専用エンドポイント (S-10):** 既存 passwords API への `_migrate` パラメータではなく、専用 API に分離:

- `POST /api/orgs/[orgId]/migrate-e2e/start` — 移行開始 (メンテナンスモード ON)
- `GET /api/orgs/[orgId]/migrate-e2e/entries?offset=0&limit=10` — サーバー復号済みエントリ取得 (OWNER/ADMIN 限定、`e2eEnabled === false` の場合のみ許可)
- `POST /api/orgs/[orgId]/migrate-e2e/batch` — 暗号化済みバッチ送信
- `POST /api/orgs/[orgId]/migrate-e2e/complete` — 移行完了 (e2eEnabled=true + メンテナンスモード OFF)

**メンテナンスモード (F-12/S-13):** 移行中は org を `migrationInProgress: true` にし、他メンバーの書き込み (POST/PUT/DELETE) を拒否 (読み取りのみ許可)。Organization モデルに `migrationInProgress Boolean @default(false)` を追加。

**チャンク処理 (S-4):** ブラウザメモリでの全平文展開を避けるため、10 エントリずつ処理:

1. `POST .../migrate-e2e/start` でメンテナンスモード ON + 新 org symmetric key 生成
2. `GET .../migrate-e2e/entries?offset=0&limit=10` で 10 件取得 (サーバー復号)
3. 10 件をクライアントで暗号化 → `POST .../migrate-e2e/batch` で送信
4. サーバーが処理済みオフセットを記録 (中断再開可能)
5. 次の 10 件を取得 → 繰り返し
6. 全件完了後: 全メンバーの ECDH public key 取得 → org key を各メンバー用に wrap
7. `POST .../migrate-e2e/complete` で OrgMemberKey 作成 + `e2eEnabled: true` + `migrationInProgress: false`
8. 移行完了後: `Organization` の `encryptedOrgKey` / `orgKeyIv` / `orgKeyAuthTag` を NULL 化 (サーバーサイド復号を物理的に不可能にする)

UI にプログレスバー (処理済み/全件数) + 中断・再開ボタンを表示。

### 5.2 Key Rotation API — 新規 `src/app/api/orgs/[orgId]/rotate-key/route.ts`

**Admin のクライアントで実行:**

1. 現 org key で全エントリ復号
2. 新 org symmetric key 生成
3. 全エントリを新 key で再暗号化
4. 現メンバー全員に新 key を配布 (ECDH wrap)
5. `POST /api/orgs/[orgId]/rotate-key` でバッチ送信

サーバー: トランザクション内で全エントリ更新 (orgKeyVersion 更新) + 新 OrgMemberKey 作成 + `orgKeyVersion` インクリメント
旧 OrgMemberKey は保持 (history 復号用)

### 5.3 e2eEnabled 一方向制約 (S-8)

- `e2eEnabled` は `false → true` のみ許可。`true → false` の切り替えは API レベルで拒否
- 変更は OWNER ロール限定
- 変更時に `AuditAction.ORG_E2E_MIGRATION` を記録

### 5.4 AuditAction 追加

```
ORG_E2E_MIGRATION, ORG_KEY_ROTATION, ORG_MEMBER_KEY_DISTRIBUTE
```

連鎖更新: `prisma/schema.prisma` AuditAction enum, `src/lib/constants/audit.ts`, `messages/{en,ja}/AuditLog.json`

### 5.5 UI コンポーネント

- 移行ウィザード: `src/components/org/org-e2e-migration-wizard.tsx`
- ローテーションダイアログ: `src/components/org/org-key-rotation-dialog.tsx`
- プログレスバー + エントリ数カウンタ

### 5.6 テスト

- `src/app/api/orgs/[orgId]/migrate-e2e/route.test.ts` — 移行 API テスト (チャンク処理、中断再開、メンテナンスモード、全エントリ更新 + OrgMemberKey 作成、サーバー鍵 NULL 化)
- `src/app/api/orgs/[orgId]/rotate-key/route.test.ts` — ローテーション API テスト
- `src/__tests__/integration/org-e2e-lifecycle.test.ts` — Vitest 統合テスト (モック境界): legacy → E2E 移行 → 通常 CRUD → ローテーション → history restore (orgKeyVersion 不一致の re-encrypt 確認)

---

## 変更ファイルサマリ

### 新規ファイル (~25)

| カテゴリ | ファイル |
|---------|---------|
| Crypto | `src/lib/crypto-org.ts` |
| Context | `src/lib/org-vault-context.tsx` |
| API | `src/app/api/orgs/[orgId]/member-key/route.ts` |
| API | `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.ts` |
| API | `src/app/api/orgs/pending-key-distributions/route.ts` |
| API | `src/app/api/orgs/[orgId]/migrate-e2e/start/route.ts` |
| API | `src/app/api/orgs/[orgId]/migrate-e2e/entries/route.ts` |
| API | `src/app/api/orgs/[orgId]/migrate-e2e/batch/route.ts` |
| API | `src/app/api/orgs/[orgId]/migrate-e2e/complete/route.ts` |
| API | `src/app/api/orgs/[orgId]/rotate-key/route.ts` |
| UI | `src/components/org/org-e2e-migration-wizard.tsx` |
| UI | `src/components/org/org-key-rotation-dialog.tsx` |
| Tests | 各 `.test.ts` (~12 ファイル) |

### 変更ファイル (~25)

| ファイル | 変更内容 |
|---------|---------|
| `prisma/schema.prisma` | User ECDH, OrgMemberKey, Organization e2e, OrgMember keyDistributed |
| `src/lib/vault-context.tsx` | ECDH 鍵ペア生成/保持/復号、自動鍵配布 |
| `src/app/api/vault/setup/route.ts` | ECDH フィールド追加 |
| `src/app/api/vault/unlock/data/route.ts` | ECDH フィールド追加 |
| `src/app/api/vault/reset/route.ts` | ECDH null 化 + OrgMemberKey 削除 + keyDistributed リセット |
| `src/app/api/orgs/route.ts` | POST: クライアント暗号化方式に変更 |
| `src/app/api/orgs/invitations/accept/route.ts` | ecdhPublicKey 必須チェック |
| `src/app/api/orgs/[orgId]/passwords/route.ts` | GET/POST: E2E モード対応 |
| `src/app/api/orgs/[orgId]/passwords/[id]/route.ts` | GET/PUT/DELETE: E2E モード対応 |
| `src/app/api/orgs/archived/route.ts` | E2E 暗号化ブロブ返却 |
| `src/app/api/orgs/trash/route.ts` | E2E 暗号化ブロブ返却 |
| `src/app/api/share-links/route.ts` | org entry: クライアント暗号化 + URL fragment 方式 |
| `src/app/api/orgs/[orgId]/passwords/[id]/attachments/*` | クライアント暗号化方式 |
| `src/lib/constants/audit.ts` | 3 AuditAction 追加 |
| `src/lib/validations.ts` | E2E 用スキーマ追加 |
| `messages/{en,ja}/AuditLog.json` | 新 action ラベル |
| org 関連 UI コンポーネント (~6 ファイル) | OrgVaultContext 使用に変更 |

---

## 依存関係

```
Phase 1 (暗号基盤) ← 最初に必要
  └→ Phase 2 (鍵配布) ← Phase 1 完了後
      └→ Phase 3 (CRUD 移行) ← Phase 2 完了後
          ├→ Phase 4 (Share & Attachment) ← Phase 3 完了後
          └→ Phase 5 (移行 & ローテーション) ← Phase 3 と並行可能
```

---

## Verification

1. `npx prisma migrate dev` — マイグレーション成功
2. `npm run build` — TypeScript コンパイル成功
3. `npx vitest run` — 全テスト pass
4. `npm run lint` — ESLint pass
5. 手動確認:
   - 新規組織作成 → E2E 暗号化で作成される
   - メンバー招待 → Accept → Admin ログイン時に自動鍵配布
   - 組織パスワード CRUD (作成/一覧/詳細/更新/削除)
   - 共有リンク作成 → 閲覧
   - 添付ファイル upload/download
   - 既存組織の E2E 移行 → 移行後の CRUD 動作確認
   - 鍵ローテーション → 全エントリの復号確認
