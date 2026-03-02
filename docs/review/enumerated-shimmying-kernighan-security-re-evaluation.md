# セキュリティレビュー: enumerated-shimmying-kernighan (更新済みプラン再評価)

日時: 2026-03-01
レビュー種別: 前回指摘と対応状況の再評価 + 新規指摘抽出

---

## 前回からの変更 (対応状況確認)

### 対応済み指摘

以下の指摘は前回のレビューで指摘され、プランに対応が明記されています:

1. **[高] C-2 クライアントマスキング** → reduced blob方式に変更予定
   - プラン Step 8 で実装予定
   - 現状: 実装未了

2. **[高] S-6 UA偽装バイパス** → checkNewDeviceAndNotify への移動
   - プラン Step 6 で実装予定
   - 現状: 実装未了
   - `src/lib/auth-adapter.ts` の `createSession` には未統合

3. **[高] B-3 secretHash では HMAC 不可** → secretEncrypted(AES-256-GCM)への変更
   - プラン Step 7 (Sub-feature B) で実装予定
   - 現状: 実装未了（TeamWebhook モデル自体が未作成）

4. **[中] N-2 通知bodyへの情報漏洩** → 設計ルール明記
   - プラン Step 1 で実装予定
   - 現状: 実装未了（Notification モデル未作成）

5. **[中] B-3 ダウンロードレート制限** → createRateLimiter実装
   - プラン Step 7 (Sub-feature A) で実装予定
   - 現状: 実装未了（audit-logs/download ルート未作成）

6. **[中] B-4 advisory ポリシーの一貫性** → 設計意図の明確化
   - プラン Step 2 で実装予定
   - 現状: 実装未了（TeamPolicy モデル未作成）

7. **[中] V-6 DB レベル depth 制約** → CHECK + API validateParentChain
   - プラン Step 5 で実装予定
   - 現状: 実装未了（Folder.parentId 既存、但し制約未設定）

8. **[低] N-2 複数タブ rate limit** → /api/notifications/count 軽量 endpoint
   - プラン Step 1 で実装予定
   - 現状: 実装未了

9. **[低] S-6 初回ログインスキップ race condition** → createSession内に移動
   - プラン Step 6 で実装予定
   - 現状: 実装未了

10. **[低] B-3 リトライ失敗の可観測性** → WEBHOOK_DELIVERY_FAILED audit action
    - プラン Step 7 で実装予定
    - 現状: 実装未了

---

## セキュリティ観点の新規指摘

### 1. [高] AuditAction enum に計画の新 action が未追加

- **問題**: プランで定義される新規 audit action（`POLICY_UPDATE`, `AUDIT_LOG_DOWNLOAD`, `WEBHOOK_CREATE`, `WEBHOOK_DELETE`, `WEBHOOK_DELIVERY_FAILED`）が `prisma/schema.prisma` の `AuditAction` enum および `src/lib/constants/audit.ts` に未追加。
- **ファイル**:
  - `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/prisma/schema.prisma` (行 652-710)
  - `src/lib/constants/audit.ts` (存在確認必要)
- **重要度**: 中
- **影響**: プラン実装時に migration が必要だが、enum 定義遅延によりコード準備が遅れる。B-3/B-4/C-2 ステップのテストが enum 定義に依存。
- **推奨対応**:
  - `schema.prisma` の `AuditAction` enum に以下を追加:
    ```prisma
    POLICY_UPDATE
    AUDIT_LOG_DOWNLOAD
    WEBHOOK_CREATE
    WEBHOOK_DELETE
    WEBHOOK_DELIVERY_FAILED
    ```
  - 対応する constants ファイルを更新
  - migration は不要（enum の追加は backward compatible）ただし、prisma generate 実行後に既存コードの型チェックを実施

---

### 2. [高] createSession内に新デバイス検出ロジックが未統合

- **問題**: プラン Step 6（S-6）では `checkNewDeviceAndNotify(userId, meta)` を `src/lib/auth-adapter.ts` の `createSession` 内で呼び出すことが明記されているが、実装されていない。前回レビューで「signIn event では sessionMetaStorage にアクセス不可」と指摘された問題は解決されていない。
- **ファイル**: `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/src/lib/auth-adapter.ts` (行 106-130)
- **重要度**: 高
- **影響**: 新デバイスログイン検出が動作しない。セキュリティアラート機能が未実装。
- **推奨対応**:
  1. `src/lib/new-device-detection.ts` を新規作成し `checkNewDeviceAndNotify()` を実装（プラン Step 6 参照）
  2. `createSession` 内の行 123 の後に以下を追加:
     ```typescript
     // Fire-and-forget device detection (do not block auth flow)
     void checkNewDeviceAndNotify(session.userId, {
       ip: meta?.ip ?? null,
       userAgent: meta?.userAgent ?? null,
     }).catch(() => {});
     ```
  3. テスト: `src/__tests__/auth-adapter-device.test.ts` で検証

---

### 3. [中] 共有権限 (C-2) の reduced blob 実装方針が実装状現と乖離

- **問題**: プラン Step 8 で「共有者がクライアント側でreduced blobを作成してから暗号化」と記載されているが、現在のコードでは Team password の共有機能そのものが確認できない。Personal share（PasswordShare）モデルは存在するが、Team password への reduced blob 適用設計が未実装。
- **ファイル**:
  - `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/prisma/schema.prisma` (PasswordShare モデル行 587-632)
  - 共有コンポーネント: `src/components/share/share-dialog.tsx` など
- **重要度**: 中
- **影響**: チーム内での権限制御付き共有が実装されないと、全メンバーが全フィールドを閲覧可能。sensitive な権限制御が形骸化する可能性。
- **推奨対応**:
  - Step 8 実装時に `PasswordShare` に `permissions` フィールドを追加（プラン行 381）
  - Team E2E 共有時の blob フィルタリングロジックをクライアント側に実装
  - テスト: `src/app/api/share-links/route.test.ts` に permissions 関連ケースを追加

---

### 4. [中] Webhook 設計（B-3）で secret 暗号化の key versioning が明確でない

- **問題**: プラン Step 7 では `secretEncrypted`, `secretIv`, `secretAuthTag`, `masterKeyVersion` で secret を保管すると記載されている。`masterKeyVersion` を記録する意図は「将来的なマスターキーローテーション対応」だが、配信時の復号処理で key version の選択ロジックが明確でない。マスターキーローテーション後に古い webhook が解読できなくなる可能性がある。
- **ファイル**:
  - プラン行 321-349（TeamWebhook schema）
  - 実装予定: `src/lib/webhook-dispatcher.ts`
- **重要度**: 中
- **影響**: マスターキーローテーション後の webhook 配信失敗。古い secret を復号できず HMAC 署名検証が失敗。
- **推奨対応**:
  1. `webhook-dispatcher.ts` の secret 復号処理で `masterKeyVersion` を参照し、対応するマスターキーで復号
  2. ローテーション時に古いバージョンのマスターキーを一定期間保持（キー管理方針に従う）
  3. 復号失敗時のエラーハンドリング: `lastError` に記録、`failCount` をインクリメント
  4. テスト: `src/lib/webhook-dispatcher.test.ts` で複数 key version での復号を検証

---

### 5. [中] 通知データへのメタデータ漏洩防止メカニズムが未実装

- **問題**: プラン Step 1 で「`metadata` も同等のブロックリスト検査を適用」と記載されているが、METADATA_BLOCKLIST が既存コードに定義されているか確認できない。N-2 Notification モデルの `metadata` フィールドが任意の JSON を許可するため、AUDIT_LOG_DOWNLOAD などのクリティカルなアクションをトリガーとして通知を生成する際に PII/sensitive データが混入するリスクがある。
- **ファイル**:
  - `src/lib/notification.ts` (実装予定)
  - `src/lib/constants/audit.ts`（METADATA_BLOCKLIST 確認）
- **重要度**: 中
- **影響**: audit log download など機密アクション実行時に通知が生成される場合、notification の metadata に意図しないデータが含まれる可能性。ユーザーが通知一覧を読む際に PII 露出。
- **推奨対応**:
  1. `src/lib/constants/audit.ts` に `METADATA_BLOCKLIST` を定義（既存なら拡張）:
     ```typescript
     const METADATA_BLOCKLIST = {
       ENTRY_EXPORT: ['decrypted_data'],
       AUDIT_LOG_DOWNLOAD: ['all'],
       VAULT_RESET_EXECUTED: ['recovery_key'],
       // ...
     };
     ```
  2. `createNotification()` 内で metadata を受け取る際にホワイトリストで検査
  3. テスト: 敏感な action でも metadata は null または安全な内容のみであることを検証

---

### 6. [中] 共有リンク閲覧時の rate limit とレートリミット突破リスク

- **問題**: PasswordShare（及び TeamPasswordEntry 共有）の public view endpoints では rate limit が実装されていない模様。DDoS や brute force attack に対する防御がない。Public endpoint のため認証が不要で、複数 IP からの攻撃は防ぎにくい。
- **ファイル**:
  - `src/app/api/share-links/[id]/route.ts`（確認必要）
- **重要度**: 中
- **影響**: 有効期限付きまたは maxViews 制限がある共有リンクでも、高頻度なリクエストで DB 負荷増加。攻撃者による共有リンクの総当たり試験。
- **推奨対応**:
  1. 共有リンク view endpoint に rate limit 追加（例: IP あたり 10 req/min）
  2. viewCount を確認し maxViews 超過時に即座に 410 Gone を返す
  3. アクセスログ（ShareAccessLog）に suspicious なパターン（短時間での大量アクセス）を検出する監視ロジックを検討

---

### 7. [低] Folder の循環参照制約が DB レベルでのみ設定される可能性

- **問題**: プラン Step 5 では Folder と TeamFolder に対して `CHECK ("parent_id" != "id")` で自己参照を禁止するとあるが、同時に「API レベルで祖先チェーンを再帰的に走査」と記載。実装前に確認が必要な点は、複数ステップでのカスケード更新（A→B→C→A のような循環）が INSERT 時に検出されるか。並行リクエストでの race condition。
- **ファイル**:
  - `src/lib/tag-tree.ts`（実装予定）
  - `src/app/api/tags/route.ts`（実装予定）
  - Folder モデル: `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/prisma/schema.prisma` (行 835-855)
- **重要度**: 低
- **影響**: プラン実装時の設計リスク。DB 制約だけでは複雑な循環（depth > 2）検出に不十分。API validation で補完必須。
- **推奨対応**:
  1. Tag/TeamFolder/Folder の parentId 更新は必ず validateParentChain() を通す
  2. visited set + visited size limit で無限ループと depth 超過を同時に検出
  3. テスト: 並行リクエスト（2 つの PUT が同時に A.parentId=B, B.parentId=A を試行）でも transaction で serialize されることを確認

---

## テスト観点の指摘

### T-1 [中] Batch D ステップの統合テストが欠落している可能性

- **問題**: 各 Step（N-2, B-4, U-4 等）は個別のユニットテストが計画されているが、Step 間の相互作用テストが欠落している。例えば、B-4（Policy）で `allowExport=false` 時に N-2（Notification）で download denied event を適切に記録するか。S-6（新デバイス検出）が N-2（Notification）を生成するか。
- **重要度**: 中
- **推奨対応**:
  1. 統合テストの計画を策定（各 Step の最後に "integration test" サイクルを追加）
  2. 例: `src/__tests__/integration/batch-d-end-to-end.test.ts`
  3. シナリオ例: Policy deny export → audit log download attempt → audit log 記録 + notification 생成 → N-2 API で확인

---

## その他の観点

### Vault セキュリティ (新規確認不要)

前回レビュー「enumerated-shimmying-kernighan-review-1.md」で指摘された Vault 関連の高優先度指摘は、本評価スコープ外。Batch D 計画に直接影響しないため言及しない。ただし、Batch D 完了後に後続レビューが必要。

---

## 指摘サマリ

| # | 指摘ID | 重要度 | ステータス | 詳細 |
|---|--------|--------|-----------|------|
| 1 | SEC-BD-001 | 高 | 新規 | AuditAction enum に計画の新 action 未追加 |
| 2 | SEC-BD-002 | 高 | 新規 | createSession 内に checkNewDeviceAndNotify 未統合 |
| 3 | SEC-BD-003 | 中 | 新規 | C-2 reduced blob 実装方針が実装状況と乖離 |
| 4 | SEC-BD-004 | 中 | 新規 | Webhook secret 暗号化の key versioning ロジック不明確 |
| 5 | SEC-BD-005 | 中 | 新規 | 通知データのメタデータ漏洩防止メカニズム未実装 |
| 6 | SEC-BD-006 | 中 | 新規 | 共有リンク public view の rate limit 欠落 |
| 7 | SEC-BD-007 | 低 | 新規 | Folder 循環参照制約の並行実行リスク |
| — | T-1 | 中 | 新規 | Batch D ステップ間の統合テスト欠落 |

---

## 対応スケジュール推奨

1. **実装前 (即座)**: SEC-BD-001 (enum 定義), SEC-BD-002 (createSession 統合), SEC-BD-005 (blocklist 定義)
2. **Step 実装時**: SEC-BD-003, SEC-BD-004, SEC-BD-007 を各 Step の設計フェーズで処理
3. **全 Step 完了後**: T-1（統合テスト）, SEC-BD-006 (rate limit 追加)

---

## まとめ

前回指摘の対応はプランに明記されているが、**実装は未着手**。本評価で新たに **7 件の指摘**（高 2 件、中 4 件、低 1 件）を抽出した。最も重要な指摘は **SEC-BD-001**（enum 定義遅延）と **SEC-BD-002**（createSession 未統合）で、これらは Batch D 実装の前提条件であるため、プラン開始前に対応が必須。

その他の指摘も実装フェーズで順次対応することで、セキュリティと可観測性の両立が可能。
