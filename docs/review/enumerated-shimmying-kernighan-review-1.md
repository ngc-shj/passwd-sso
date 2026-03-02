# プランレビュー: enumerated-shimmying-kernighan (Batch D)
日時: 2026-03-01T12:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### 1. [高] S-6: signIn event で IP/UA が取得できない
- **問題**: `events.signIn` は `{ user }` のみ受取。`sessionMetaStorage.getStore()` は `createSession` アダプタ内のみ有効。signIn event は別実行コンテキストで呼ばれるため AsyncLocalStorage 未参照。
- **影響**: 新デバイス検出が常に失敗
- **推奨**: `createSession` アダプタ内でデバイス比較を行う

### 2. [高] V-6: 循環参照防止ロジックが未記載
- **問題**: parentId の自己参照で循環 (A→B→A) が発生可能。並行リクエストでの race condition も
- **影響**: tree API が無限ループ
- **推奨**: INSERT/UPDATE 時に祖先チェーン検証、`parentId != id` check constraint

### 3. [高] C-2: E2E暗号化との構造的不整合
- **問題**: team share は E2E のためサーバーがフィールドフィルタリング不可。`__permissions` はクライアントヒントでしかない
- **影響**: 権限バイパスが trivial
- **推奨**: 共有者が権限レベルに応じた reduced blob を作成→暗号化する設計に変更

### 4. [高] B-4: enforcement 挿入点の漏れ
- **問題**: export 禁止しても `GET /api/passwords` で迂回可能
- **影響**: ポリシーが形骸化
- **推奨**: advisory + クライアント側 generator defaults 連動として設計意図を明確化

### 5. [中] B-3: Webhook 配信の信頼性設計が未定義
- **問題**: at-least-once vs at-most-once、失敗検知が未定義
- **推奨**: Redis キューまたは DB テーブルベースのジョブ管理

### 6. [中] N-2: 60秒ポーリングのスケーラビリティ
- **問題**: ユーザー数 × タブ数の DB クエリ
- **推奨**: lightweight count endpoint + adaptive polling

### 7. [中] U-4 + E-6: テンプレートと Markdown の混在設計
- **問題**: encryptedBlob にテンプレート判別情報がない
- **推奨**: `templateId` と `isMarkdown` を blob に含める

### 8. [中] AuditAction enum の追加が漏れ
- **問題**: 新機能の audit action が plan に未記載
- **推奨**: POLICY_UPDATE, WEBHOOK_DELIVERY_FAILED 等を追加

### 9. [低] RLS の migration SQL が省略されている
### 10. [低] Tag unique constraint 変更時の既存コード参照箇所

## セキュリティ観点の指摘

### 1. [高] C-2: クライアントサイドマスキングは権限制御として機能しない (機能#3と同一)
### 2. [高] S-6: UA偽装によるバイパス
- **推奨**: 「一致確認できない場合は通知」方向に調整

### 3. [高] B-3: secretHash では HMAC 計算不可
- **問題**: SHA-256 ハッシュからは元のシークレットを復元不可
- **推奨**: AES-256-GCM でマスターキー暗号化して保存

### 4. [中] N-2: 通知 body への情報漏洩リスク
- **推奨**: E2E 暗号化エントリ情報は通知に含めない設計ルール

### 5. [中] B-3: 監査ログダウンロードのレート制限欠如
### 6. [中] B-4: advisory ポリシーの一貫性
### 7. [中] V-6: DB レベルの depth 制約なし
### 8. [低] N-2: 複数タブでの rate limit 設計
### 9. [低] S-6: 初回ログインスキップの race condition
### 10. [低] B-3: リトライ失敗の可観測性

## テスト観点の指摘

### 1. [高] S-6: auth events 統合テスト欠如
### 2. [高] B-3: ストリーミングレスポンス検証ヘルパー不足
### 3. [高] B-3: Webhook dispatcher テスト (fake timers 必要)
### 4. [高] V-6: partial index の NULL parentId 制約がモックで再現不可
### 5. [高] N-2: Bell icon コンポーネントテスト欠如
### 6. [中] C-2: server-side filtering と E2E blob の 2 経路テスト
### 7. [中] B-4: enforcement テストが別 API に必要
### 8. [中] E-6: XSS 耐性テストケース
### 9. [中] CI coverage.include に新規 lib ファイル追加
### 10. [低] U-4: テンプレート一意性テストの堅牢性
