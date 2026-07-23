# Terraform (AWS) for passwd-sso

## Architecture

- **ECS Fargate** — app (Next.js) + jackson (BoxyHQ SAML Jackson)
- **ALB** — HTTPS termination, host-based routing
- **RDS PostgreSQL 16** — encrypted storage, Multi-AZ (prod)
- **ElastiCache Redis 7** — sessions/cache, replication (prod)
- **ECR** — container image repositories (app + jackson)
- **Secrets Manager** — app/Jackson secrets
- **Route53 + ACM** — DNS + TLS certificates
- **S3** — attachments storage (+ optional CloudFront CDN)

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

> **Secrets end up in Terraform state.** Any secret value passed via tfvars is
> written to `terraform.tfstate` in plaintext (see the SECURITY note in
> `secrets.tf`). Before applying with real secrets you MUST configure the
> encrypted S3 remote backend below — do not run a real deployment on local
> state. `terraform.tfvars` is gitignored; never commit real secret values.

### 2. Plan & Apply

```bash
terraform plan  -var-file=envs/dev/terraform.tfvars
terraform apply -var-file=envs/dev/terraform.tfvars
```

### 3. Push Container Images

> **Immutable tags.** Both ECR repos are `IMMUTABLE` (see `ecr.tf`) — a tag can
> be pushed once and never overwritten. Do NOT push `:latest`; use an immutable
> version tag (the repo's `vX.Y.Z` scheme) or a digest. Re-pushing an existing
> tag fails with `ImageTagAlreadyExistsException`. The ECS task definitions and
> k8s manifests must reference the exact version tag or `@sha256:` digest at
> deploy time.

```bash
# Login to ECR
aws ecr get-login-password --region ap-northeast-1 | \
  docker login --username AWS --password-stdin $(terraform output -raw ecr_app_repository_url | cut -d/ -f1)

# Build and push app with an immutable version tag (matches package.json version).
# NOTE: run from infra/terraform (for `terraform output`), but the Docker build
# CONTEXT must be the repo root (../..) — the Dockerfile lives there, not here.
VERSION=$(node -p "require('../../package.json').version")   # e.g. 0.4.71
docker build -f ../../Dockerfile \
  -t $(terraform output -raw ecr_app_repository_url):v${VERSION} \
  ../..
docker push $(terraform output -raw ecr_app_repository_url):v${VERSION}

# Push jackson (pull from Docker Hub, retag, push). jackson has no local version
# SSOT — pin to a SPECIFIC upstream boxyhq/jackson release tag (not :latest) and
# retag it under the same immutable version in ECR.
JACKSON_VERSION=1.42.0   # pick a concrete upstream release; bump deliberately
docker pull boxyhq/jackson:${JACKSON_VERSION}
docker tag boxyhq/jackson:${JACKSON_VERSION} $(terraform output -raw ecr_jackson_repository_url):v${JACKSON_VERSION}
docker push $(terraform output -raw ecr_jackson_repository_url):v${JACKSON_VERSION}
```

### 4. Force New Deployment

```bash
aws ecs update-service \
  --cluster $(terraform output -raw ecs_cluster_name) \
  --service $(terraform output -raw ecs_app_service_name) \
  --force-new-deployment
```

## Remote State Backend

State is stored locally by default. **Any deployment carrying real secrets MUST
use the encrypted S3 + DynamoDB backend** — Terraform state holds those secret
values in plaintext, so local state on a laptop or in a CI artifact is a secret
exposure. The remote backend provides at-rest encryption (`encrypt = true`),
versioning, and — via bucket policy/IAM — strict access control and access
logging.

See comments in `backend.tf` for setup steps (bucket + lock table + versioning).
Verify the bucket enforces encryption and blocks public access before migrating
state.

`terraform.tfvars` (which holds the secret values fed into state) is gitignored
and must never be committed.

## Secrets Management

`app_secrets` / `jackson_secrets` are stored as JSON in Secrets Manager.
ECS task definitions reference secrets in `{secret_arn}:KEY::` format.

### Required Secrets (app)

| Key | Description |
|-----|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_URL` | Public app URL |
| `AUTH_SECRET` | Auth.js session encryption key |
| `AUTH_GOOGLE_ID` | Google OAuth Client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth Client Secret |
| `AUTH_JACKSON_ID` | Jackson OIDC Client ID |
| `AUTH_JACKSON_SECRET` | Jackson OIDC Client Secret |
| `SHARE_MASTER_KEY` | Share links/sends encryption master key (256-bit hex) |
| `REDIS_URL` | Redis connection string |

### Required Secrets (jackson)

| Key | Description |
|-----|-------------|
| `JACKSON_API_KEYS` | Jackson API keys |
| `DB_URL` | PostgreSQL connection string |
| `NEXTAUTH_URL` | Jackson public URL |
| `EXTERNAL_URL` | Jackson external URL |
| `NEXTAUTH_SECRET` | Jackson session encryption key |

## Production Recommendations

- `db_skip_final_snapshot = false`, `db_deletion_protection = true`
- `db_multi_az = true`
- `redis_use_replication_group = true` + enable encryption/auth
- `nat_gateway_count = 2` (1 per AZ)
- `app_desired_count >= 2`
- If `create_acm_certificate = false`, set `acm_certificate_arn`
- When using CloudFront, ACM certificate must be in `us-east-1`
