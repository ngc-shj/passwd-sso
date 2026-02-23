# Terraform (AWS) for passwd-sso

## Architecture

- **ECS Fargate** — app (Next.js) + jackson (BoxyHQ SAML Jackson)
- **ALB** — HTTPS 終端、ホストヘッダルーティング
- **RDS PostgreSQL 16** — 暗号化ストレージ、Multi-AZ (prod)
- **ElastiCache Redis 7** — セッション/キャッシュ、レプリケーション (prod)
- **ECR** — コンテナイメージリポジトリ (app + jackson)
- **Secrets Manager** — アプリ/Jackson シークレット管理
- **Route53 + ACM** — DNS + SSL/TLS 証明書
- **S3** — 添付ファイルストレージ (+ optional CloudFront CDN)

## Directory Structure

```
infra/terraform/
├── network.tf          # VPC, Subnets, NAT, Security Groups
├── database.tf         # RDS PostgreSQL, ElastiCache Redis
├── storage.tf          # S3, CloudFront
├── ecs.tf              # ECS Cluster, Task Definitions, Services
├── alb.tf              # ALB, Target Groups, Listeners
├── dns.tf              # ACM Certificate, Route53 Records
├── ecr.tf              # ECR Repositories, Lifecycle Policies
├── iam.tf              # IAM Roles (execution + task)
├── secrets.tf          # Secrets Manager
├── logs.tf             # CloudWatch Log Groups
├── backend.tf          # Remote state (S3 + DynamoDB) template
├── locals.tf           # Local values
├── variables.tf        # Input variables
├── outputs.tf          # Output values
├── providers.tf        # AWS provider
├── versions.tf         # Terraform + provider version constraints
├── terraform.tfvars.example
└── envs/
    ├── dev/
    │   └── terraform.tfvars.example
    └── prod/
        └── terraform.tfvars.example
```

## Quick Start

### 1. Setup

```bash
cd infra/terraform

# Copy the example tfvars and fill in actual values
cp envs/dev/terraform.tfvars.example envs/dev/terraform.tfvars
# Edit envs/dev/terraform.tfvars with real secrets

terraform init
```

### 2. Plan & Apply

```bash
terraform plan  -var-file=envs/dev/terraform.tfvars
terraform apply -var-file=envs/dev/terraform.tfvars
```

### 3. Push Container Images

```bash
# Login to ECR
aws ecr get-login-password --region ap-northeast-1 | \
  docker login --username AWS --password-stdin $(terraform output -raw ecr_app_repository_url | cut -d/ -f1)

# Build and push app
docker build -t $(terraform output -raw ecr_app_repository_url):latest .
docker push $(terraform output -raw ecr_app_repository_url):latest

# Push jackson (pull from Docker Hub, retag, push)
docker pull boxyhq/jackson:latest
docker tag boxyhq/jackson:latest $(terraform output -raw ecr_jackson_repository_url):latest
docker push $(terraform output -raw ecr_jackson_repository_url):latest
```

### 4. Force New Deployment

```bash
aws ecs update-service \
  --cluster $(terraform output -raw ecs_cluster_name) \
  --service $(terraform output -raw ecs_app_service_name) \
  --force-new-deployment
```

## Remote State Backend

State はデフォルトでローカルに保存されます。チームで運用する場合は S3 + DynamoDB バックエンドを使用してください。

セットアップ手順は `backend.tf` のコメントを参照。

## Secrets Management

`app_secrets` / `jackson_secrets` は Secrets Manager に JSON として保存されます。
ECS タスク定義では `{secret_arn}:KEY::` 形式で個別のキーを参照しています。

### Required Secrets (app)

| Key | Description |
|-----|-------------|
| `DATABASE_URL` | PostgreSQL 接続文字列 |
| `AUTH_URL` | アプリの公開URL |
| `AUTH_SECRET` | Auth.js セッション暗号化キー |
| `AUTH_GOOGLE_ID` | Google OAuth Client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth Client Secret |
| `AUTH_JACKSON_ID` | Jackson OIDC Client ID |
| `AUTH_JACKSON_SECRET` | Jackson OIDC Client Secret |
| `SHARE_MASTER_KEY` | 組織暗号化マスターキー (256-bit hex) |
| `REDIS_URL` | Redis 接続文字列 |

### Required Secrets (jackson)

| Key | Description |
|-----|-------------|
| `JACKSON_API_KEYS` | Jackson API キー |
| `DB_URL` | PostgreSQL 接続文字列 |
| `NEXTAUTH_URL` | Jackson の公開URL |
| `EXTERNAL_URL` | Jackson の外部URL |
| `NEXTAUTH_SECRET` | Jackson セッション暗号化キー |

## Production Recommendations

- `db_skip_final_snapshot = false`, `db_deletion_protection = true`
- `db_multi_az = true`
- `redis_use_replication_group = true` + 暗号化/認証有効化
- `nat_gateway_count = 2` (AZ ごとに 1 つ)
- `app_desired_count >= 2`
- `create_acm_certificate = false` の場合は `acm_certificate_arn` を指定
- CloudFront を使う場合、証明書は `us-east-1` の ACM が必要
- 添付ファイルの暗号化を強化するには `s3_kms_key_arn` で SSE-KMS を有効化

## Security Notes

### CloudFront と添付ファイルのアクセス制御

CloudFront を有効化すると、S3 への直接アクセスは OAC で防止されますが、
CloudFront ディストリビューション自体はデフォルトで**公開**になります。

添付ファイルへのアクセスを認証済みユーザーに限定するには、以下のいずれかを検討してください:

- **CloudFront を無効化**（推奨）: `enable_cloudfront = false` のまま、アプリの API 経由で S3 に署名付き URL を発行してアクセスを制御
- **CloudFront 署名付き URL/Cookie**: CloudFront キーペアを作成し、アプリ側で署名付き URL を生成
- **Lambda@Edge**: リクエスト時にセッション Cookie を検証するカスタム認証

現在のデフォルト設定（`enable_cloudfront = false`）は最も安全です。
