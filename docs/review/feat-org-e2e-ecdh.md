# コードレビュー: feat/org-e2e-ecdh
日時: 2026-02-23T23:00:00+09:00
レビュー回数: 2回目

## 前回からの変更
1回目レビュー (S-01〜S-11) の全指摘を修正済み。2回目レビューで新規指摘 (S-12〜S-16, F-2, F-9, T-4〜T-9) を対応。

## セキュリティ観点の指摘

### [CRITICAL] S-01: `createOrgKeyEscrow` の `hkdfSalt` が鍵導出に未使用 (Dead Salt) — 解決済み

- **問題:** ランダム salt が `wrapOrgKeyForMember` に渡されていなかった。
- **対応:** `deriveOrgWrappingKey` の引数を `orgId: string` → `salt: Uint8Array` に変更。全関数チェーン修正。

### [MEDIUM] S-03: `distributePendingKeys` で `orgKeyBytes` がゼロクリアされない — 解決済み
### [MEDIUM] S-04: `getOrgEncryptionKey` で `orgKeyBytes` がゼロクリアされない — 解決済み
### [MEDIUM] S-09: `getOrgEncryptionKey` の再帰呼び出し — 解決済み (再帰除去)
### [LOW] S-05: ECDH private key コピーのゼロクリア — 解決済み
### [LOW] S-06: Referrer-Policy 未設定 — 解決済み
### [LOW] S-08: shareKey ゼロクリア — 解決済み
### [LOW] S-11: confirm-key 配布済み上書き — 解決済み

### [MEDIUM] S-12: `confirm-key` の TOCTOU — `keyDistributed` チェックがトランザクション外 — 解決済み

- **問題:** `keyDistributed` チェック (行 62) と `$transaction` (行 87) の間にレースコンディションの可能性。
- **対応:** バッチ `$transaction` をインタラクティブ `$transaction` に変更。トランザクション内で `keyDistributed` を再チェック。
- 修正ファイル: `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.ts`

### [MEDIUM] S-13: `org-create-dialog` の `orgKey` がゼロクリアされない — 解決済み

- **問題:** `generateOrgSymmetricKey()` で生成した `orgKey` が `createOrgKeyEscrow` 後にゼロクリアされない。
- **対応:** `try/finally` で `orgKey.fill(0)` を追加。
- 修正ファイル: `src/components/org/org-create-dialog.tsx`

### [MEDIUM] S-14: `share-e2e-entry-view` の `keyBytes` がゼロクリアされない — 解決済み

- **問題:** 復号完了後に `keyBytes` がゼロクリアされない。
- **対応:** `.finally(() => keyBytes.fill(0))` を追加。
- 修正ファイル: `src/components/share/share-e2e-entry-view.tsx`

### [LOW] S-15: パスワード作成時の `orgKeyVersion` 未検証 — 解決済み

- **問題:** クライアントが古い `orgKeyVersion` で暗号化したデータを送信できてしまう。
- **対応:** POST 時に `org.orgKeyVersion` と照合し、不一致で 409 を返す。`ORG_KEY_VERSION_MISMATCH` エラーコード追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/route.ts`, `src/lib/api-error-codes.ts`, `messages/{en,ja}/ApiErrors.json`

### [LOW] S-16: `pending-key-distributions` レスポンスに PII (name, email) が含まれる — 解決済み

- **問題:** バックグラウンド鍵配布には `ecdhPublicKey` のみ必要。`name`/`email` は不要な漏洩リスク。
- **対応:** select と response mapping から `name`/`email` を除去。
- 修正ファイル: `src/app/api/orgs/pending-key-distributions/route.ts`

## 機能観点の指摘

### [MEDIUM] F-2: `rotate-key` の `entries` 配列にサイズ上限なし — 解決済み

- **問題:** 大量エントリによるメモリ枯渇の可能性。
- **対応:** `.max(1000)` をスキーマに追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.ts`

### [MEDIUM] F-9: PUT の history snapshot と entry update が別トランザクション — 解決済み

- **問題:** history 作成と entry 更新が別々に実行され、間にクラッシュすると不整合になる。
- **対応:** 単一の `$transaction` に統合。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/[id]/route.ts`

## テスト観点の指摘

### T-4: `confirm-key` の `KEY_ALREADY_DISTRIBUTED` テスト — 解決済み

- **対応:** TOCTOU レース (トランザクション内での再チェック) テストを追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.test.ts`

### T-5: `rotate-key` の org 未存在 (404) テスト — 解決済み
### T-6: `rotate-key` の権限不足 (403) テスト — 解決済み
### F-2 テスト: entries 上限超過 (400) テスト — 解決済み

- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.test.ts`

### T-9: `member-key` の `keyVersion=0` 境界テスト — 解決済み

- 修正ファイル: `src/app/api/orgs/[orgId]/member-key/route.test.ts`

### T-8: `org-entry-payload` の IDENTITY/PASSKEY テスト — 解決済み

- 修正ファイル: `src/lib/org-entry-payload.test.ts`

### S-15 テスト: `orgKeyVersion` 不一致テスト — 解決済み

- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/route.test.ts`

### S-16 テスト: PII 除外テスト — 解決済み

- 修正ファイル: `src/app/api/orgs/pending-key-distributions/route.test.ts`

### T-1/T-2/T-3/T-7: 新規テストファイル作成 — 保留

- `org-vault-context.tsx`, `org-entry-save.ts`, `share-e2e-entry-view.tsx` のユニットテストは、複雑な React コンテキスト/Web Crypto API モック基盤が必要。別 PR で対応予定。
- Zod スキーマ (T-7) はルートハンドラテスト内でバリデーションが間接的にカバー済み。

## 対応状況

全 2324 テスト pass。
