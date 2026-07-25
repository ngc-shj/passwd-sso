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

### 2. First-time bootstrap (NEW environment)

Bootstrapping a brand-new AWS environment has real ordering constraints that a
single `terraform apply` cannot satisfy on its own:

- The connection-string secrets (`DATABASE_URL`, `MIGRATION_DATABASE_URL`,
  `REDIS_URL`, the worker DB URLs) can only be built AFTER RDS/Redis exist and
  their endpoints + the AWS-managed RDS master password are known.
- **RDS does NOT run the `infra/postgres/initdb/*.sql` scripts** (those are for
  the Docker Postgres image only), so the least-privilege roles — `passwd_app`,
  `passwd_outbox_worker`, `passwd_retention_gc_worker` — must be created manually
  on RDS. `passwd_app` must exist BEFORE `prisma migrate deploy`, because some
  migrations conditionally GRANT/REVOKE privileges to it.
- The app/worker services start their tasks as soon as they exist, so their
  secrets and roles must be ready first.

Phased bootstrap (services start only in the last phase):

```bash
TFV="-var-file=envs/prod/terraform.tfvars"

# Phase A — network + data stores + registries + empty secret containers.
#   `desired_count = 0` for app/jackson (see terraform.tfvars) so no service task
#   starts yet; the workers default to 1 but are created in Phase D.
terraform apply $TFV \
  -target=aws_vpc.main -target=aws_nat_gateway.main \
  -target=aws_db_instance.main -target=aws_elasticache_replication_group.main \
  -target=aws_ecr_repository.app -target=aws_ecr_repository.jackson \
  -target=aws_secretsmanager_secret.app -target=aws_secretsmanager_secret.jackson

# Phase B — read the RDS master password + endpoints.
MASTER_ARN=$(terraform output -raw db_master_user_secret_arn)
DB_HOST=$(terraform output -raw db_endpoint)
REDIS_HOST=$(terraform output -raw redis_endpoint)
MASTER_PW=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" \
  --query SecretString --output text | jq -r .password)

# Phase C — create the DB roles on RDS as the master user (psql), BEFORE migration:
#   CREATE ROLE passwd_app                 LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '…';
#   CREATE ROLE passwd_outbox_worker       LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '…';
#   CREATE ROLE passwd_retention_gc_worker LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '…';
#   (mirror the GRANTs in infra/postgres/initdb/02-04*.sql for each role.)

# Push the image (step 3), then inject ALL secret values built from the above:
#   app-secrets.json: DATABASE_URL (passwd_app@$DB_HOST), MIGRATION_DATABASE_URL
#   (master@$DB_HOST), REDIS_URL ($REDIS_HOST), OUTBOX_WORKER_DATABASE_URL,
#   RETENTION_GC_DATABASE_URL, plus the app secrets (AUTH_*, SHARE_MASTER_KEY,
#   SESSION_TOKEN_HMAC_KEY, …).
scripts/put-terraform-secrets.sh --name-prefix passwd-sso-prod \
  --app-file ./app-secrets.json --jackson-file ./jackson-secrets.json

# Phase D — full apply (registers task defs; workers/app start now). Then run the
# migration + advance services with the SAME script used for steady state:
terraform apply $TFV
AWS_REGION=<region> ECR_URL=<app-ecr-url> TF_VAR_FILE=envs/prod/terraform.tfvars \
  ./scripts/deploy.sh
# (set app_desired_count/jackson_desired_count back to their steady values in
#  tfvars before this apply if you set them to 0 in Phase A.)
```

Steady-state deploys (environment already bootstrapped) are a single
`./scripts/deploy.sh` — see docs/operations/deployment.md.

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

### 4. Deploy a new image version

The ECS services track their task definitions (no `ignore_changes` on
`task_definition`), so a deploy is just an image-tag bump + apply:

```bash
# Point app_image at the new immutable tag (e.g. in terraform.tfvars):
#   app_image = "<ACCOUNT>.dkr.ecr.<region>.amazonaws.com/...-app:v0.4.72"
terraform apply
```

`terraform apply` registers a NEW task-definition revision referencing the new
tag and updates ALL services that use that image — app, migrate (task def only),
and BOTH workers (audit-outbox + retention-gc) — to the new revision.

> Do NOT use `aws ecs update-service --force-new-deployment` for a version bump:
> it only restarts tasks on the SAME task definition (same old image), so it
> would redeploy the previous version. `--force-new-deployment` is only for
> same-tag content changes, which this repo's IMMUTABLE tags disallow anyway.

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

`terraform.tfvars` is gitignored and must never be committed. As of the 2026-07
review (F3) it no longer carries secret values — those are injected out-of-band
(see Secrets Management below).

## Secrets Management

App/Jackson secret VALUES are **not** managed by Terraform and never enter state
(2026-07 review, F3). Terraform creates only the empty Secrets Manager CONTAINERS
(`secrets.tf`); the values are injected out-of-band with `put-terraform-secrets.sh`
using JSON files that are never committed. On a NEW environment this happens
during bootstrap Phase C (after RDS/Redis exist and the roles are created, before
the services start in Phase D) — see "First-time bootstrap" above. The RDS master
password is AWS-managed (`manage_master_user_password`) so it is not in state
either.

> **Exception:** the ElastiCache Redis `auth_token`, when configured, DOES enter
> Terraform state — ElastiCache has no AWS-managed-token equivalent. The
> encrypted remote backend + strict IAM (backend.tf) are the operative controls;
> the token is rotatable out-of-band (`ignore_changes = [auth_token]`). Treat
> state as sensitive accordingly.

```bash
# app-secrets.json / jackson-secrets.json: JSON objects of the keys below
# (mode 0600, deleted after injection — never committed).
scripts/put-terraform-secrets.sh \
  --name-prefix passwd-sso-prod \
  --app-file ./app-secrets.json \
  --jackson-file ./jackson-secrets.json
```

An empty secret makes the ECS task fail to launch, so run the script before
bringing services up. ECS task definitions reference secrets in
`{secret_arn}:KEY::` format, resolving against whatever value the script wrote.

### Required Secrets (app)

| Key | Description |
|-----|-------------|
| `DATABASE_URL` | PostgreSQL connection string (app role, NOSUPERUSER) |
| `MIGRATION_DATABASE_URL` | SUPERUSER connection string used by the migrate task (`prisma migrate deploy` DDL). Read the RDS master password from `db_master_user_secret_arn`. |
| `AUTH_URL` | Public app URL |
| `AUTH_SECRET` | Auth.js session encryption key |
| `AUTH_GOOGLE_ID` | Google OAuth Client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth Client Secret |
| `AUTH_JACKSON_ID` | Jackson OIDC Client ID |
| `AUTH_JACKSON_SECRET` | Jackson OIDC Client Secret |
| `SHARE_MASTER_KEY` | Share links/sends encryption master key (256-bit hex) |
| `SESSION_TOKEN_HMAC_KEY` | Session-token HMAC key (256-bit hex). **Required in production** (env validation + runtime fail closed). Decouples session auth from master-key rotation. Mapped into the app ECS task. Generate with `npm run generate:key`. |
| `REDIS_URL` | Redis connection string |
| `OUTBOX_WORKER_DATABASE_URL` | Least-privilege DB URL for the audit-outbox-worker ECS service (`passwd_outbox_worker` role) |
| `RETENTION_GC_DATABASE_URL` | Least-privilege DB URL for the retention-gc-worker ECS service (`passwd_retention_gc_worker` role) |

Both background workers run as dedicated ECS services (`*-audit-outbox-worker`,
`*-retention-gc-worker`) on the app image (`node dist/<worker>.js`),
`desired_count = 1`, no load balancer. ECS restarts a crashed task automatically.
Liveness is alarmed via `RunningTaskCount < 1` (Container Insights) — see
monitoring.tf. Without these workers, audit events stay PENDING and retention is
never enforced, so the worker DB URLs above MUST be populated before apply.

> **Rotating `SESSION_TOKEN_HMAC_KEY`.** The session-token DB digest and the
> Redis session-cache key are both derived from this key, so changing it changes
> every digest → INVALIDATES ALL SESSIONS (every user re-authenticates). Purge AT
> the cutover, not after: (1) put the new value, (2) `DELETE FROM sessions` +
> flush the Redis session keyspace, (3) redeploy. Old-key digests can never match
> the new key, so pre-cutover sessions are dead regardless; purging before the
> redeploy avoids deleting sessions that new (post-cutover) code would create.

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
