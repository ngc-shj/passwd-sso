# コードレビュー: feat/org-e2e-ecdh
日時: 2026-02-23T22:30:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## セキュリティ観点の指摘

### [CRITICAL] S-01: `createOrgKeyEscrow` の `hkdfSalt` が鍵導出に未使用 (Dead Salt)

- **ファイル:** `src/lib/crypto-org.ts`, 行 362-403
- **問題:** `createOrgKeyEscrow` は32バイトのランダム `salt` を生成し `hkdfSalt` として返すが、`wrapOrgKeyForMember` 呼び出しに渡されていない。`deriveOrgWrappingKey` は `SHA-256(orgId)` を salt として使用。DB に保存される `hkdfSalt` は鍵導出に一切関与しない。
- **影響:** DB フィールドが嘘の値を保存。Emergency Access と設計が不整合。
- **推奨修正:** `wrapOrgKeyForMember` と `unwrapOrgKey` にランダム salt を引数として追加し、HKDF salt として使用する。

### [MEDIUM] S-03: `distributePendingKeys` で `orgKeyBytes` がゼロクリアされない

- **ファイル:** `src/lib/org-vault-context.tsx`, 行 248-258
- **問題:** `unwrapOrgKey` の返り値 `orgKeyBytes` が使用後にゼロクリアされない。
- **推奨修正:** 配布ループの `finally` ブロックで `orgKeyBytes.fill(0)` を追加。

### [MEDIUM] S-04: `getOrgEncryptionKey` で `orgKeyBytes` がゼロクリアされない

- **ファイル:** `src/lib/org-vault-context.tsx`, 行 140-153
- **問題:** `unwrapOrgKey` から返された `orgKeyBytes` が `deriveOrgEncryptionKey` に渡された後、ゼロクリアされない。
- **推奨修正:** `deriveOrgEncryptionKey` 呼び出し後に `orgKeyBytes.fill(0)` を追加。

### [MEDIUM] S-09: `getOrgEncryptionKey` の再帰呼び出しによる潜在的な無限ループ

- **ファイル:** `src/lib/org-vault-context.tsx`, 行 162-167
- **問題:** 短時間に複数回ローテーションされた場合、再帰呼び出しが無限ループする可能性。
- **推奨修正:** リトライカウンターを導入 (max 2 retries)。

### [LOW] S-05: `getEcdhPrivateKeyBytes` のコピーが呼び出し元でゼロクリアされない

- **ファイル:** `src/lib/vault-context.tsx`, 行 642-644 / `src/lib/org-vault-context.tsx`, 行 103, 189
- **推奨修正:** 各呼び出し箇所で使用後にゼロクリア。

### [LOW] S-06: E2E Share ページに `Referrer-Policy: no-referrer` が未設定

- **ファイル:** `src/app/s/[token]/page.tsx`
- **推奨修正:** 共有ページに `<meta name="referrer" content="no-referrer" />` を設定。

### [LOW] S-08: Share dialog の `shareKey` がゼロクリアされない

- **ファイル:** `src/components/share/share-dialog.tsx`, 行 162-213
- **推奨修正:** URL 構築後に `shareKeyForFragment.fill(0)` を追加。

### [LOW] S-11: `confirm-key` の upsert で既に配布済みメンバーの key 上書きが可能

- **ファイル:** `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.ts`, 行 79-110
- **推奨修正:** `keyDistributed: true` のメンバーに対する上書きを拒否する。

## 機能観点の指摘
(2回目レビューで評価予定)

## テスト観点の指摘
(2回目レビューで評価予定)

## 対応状況

### S-01: Dead Salt
- 対応: `deriveOrgWrappingKey` の引数を `orgId: string` → `salt: Uint8Array` に変更。`wrapOrgKeyForMember` に `hkdfSalt` パラメータ追加。`unwrapOrgKey` に `hkdfSalt: string` (hex) パラメータ追加。`createOrgKeyEscrow` がランダム salt を `wrapOrgKeyForMember` に渡すよう修正。`deriveOrgHkdfSalt(orgId)` 関数を削除。
- 修正ファイル: `src/lib/crypto-org.ts`, `src/lib/org-vault-context.tsx`, `src/lib/crypto-org.test.ts`

### S-03: distributePendingKeys の orgKeyBytes ゼロクリア
- 対応: `finally` ブロックで `orgKeyBytes?.fill(0)` を追加。
- 修正ファイル: `src/lib/org-vault-context.tsx`

### S-04: getOrgEncryptionKey の orgKeyBytes ゼロクリア
- 対応: `deriveOrgEncryptionKey` 呼び出し直後に `orgKeyBytes.fill(0)` を追加。
- 修正ファイル: `src/lib/org-vault-context.tsx`

### S-09: getOrgEncryptionKey の再帰呼び出し
- 対応: 再帰を完全に除去。サーバーは常に最新 keyVersion を返すため、再帰は不要。キャッシュ更新後にそのまま return。
- 修正ファイル: `src/lib/org-vault-context.tsx`

### S-05: ECDH private key コピーのゼロクリア
- 対応: `getOrgEncryptionKey` と `distributePendingKeys` 両方で、`importKey` 後に `ecdhPrivateKeyBytes.fill(0)` を追加。catch/finally でも確実にクリア。
- 修正ファイル: `src/lib/org-vault-context.tsx`

### S-06: E2E Share ページの Referrer-Policy
- 対応: `ShareE2EEntryView` に `useEffect` で `<meta name="referrer" content="no-referrer" />` を動的追加。
- 修正ファイル: `src/components/share/share-e2e-entry-view.tsx`

### S-08: shareKey のゼロクリア
- 対応: URL 構築後に `shareKeyForFragment.fill(0)` を追加。`finally` ブロックでも `shareKeyForFragment?.fill(0)` でカバー。
- 修正ファイル: `src/components/share/share-dialog.tsx`

### S-11: confirm-key の配布済みチェック
- 対応: `targetMember.keyDistributed === true` の場合に 409 を返すガードを追加。`KEY_ALREADY_DISTRIBUTED` エラーコードを新設。
- 修正ファイル: `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.ts`, `src/lib/api-error-codes.ts`, `messages/en/ApiErrors.json`, `messages/ja/ApiErrors.json`
