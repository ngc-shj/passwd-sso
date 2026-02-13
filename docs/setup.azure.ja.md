# passwd-sso Azure セットアップ (Container Apps/AKS + PostgreSQL + Redis)

本ガイドは Azure 上での本番向け構成例です。

## 推奨サービス

- アプリ実行基盤: Azure Container Apps または AKS
- データベース: Azure Database for PostgreSQL (Flexible Server)
- キャッシュ: Azure Cache for Redis
- シークレット管理: Azure Key Vault
- 添付ファイル保存 (任意): Azure Blob Storage

## 必須アプリ設定

- `DATABASE_URL`
- `AUTH_SECRET`
- `AUTH_URL`
- `ORG_MASTER_KEY`
- `REDIS_URL`
- `BLOB_BACKEND`

`BLOB_BACKEND=azure` の場合:
- `AZURE_STORAGE_ACCOUNT`
- `AZURE_BLOB_CONTAINER`
- 次のいずれか:
  - `AZURE_STORAGE_CONNECTION_STRING`
  - `AZURE_STORAGE_SAS_TOKEN`

任意:
- `BLOB_OBJECT_PREFIX`（オブジェクトキー接頭辞）

## Blob 保存設計 (添付ファイル)

- 添付ファイルの暗号化済みバイナリは Blob Storage に保存します。
- DB にはメタデータとオブジェクト参照のみ保存します。
- コンテナは private（匿名公開なし）で運用します。
- 必要に応じてライフサイクルポリシーで古いオブジェクトを整理します。

## ID/権限設計

- ランタイムは Managed Identity を推奨します。
- Blob に必要な最小権限:
  - 読み取り
  - 書き込み
  - 削除
- 権限スコープは添付ファイル専用コンテナに限定します。

## 運用時の確認

1. Key Vault からシークレット取得できること。
2. 接続確認:
   - App -> PostgreSQL
   - App -> Redis
   - App -> Blob Storage
3. API 経由で添付ファイルの upload/download/delete が成功すること。
4. ログに平文の添付データが出ないこと。

## セキュリティ注意点

- `BLOB_BACKEND` や資格情報は必ずシークレット管理へ保存してください。
- PostgreSQL/Redis/Blob の通信は TLS を有効化してください。
- ストレージ資格情報や SAS は定期ローテーションしてください。
