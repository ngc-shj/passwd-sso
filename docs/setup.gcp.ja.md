# passwd-sso GCP セットアップ (Cloud Run/GKE + Cloud SQL + Memorystore)

本ガイドは GCP 上での本番向け構成例です。

## 推奨サービス

- アプリ実行基盤: Cloud Run または GKE
- データベース: Cloud SQL for PostgreSQL
- キャッシュ: Memorystore for Redis
- シークレット管理: Secret Manager
- 添付ファイル保存 (任意): Cloud Storage (GCS)

## 必須アプリ設定

- `DATABASE_URL`
- `AUTH_SECRET`
- `AUTH_URL`
- `ORG_MASTER_KEY`
- `REDIS_URL`
- `BLOB_BACKEND`

`BLOB_BACKEND=gcs` の場合:
- `GCS_ATTACHMENTS_BUCKET`

任意:
- `BLOB_OBJECT_PREFIX`（オブジェクトキー接頭辞）

## オブジェクト保存設計 (添付ファイル)

- 添付ファイルの暗号化済みバイナリは GCS に保存します。
- DB にはメタデータとオブジェクト参照のみ保存します。
- バケットは private（公開アクセス禁止）で運用します。
- 運用要件に応じてライフサイクル/保持ポリシーを設定します。

## ID/権限設計

- Workload Identity（または同等のサービスアカウント連携）を推奨します。
- Storage に必要な最小権限:
  - オブジェクト読み取り
  - オブジェクト作成/更新
  - オブジェクト削除
- 権限は添付ファイル専用バケットに限定します。

## 運用時の確認

1. Secret Manager からシークレット取得できること。
2. 接続確認:
   - App -> Cloud SQL
   - App -> Memorystore
   - App -> GCS
3. API 経由で添付ファイルの upload/download/delete が成功すること。
4. ログに平文の添付データが出ないこと。

## セキュリティ注意点

- 資格情報はソースコードに含めないでください。
- 可能な範囲で TLS を必須化してください。
- サービスアカウント鍵を使う場合は定期ローテーションしてください（可能なら鍵レス運用を推奨）。
