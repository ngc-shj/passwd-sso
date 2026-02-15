# passwd-sso AWS セットアップ (ECS/Fargate + RDS)

本ガイドは本番向けの AWS 構成例です:
- App: ECS/Fargate (Next.js)
- DB: Amazon RDS for PostgreSQL
- Cache: Amazon ElastiCache for Redis
- SSO ブリッジ: SAML Jackson (ECS/Fargate)
- Secrets: AWS Secrets Manager

## 構成

- `app` サービス (Next.js)
- `jackson` サービス (SAML Jackson)
- `db` は RDS (PostgreSQL)
- `redis` は ElastiCache (Redis)

## システム構成図 (AA)

```
              +----------------------+
              |   Users / Clients    |
              +----------+-----------+
                         |
                         v
                 +---------------+
                 |  ALB (HTTPS)  |
                 +-------+-------+
                         |
            +------------+-------------+
            |                          |
            v                          v
   +-----------------+       +-----------------+
   |  app (Next.js)  |       | jackson (SAML)  |
   |  ECS/Fargate    |       | ECS/Fargate     |
   +--------+--------+       +--------+--------+
            |                         |
            |                         |
            v                         v
   +-----------------+       +-----------------+
   | RDS (Postgres)  |<------+ RDS (Postgres)  |
   +-----------------+       +-----------------+
            |
            v
   +-----------------+
   | ElastiCache     |
   | (Redis)         |
   +-----------------+

   +-----------------+
   | Secrets Manager |
   +--------+--------+
            |
            v
     (Task env vars)
```

## 前提

- VPC とサブネットを作成済み
- ECS クラスタ (Fargate)
- RDS PostgreSQL
- ElastiCache Redis
- Secrets Manager
- 公開する場合は ALB を使用

## シークレット

Secrets Manager に保存:
- `DATABASE_URL`
- `AUTH_SECRET`
- `AUTH_GOOGLE_ID`
- `AUTH_GOOGLE_SECRET`
- `AUTH_JACKSON_ID`
- `AUTH_JACKSON_SECRET`
- `ORG_MASTER_KEY`
- `REDIS_URL`
- `BLOB_BACKEND`

任意:
- `GOOGLE_WORKSPACE_DOMAIN`
- `SAML_PROVIDER_NAME`
- `AWS_REGION`, `S3_ATTACHMENTS_BUCKET`（`BLOB_BACKEND=s3` の場合）
- `AZURE_STORAGE_ACCOUNT`, `AZURE_BLOB_CONTAINER`（`BLOB_BACKEND=azure` の場合）
- `GCS_ATTACHMENTS_BUCKET`（`BLOB_BACKEND=gcs` の場合）
- `HEALTH_REDIS_REQUIRED=true`（Redis 障害時にヘルスチェックを fail にする場合）

生成:
```
openssl rand -base64 32  # AUTH_SECRET
openssl rand -hex 32     # ORG_MASTER_KEY
```

## RDS (PostgreSQL)

- PostgreSQL 16 を推奨
- バックアップや Multi-AZ は要件に合わせて設定
- `DATABASE_URL` 例:
```
postgresql://USER:PASSWORD@HOST:PORT/DBNAME
```

## ECS/Fargate サービス

### app サービス

環境変数:
- `DATABASE_URL` (RDS)
- `AUTH_URL` (アプリの公開 URL)
- `AUTH_SECRET`
- `AUTH_GOOGLE_ID`
- `AUTH_GOOGLE_SECRET`
- `GOOGLE_WORKSPACE_DOMAIN` (任意)
- `JACKSON_URL` (内部 or 公開 URL)
- `AUTH_JACKSON_ID`
- `AUTH_JACKSON_SECRET`
- `SAML_PROVIDER_NAME`
- `ORG_MASTER_KEY`
- `REDIS_URL`
- `BLOB_BACKEND`
- `AWS_REGION`, `S3_ATTACHMENTS_BUCKET`（`BLOB_BACKEND=s3` の場合は必須）
- `AZURE_STORAGE_ACCOUNT`, `AZURE_BLOB_CONTAINER`（`BLOB_BACKEND=azure` の場合は必須）
- `GCS_ATTACHMENTS_BUCKET`（`BLOB_BACKEND=gcs` の場合は必須）

### jackson サービス

環境変数 (例):
- `JACKSON_API_KEYS`
- `DB_ENGINE=sql`
- `DB_TYPE=postgres`
- `DB_URL` (RDS)
- `NEXTAUTH_URL` (jackson の公開 URL)
- `EXTERNAL_URL` (jackson の公開 URL)
- `NEXTAUTH_SECRET` (AUTH_SECRET と同一)
- `NEXTAUTH_ACL=*`

## マイグレーション

一時タスクで実行:
```
npx prisma migrate deploy
```

## ヘルスチェック

| エンドポイント | 目的 | 用途 |
|---|---|---|
| `GET /api/health/live` | Liveness（プロセス生存確認） | ECS コンテナヘルスチェック |
| `GET /api/health/ready` | Readiness（DB + Redis 接続確認） | ALB ターゲットグループ |

- ALB ターゲットグループのヘルスチェックパスは `/api/health/ready` に設定
- ECS タスク定義のコンテナヘルスチェックは `/api/health/live` を使用
- `HEALTH_REDIS_REQUIRED=true` で Redis 障害時に 503 を返す（デフォルトは degraded 200）

## 監視・アラート

Terraform (`infra/terraform/monitoring.tf`) で以下を定義:

- **CloudWatch メトリクスフィルタ**: 5xx エラー、ヘルスチェック失敗、高レイテンシ
- **CloudWatch アラーム**: ALB 5xx、ヘルスチェック失敗、Unhealthy ホスト、高レイテンシ
- **EventBridge**: ECS タスク停止検知
- **SNS トピック**: アラーム通知（メール等）

`enable_monitoring = true` で有効化、`alarm_email` でメール通知先を設定。

## デプロイ順序

⚠️ ヘルスチェック導入時はアプリコードを先にデプロイし、その後 Terraform apply を実行すること。
逆にすると ALB が `/api/health/ready` にアクセスできず、全ターゲットを unhealthy と判定する。

## 補足

- ALB + HTTPS (ACM 証明書) を推奨
- `jackson` は可能ならアクセス制限
- Redis は RDS とは別の ElastiCache クラスタで運用
- シークレットはタスク定義/コードに埋め込まない
