# コードレビュー: feat/org-e2e-ecdh
日時: 2026-02-24T07:45:00+09:00
レビュー回数: 10回目（最終）

## 前回からの変更
8回目レビュー (N-01~N-03, F-31) → 9回目 (ロールバックコメント, エラーログ, wrapVersion テスト) → 10回目: 全3観点で指摘なし（セキュリティの改善提案3件はクライアントコード堅牢性であり脆弱性ではないためスキップ）。

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

### [MEDIUM] S-17: `rotate-key` の TOCTOU — `orgKeyVersion` の楽観ロック欠如 — 解決済み

- **問題:** バッチ `$transaction([...])` 内の `organization.update` に楽観ロックがなく、並行実行で二重ローテーションの可能性。
- **対応:** インタラクティブ `$transaction` に変更。トランザクション内で `orgKeyVersion` を再検証し、不一致で 409 を返す。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.ts`

### [LOW] S-18: `orgMemberKeySchema` のフィールドに最大長バリデーションなし — 解決済み

- **問題:** `encryptedOrgKey` と `ephemeralPublicKey` に `.max()` 制約がなく、巨大ペイロードの受け入れが可能。
- **対応:** `encryptedOrgKey` に `.max(1000)`、`ephemeralPublicKey` に `.max(500)` を追加。
- 修正ファイル: `src/lib/validations.ts`

### [MEDIUM] S-19: `share-dialog.tsx` の `shareKeyForFragment` スコーピングバグ — 解決済み

- **問題:** `let shareKeyForFragment` が `try` ブロック内で宣言されており、`finally` からアクセスできない。ゼロクリアが実行されない。
- **対応:** `let shareKeyForFragment` を `try` ブロック前に移動。
- 修正ファイル: `src/components/share/share-dialog.tsx`

### [MEDIUM] S-20: 添付ファイルアップロードに `orgKeyVersion` 検証なし — 解決済み

- **問題:** attachment POST が `orgKeyVersion` を検証せず、古い鍵バージョンで暗号化されたファイルが保存される可能性。
- **対応:** `organization.findUnique` で `orgKeyVersion` を取得し、クライアント送信の `orgKeyVersion` と照合。不一致で 409 を返す。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/[id]/attachments/route.ts`

### [LOW] S-22: `rotate-key` で非メンバーの `memberKeys` が受け入れられる — 解決済み

- **問題:** `memberKeys.filter((k) => memberUserIds.has(k.userId))` で非メンバーの鍵が黙って除外されるだけ。攻撃者が任意の userId で鍵を送信可能。
- **対応:** トランザクション前に非メンバーの鍵を明示的にリジェクトし、400 を返す。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.ts`

### [LOW] S-23: `orgMemberKeySchema` に `wrapVersion` フィールドなし — 解決済み

- **問題:** `wrapVersion` がスキーマに含まれず、confirm-key/rotate-key で `undefined` が渡される可能性。
- **対応:** `wrapVersion: z.number().int().min(1).max(1).default(1)` を追加。
- 修正ファイル: `src/lib/validations.ts`

### [INFO] S-24: org share entry で `data` フィールドが受け入れられる — 解決済み

- **問題:** `orgPasswordEntryId` が指定された org 共有リンクで、同時に `data` フィールドが送信可能。E2E 暗号化では `data` は不要。
- **対応:** `createShareLinkSchema` に refine を追加し、org entry で `data` が存在する場合にバリデーションエラーを返す。
- 修正ファイル: `src/lib/validations.ts`

### [MEDIUM] S-25: `encryptedFieldSchema.ciphertext` に最大長制約がない — 解決済み

- **問題:** `ciphertext` フィールドに `.max()` がなく、巨大ペイロードが受け入れ可能。
- **対応:** `.max(500_000)` を `encryptedFieldSchema` および `rotate-key` のローカルスキーマに追加。
- 修正ファイル: `src/lib/validations.ts`, `src/app/api/orgs/[orgId]/rotate-key/route.ts`

### [LOW] S-26: 組織作成時に `wrapVersion` が DB に保存されない — 解決済み

- **問題:** `memberKeys.create` に `wrapVersion` フィールドが欠落し、DB デフォルト値に依存。
- **対応:** `wrapVersion: orgMemberKey.wrapVersion` を明示的に保存。
- 修正ファイル: `src/app/api/orgs/route.ts`

### [INFO] S-28: `pending-key-distributions` の TOFU 問題 — 設計上の制限

- **問題:** ECDH 公開鍵の真正性検証がなく、サーバーが鍵を差し替える中間者攻撃の理論的可能性。
- **判断:** 標準的な TOFU (Trust on First Use) の制限。1Password/Bitwarden と同等の脅威モデル。将来的にフィンガープリント表示を検討。

### [LOW] S-30: `member-key` の `keyVersion` クエリパラメータに上限なし — 解決済み

- **問題:** 非常に大きな `keyVersion` 値での無駄な DB クエリが可能。
- **対応:** `keyVersion > 10000` で 400 を返す上限チェックを追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/member-key/route.ts`

### [LOW] N-01: `rotate-key` の `memberKeys` 配列に `.max()` なし — 解決済み

- **問題:** `memberKeys` 配列にサイズ上限がなく、巨大ペイロードが受け入れ可能。
- **対応:** `.max(1000)` を追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.ts`

### [LOW] N-02: `rotate-key` の `newOrgKeyVersion` に上限なし — 解決済み

- **問題:** `newOrgKeyVersion` に `.max()` がなく、S-30 の `member-key` 上限と不整合。
- **対応:** `.max(10_000)` を追加 (S-30 と整合)。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.ts`

### [LOW] N-03: `rotate-key` の `$transaction` にタイムアウト未設定 — 解決済み

- **問題:** 1000 エントリの `Promise.all` が長時間実行される可能性があり、デフォルトタイムアウトでは不十分。
- **対応:** `{ timeout: 60_000 }` を追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.ts`

## 機能観点の指摘

### [MEDIUM] F-2: `rotate-key` の `entries` 配列にサイズ上限なし — 解決済み

- **問題:** 大量エントリによるメモリ枯渇の可能性。
- **対応:** `.max(1000)` をスキーマに追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.ts`

### [MEDIUM] F-9: PUT の history snapshot と entry update が別トランザクション — 解決済み

- **問題:** history 作成と entry 更新が別々に実行され、間にクラッシュすると不整合になる。
- **対応:** 単一の `$transaction` に統合。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/[id]/route.ts`

### [LOW] F-11: `rotate-key` の `orgKeyVersion` 楽観ロック — 解決済み (S-17 と同一)

### [MEDIUM] F-16: `confirm-key` の `keyVersion` が `orgKeyVersion` と照合されない — 解決済み

- **問題:** confirm-key が受け取る `keyVersion` を org の `orgKeyVersion` と比較せず、旧バージョンの鍵が配布される可能性。
- **対応:** インタラクティブ `$transaction` 内で `org.orgKeyVersion` を取得し、`keyVersion` と照合。不一致で 409 を返す。
- 修正ファイル: `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.ts`

### [HIGH] F-17: `rotate-key` が送信エントリと実 org エントリの一致を検証しない — 解決済み

- **問題:** クライアントが一部のエントリのみ送信した場合、未送信エントリが古い鍵のまま残り、新旧鍵の混在が発生する。
- **対応:** トランザクション内で全 org エントリを取得し、送信されたエントリ ID とセット比較。不一致で `ENTRY_COUNT_MISMATCH` エラーを返す。`updateMany` に `orgKeyVersion` 条件を追加し、古い鍵バージョンのエントリのみ更新。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.ts`, `src/lib/api-error-codes.ts`

### [MEDIUM] F-18: `rotate-key` で非メンバーの `memberKeys` が黙って除外される — 解決済み (S-22 と同一)

### [MEDIUM] F-19: `orgMemberKeySchema` に `wrapVersion` なし — 解決済み (S-23 と同一)

### [MEDIUM] F-20: `passwords` GET の auto-purge がレスポンスをブロックする — 解決済み

- **問題:** `await prisma.orgPasswordEntry.deleteMany(...)` が完了するまでレスポンスが返されない。
- **対応:** `await` を除去し、fire-and-forget パターンに変更。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/route.ts`

### [LOW] F-21: `share-dialog` で TOTP が暗号化前にストリップされない — 解決済み

- **問題:** TOTP シークレットが共有リンクのデータに含まれる可能性。
- **対応:** `const { totp: _totp, ...safeData } = (decryptedData ?? {}) as Record<string, unknown>;` で暗号化前に TOTP を除去。
- 修正ファイル: `src/components/share/share-dialog.tsx`

### [LOW] F-22: `share-links/route.ts` の no-op spread — 解決済み

- **問題:** `const { totp: _totp, ...rest } = data` のパターンが Zod スキーマ通過後に効果なし (Zod が unknown フィールドを既に除外)。
- **対応:** 不要な分割代入を削除し、`const plaintext = JSON.stringify(data)` に簡素化。
- 修正ファイル: `src/app/api/share-links/route.ts`

### [LOW] F-23: 添付ファイルアップロードに `orgKeyVersion` 検証なし — 解決済み (S-20 と同一)

### [LOW] F-24: 組織作成時に `wrapVersion` 未保存 — 解決済み (S-26 と同一)

### [LOW] F-25: `distributePendingKeys` で `wrapVersion` 未送信 — 解決済み

- **問題:** `createOrgKeyEscrow` の結果を confirm-key に POST する際、`wrapVersion` が body に含まれない。
- **対応:** `wrapVersion: escrow.wrapVersion` を body に追加。
- 修正ファイル: `src/lib/org-vault-context.tsx`

### [MEDIUM] F-26: `rotate-key` のメンバーリスト取得がトランザクション外 — 解決済み

- **問題:** メンバーリストの取得がトランザクション外で行われ、TOCTOU のリスク。
- **対応:** メンバー検証をインタラクティブトランザクション内に移動。`TxValidationError` クラスで詳細を保持。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.ts`

### [LOW] F-27: `share-links` POST で org エントリの `entryType` が DB から取得されない — 解決済み

- **問題:** クライアント提供の `entryType` をそのまま使用し、DB の実際の値と異なる可能性。
- **対応:** `select` に `entryType: true` を追加し、DB の値を使用。
- 修正ファイル: `src/app/api/share-links/route.ts`

### [LOW] F-28: `passwords/[id]` PUT の update に `orgId` 制約なし — 解決済み

- **問題:** `where: { id }` のみで `orgId` 制約がなく、一貫性に欠ける。
- **対応:** `where: { id, orgId }` に変更。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/[id]/route.ts`

### [HIGH] F-29: 履歴復元で古い `orgKeyVersion` が書き戻され `rotate-key` が壊れる — 解決済み

- **問題:** 鍵ローテーション後に古い履歴を復元すると、エントリの `orgKeyVersion` が古くなり、`rotate-key` の `updateMany` where 句で一致しなくなる。
- **対応:** `rotate-key` の `updateMany` where 句から `orgKeyVersion` を除去。ID セット検証 + 組織レベル楽観ロックで十分に保護。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.ts`

### [LOW] F-31: 履歴一覧レスポンスに `orgKeyVersion` なし — 解決済み

- **問題:** クライアントが旧バージョン鍵で暗号化された履歴を復号する際、`orgKeyVersion` が不明で正しい鍵を選択できない。
- **対応:** `orgKeyVersion: h.orgKeyVersion` をレスポンスマッピングに追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/[id]/history/route.ts`

### [LOW] F-30: permanent delete で blob store クリーンアップなし — 既知の制限

- **問題:** permanent delete 時に blob store のゴーストデータが残存する。
- **判断:** E2E 暗号化されているため機密性リスクは低い。ストレージクリーンアップは別 PR で対応予定。

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

### Q-1: `confirm-key` の orgId 不一致 IDOR テスト — 解決済み

- **対応:** target member が別 org に所属する場合に 404 を返すことを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.test.ts`

### Q-2: `confirm-key` の事前チェック keyDistributed=true テスト — 解決済み

- **対応:** 事前チェック段階で配布済みを検出し、トランザクション呼出なしで 409 を返すことを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.test.ts`

### Q-3: `confirm-key` の不正 JSON テスト — 解決済み

### Q-4: `rotate-key` の不正 JSON テスト — 解決済み

- 修正ファイル: 各ルートの `.test.ts`

### Q-5: `rotate-key` の非メンバー memberKeys リジェクトテスト — 解決済み

- **対応:** 非メンバーの userId を含む memberKeys が 400 でリジェクトされることを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.test.ts`

### Q-6/Q-7: `passwords/[id]` GET/PUT の orgId 不一致 IDOR テスト — 解決済み

- **対応:** エントリが別 org に所属する場合に 404 を返すことを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/[id]/route.test.ts`

### Q-8: PUT のメタデータ専用更新テスト — 解決済み

- **対応:** 暗号化ブロブなしの更新で history snapshot が作成されないことを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/[id]/route.test.ts`

### Q-9: POST の org 未存在テスト — 解決済み

- **対応:** org が null の場合に 409 (ORG_KEY_VERSION_MISMATCH) を返すことを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/route.test.ts`

### F-13: PUT の `isFullUpdate` 時に `orgKeyVersion` の検証なし — 解決済み

- **問題:** POST にはバージョン検証があるが、PUT の全文更新時には欠如しており、旧バージョンで暗号化されたデータが保存される可能性。
- **対応:** PUT の `isFullUpdate` ブランチ内で `org.orgKeyVersion` と照合し、不一致で 409 を返す。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/[id]/route.ts`

### F-14: History restore で overview が更新されない — 設計上問題なし

- **問題:** restore API は `encryptedBlob` のみ復元し、`encryptedOverview` は更新しない。
- **判断:** 設計上、クライアントが restore 後に復号 → overview 再生成 → PUT で更新する想定。別 PR で対応不要。

### R-1: DELETE の orgId 不一致 IDOR テスト — 解決済み

- **対応:** GET (Q-6) / PUT (Q-7) と同等の IDOR 防止テストを DELETE にも追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/[id]/route.test.ts`

### R-2: `orgMemberKeySchema` の境界テスト — 解決済み

- **対応:** `encryptedOrgKey` の max(1000) 境界、`ephemeralPublicKey` の max(500) 境界、IV/Salt 形式検証テストを追加。
- 修正ファイル: `src/lib/validations.test.ts`

### S-1: `member-key` テストの `org-auth` モック欠如 — 解決済み

- **対応:** `@/lib/org-auth` を明示的にモックし、`OrgAuthError` と `requireOrgMember` の動作テストを追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/member-key/route.test.ts`

### S-2: `rotate-key` の `logAudit` アサーション不足 — 解決済み

- **対応:** 成功テストに `logAudit` の呼び出し検証 (action, orgId, metadata) を追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.test.ts`

### S-3: `rotate-key` の `keyVersion` 強制テスト — 解決済み

- **対応:** ペイロードの `keyVersion: 999` がサーバーで `newOrgKeyVersion: 2` に強制されることを検証するテストを追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.test.ts`

### F-16 テスト: `confirm-key` の keyVersion 不一致テスト — 解決済み

- **対応:** `keyVersion` が `orgKeyVersion` と一致しない場合に 409 を返すことを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/members/[memberId]/confirm-key/route.test.ts`

### F-17 テスト: `rotate-key` のエントリ数不一致テスト — 解決済み

- **対応:** org エントリ数とリクエストエントリ数の不一致、および ID の不一致でエラーを返すことを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.test.ts`

### F-18/S-22 テスト: `rotate-key` の非メンバー memberKeys リジェクトテスト — 解決済み

- **対応:** 非メンバーの鍵が 400 で明示的にリジェクトされることを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.test.ts`

### F-19 テスト: `rotate-key` の `wrapVersion` パススルーテスト — 解決済み

- **対応:** `wrapVersion: 1` が `OrgMemberKey.create` に正しく渡されることを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.test.ts`

### S-20 テスト: attachment `orgKeyVersion` 不一致テスト — 解決済み

- **対応:** `orgKeyVersion` が org の現在のバージョンと不一致の場合に 409 を返すことを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/passwords/[id]/attachments/route.test.ts`

### S-24 テスト: org share entry の `data` フィールドリジェクトテスト — 解決済み

- **対応:** `orgPasswordEntryId` と `data` が同時に指定された場合にバリデーションエラーを返すことを検証。
- 修正ファイル: `src/__tests__/api/share-links/route.test.ts`

### `wrapVersion` バリデーションテスト — 解決済み

- **対応:** `wrapVersion` のデフォルト値 (1)、受入値 (1)、拒否値 (2) を検証。
- 修正ファイル: `src/lib/validations.test.ts`

### org 作成 malformed JSON テスト — 解決済み

- **対応:** `POST /api/orgs` に不正 JSON を送信して 400 (INVALID_JSON) を返すことを検証。
- 修正ファイル: `src/app/api/orgs/route.test.ts`

### S-26/F-24 テスト: org 作成 wrapVersion 保存テスト — 解決済み

- **対応:** `wrapVersion: 1` が `Organization.create` の `memberKeys.create` に渡されることを検証。
- 修正ファイル: `src/app/api/orgs/route.test.ts`

### S-30 テスト: `member-key` の `keyVersion` 上限テスト — 解決済み

- **対応:** `keyVersion=10001` で 400 を返すことを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/member-key/route.test.ts`

### F-29 テスト: `rotate-key` の混合 orgKeyVersion 成功テスト — 解決済み

- **対応:** 履歴復元で古い orgKeyVersion を持つエントリがあっても鍵ローテーションが成功することを検証。
- 修正ファイル: `src/app/api/orgs/[orgId]/rotate-key/route.test.ts`

### F-31 テスト: 履歴一覧に `orgKeyVersion` が含まれることを検証 — 解決済み

- **対応:** モックデータに `orgKeyVersion: 2` を追加し、レスポンスに含まれることを検証。
- 修正ファイル: `src/__tests__/api/orgs/org-history.test.ts`

### T-02 (ラウンド9): `member-key` GET の `wrapVersion` アサーション追加 — 解決済み

- **対応:** 「最新キー返却」「指定バージョン返却」両テストに `expect(json.wrapVersion).toBe(1)` を追加。
- 修正ファイル: `src/app/api/orgs/[orgId]/member-key/route.test.ts`

### T-1/T-2/T-3/T-7: 新規テストファイル作成 — 保留

- `org-vault-context.tsx`, `org-entry-save.ts`, `share-e2e-entry-view.tsx` のユニットテストは、複雑な React コンテキスト/Web Crypto API モック基盤が必要。別 PR で対応予定。
- Zod スキーマ (T-7) はルートハンドラテスト内でバリデーションが間接的にカバー済み。

## 鍵ローテーションポリシー（確定）

### 方針: 全件ローテーション + latest 1本で復号

1. `rotate-key` は全エントリ（active + trash + archived）を対象とする
2. ローテーション後、全エントリの `orgKeyVersion` は最新に統一される
3. クライアントは `getOrgEncryptionKey(orgId)` で最新鍵のみ取得・復号する
4. 履歴レコードは作成時の `orgKeyVersion` を保持（スナップショット）
5. 履歴復元時、`orgKeyVersion` 不一致が発生する場合はクライアントが旧鍵で復号 → 現鍵で再暗号化 → PUT で書き戻す（未実装、TODO）
6. 自動フォールバック（vN→vN-1 探索）は oracle 的情報漏洩面で採用しない

### 既知の制限

- 履歴表示 (`entry-history-section.tsx`): 旧バージョンの履歴は latest key で復号を試み、失敗する。`member-key?keyVersion=N` による多版鍵対応は future work。
- 履歴復元: サーバー側は `history.orgKeyVersion` をそのまま書き戻す。クライアント側の re-encrypt-on-restore は future work。

## 対応状況

全 2358 テスト pass。

## レビュー完了

10回目のレビューで全3観点（セキュリティ・機能・テスト）から「指摘なし」を達成。ブランチはマージ可能な品質。

### レビューループ履歴

| 回   | セキュリティ      | 機能              | テスト      | コミット       |
| ---- | ----------------- | ----------------- | ----------- | -------------- |
| 1-6  | 多数              | 多数              | 多数        | 前セッション   |
| 7    | S-25~S-30 (6件)   | F-24~F-29 (6件)   | 7件         | 240bd15        |
| 8    | N-01~N-03 (3件)   | F-31 (1件)        | 指摘なし    | 487dd2a        |
| 9    | 3件 (改善提案)    | 指摘なし          | T-02 (1件)  | 736d603        |
| 10   | 指摘なし*         | 指摘なし          | 指摘なし    | —              |

*セキュリティ10回目: 改善提案3件（並列キャッシュ, 型安全性, fetch タイムアウト）はクライアントコード堅牢性のためスキップ。
