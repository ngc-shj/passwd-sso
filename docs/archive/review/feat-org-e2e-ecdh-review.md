# プランレビュー: wobbly-doodling-pascal.md

日時: 2026-02-23
総ループ回数: 2回

## ループ 1 (初回)

### 指摘数

- 機能: 7件 → 全件反映
- セキュリティ: 9件 → 7件反映、2件棄却 (S-1 過剰設計→フィンガープリント表示のみ)
- テスト: 6件 → 5件反映、1件棄却 (T-3 実装時に解決)

### 主な反映内容

- AAD スコープ "OK" + memberKeyId 設計 (F-1/S-6)
- Vault アンロック前提条件 (F-2)
- 鍵配布待ち UX — バナー + バッジ通知 (F-3)
- OrgPasswordEntryHistory に orgKeyVersion + re-encrypt-on-restore (F-4/F-6/S-5)
- Share Link をクライアント暗号化 + URL fragment 方式に変更 (F-5/S-3)
- Vault 未設定ユーザーの Accept フロー (F-7)
- e2eEnabled 一方向制約 + OWNER 限定 + 監査ログ (S-8)
- HKDF salt = SHA-256(orgId) (S-9)
- @@unique + upsert パターン (S-2)
- チャンク処理 10件 + 中断再開 (S-4)
- フィンガープリント表示 (S-1/S-7)
- テスト: coverage.include, jsdom ディレクティブ, Vitest 統合テスト明確化, テスト更新方針, ファイルパス具体列挙

## ループ 2

### 指摘数

- 機能: 6件 → 5件反映、1件は注記のみ (F-13 拡張は対象外)
- セキュリティ: 6件 → 全件反映
- テスト: 6件 → 5件反映、1件は F-10 で解消 (T-11)

### 主な反映内容

- changePassphrase / Recovery Key Reset で ECDH 再暗号化不要を明記 (F-10/F-8)
- Vault Reset 時の ECDH クリア + OrgMemberKey 削除 + keyDistributed リセット (F-9)
- 旧 keyVersion OrgMemberKey 取得用 API パラメータ (F-11)
- 移行専用エンドポイント分離 + OWNER/ADMIN 限定 + サーバー鍵 NULL 化 (S-10)
- メンテナンスモード (migrationInProgress) + 書き込みブロック (F-12/S-13)
- ECDH 秘密鍵暗号化の HKDF ドメイン分離 — ecdhWrappingKey (S-11)
- OrgVaultContext キャッシュ TTL 5分 + keyVersion チェック (S-12)
- deriveOrgEncryptionKey の salt パラメータ明記 (S-14)
- Share Link URL fragment のブラウザ履歴対策 — history.replaceState (S-15)
- Extension Token 時の ECDH フィールド除外 (F-13)
- AAD "OK" 実装場所を crypto-org.ts に明確化 (T-7)
- テスト配置 colocate 方式に統一 (T-8)
- Phase 4.3 テスト詳細化 (T-9)
- 統合テストパス明記 — src/__tests__/integration/org-e2e-lifecycle.test.ts (T-10)
- unlock/data + vault/reset テスト追加 (T-12/F-9)

### 判定

3専門家すべてが「前回指摘への対応は適切」と評価。
新規指摘は実装フェーズで対処可能な詳細レベルのみ。

## 最終状態: レビュー完了 (指摘なし — プランレベル)

レビューファイル: docs/temp/wobbly-doodling-pascal-review.md
