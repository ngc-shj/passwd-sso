# passwd-sso AWS Setup (ECS/Fargate + RDS)

This guide describes a production-oriented AWS deployment:
- App: ECS/Fargate (Next.js)
- DB: Amazon RDS for PostgreSQL
- Cache: Amazon ElastiCache for Redis
- SSO bridge: SAML Jackson on ECS/Fargate
- Secrets: AWS Secrets Manager

## Architecture

- `app` service (Next.js)
- `jackson` service (SAML Jackson)
- `db` as RDS (PostgreSQL)
- `redis` as ElastiCache (Redis)
- `audit-outbox-worker` (separate ECS service or sidecar in app task)

## System Architecture (ASCII)

```mermaid
flowchart TB
    Users["Users / Clients"] --> ALB["ALB (HTTPS)"]
    ALB --> App["app (Next.js)<br/>ECS/Fargate"]
    ALB --> Jackson["jackson (SAML)<br/>ECS/Fargate"]

    App --> RDS["RDS (PostgreSQL)"]
    Jackson --> RDS
    App --> Redis["ElastiCache (Redis)"]

    Worker["audit-outbox-worker<br/>ECS/Fargate (separate service)"] --> RDS
    Worker -.-> |drains audit_outbox<br/>→ audit_logs| RDS

    Secrets["Secrets Manager"] -.-> |Task env vars| App
    Secrets -.-> |Task env vars| Jackson
    Secrets -.-> |Task env vars| Worker
```

> **Note**: The `audit-outbox-worker` is a long-running process that drains pending rows from `audit_outbox` into `audit_logs`. Without it, audit events silently accumulate as `PENDING` and never reach `audit_logs`. Deploy it as a dedicated ECS/Fargate service (or a sidecar container in the app task) with `OUTBOX_WORKER_DATABASE_URL` pointing to the `passwd_outbox_worker` DB role.

## Prerequisites

- AWS account with VPC and subnets
- ECS cluster (Fargate)
- RDS PostgreSQL instance
- ElastiCache Redis cluster
- Secrets Manager
- Load Balancer (ALB) for `app` and `jackson` if public

## Secrets

Store these in Secrets Manager:
- `DATABASE_URL` (app role `passwd_app`)
- `MIGRATION_DATABASE_URL` (SUPERUSER role `passwd_user` — used for `prisma migrate deploy` only)
- `OUTBOX_WORKER_DATABASE_URL` (least-privilege role `passwd_outbox_worker` — used by audit-outbox-worker)
- `AUTH_SECRET`
- `AUTH_GOOGLE_ID`
- `AUTH_GOOGLE_SECRET`
- `AUTH_JACKSON_ID`
- `AUTH_JACKSON_SECRET`
- `SHARE_MASTER_KEY`
- `REDIS_URL` (REQUIRED in production — see [Redis](#app-service))
- `BLOB_BACKEND`
- `JACKSON_API_KEY` (passed to the Jackson container as `JACKSON_API_KEYS` — note the trailing `S`)
- `PASSWD_OUTBOX_WORKER_PASSWORD` (sets the `passwd_outbox_worker` DB role password; use `scripts/set-outbox-worker-password.sh` to rotate)

Optional:
- `GOOGLE_WORKSPACE_DOMAINS`
- `SAML_PROVIDER_NAME`
- `AWS_REGION`, `S3_ATTACHMENTS_BUCKET` (when `BLOB_BACKEND=s3`)
- `AZURE_STORAGE_ACCOUNT`, `AZURE_BLOB_CONTAINER` (when `BLOB_BACKEND=azure`)
- `GCS_ATTACHMENTS_BUCKET` (when `BLOB_BACKEND=gcs`)
- `HEALTH_REDIS_REQUIRED=true` (fail health check when Redis is down)
- `KEY_PROVIDER=aws-sm` (use AWS Secrets Manager for master key management — see [KMS Setup](../../operations/key-provider-setup.md#aws-secrets-manager-provider-aws-sm))

Generate:
```
openssl rand -base64 32  # AUTH_SECRET
openssl rand -hex 32     # SHARE_MASTER_KEY
```

## RDS (PostgreSQL)

- Use PostgreSQL 16
- Enable backups and Multi-AZ if required
- Set `DATABASE_URL` as:
```
postgresql://USER:PASSWORD@HOST:PORT/DBNAME
```

## ECS/Fargate Services

### app service

Env vars:
- `DATABASE_URL` (RDS)
- `AUTH_URL` (public URL of app)
- `AUTH_SECRET`
- `AUTH_GOOGLE_ID`
- `AUTH_GOOGLE_SECRET`
- `GOOGLE_WORKSPACE_DOMAINS` (optional)
- `JACKSON_URL` (internal or public URL)
- `AUTH_JACKSON_ID`
- `AUTH_JACKSON_SECRET`
- `SAML_PROVIDER_NAME`
- `SHARE_MASTER_KEY`
- `REDIS_URL` (REQUIRED in production — Zod schema enforces this for `NODE_ENV=production`; backs session cache with tombstone-based revocation propagation (PR #407) and shared rate limiting)
- `BLOB_BACKEND`
- `AWS_REGION`, `S3_ATTACHMENTS_BUCKET` (required if `BLOB_BACKEND=s3`)
- `AZURE_STORAGE_ACCOUNT`, `AZURE_BLOB_CONTAINER` (required if `BLOB_BACKEND=azure`)
- `GCS_ATTACHMENTS_BUCKET` (required if `BLOB_BACKEND=gcs`)

### jackson service

Env vars (example):
- `JACKSON_API_KEYS` (value comes from your `JACKSON_API_KEY` secret — note the env name inside Jackson uses the trailing `S`)
- `DB_ENGINE=sql`
- `DB_TYPE=postgres`
- `DB_URL` (RDS)
- `NEXTAUTH_URL` (public URL of jackson)
- `EXTERNAL_URL` (public URL of jackson)
- `NEXTAUTH_SECRET` (same as AUTH_SECRET)
- `NEXTAUTH_ACL=*`

### audit-outbox-worker service

Run as a dedicated ECS/Fargate service (or sidecar in the app task). Uses the same Docker image as `app`.

Command override: `["npx", "tsx", "scripts/audit-outbox-worker.ts"]`

Required env vars:
- `OUTBOX_WORKER_DATABASE_URL` (least-privilege `passwd_outbox_worker` role)
- `DATABASE_URL` (app role — for any shared config reads)

This service is long-running. Without it, `audit_outbox` rows accumulate as `PENDING` and audit logs are never persisted.

## Admin / Maintenance Scripts

Admin scripts (`scripts/purge-history.sh`, `scripts/purge-audit-logs.sh`, `scripts/rotate-master-key.sh`) require a per-operator `op_*` token rather than a shared environment variable.

Mint a token in the application UI at `/admin/tenant/operator-tokens`, then pass it at invocation time:

```bash
ADMIN_API_TOKEN=op_<your-token> scripts/purge-history.sh
ADMIN_API_TOKEN=op_<your-token> scripts/purge-audit-logs.sh
ADMIN_API_TOKEN=op_<your-token> TARGET_VERSION=<int> scripts/rotate-master-key.sh
```

Do NOT store `ADMIN_API_TOKEN` as a persistent environment variable in ECS task definitions. Mint tokens on demand and revoke them after use.

## Migrations

Run Prisma migrations from a one-off task using the SUPERUSER role:
```
MIGRATION_DATABASE_URL='postgresql://SUPERUSER:password@HOST:5432/DB' npx prisma migrate deploy
```

The `MIGRATION_DATABASE_URL` must point to a role with DDL privileges (table owner). The app service `DATABASE_URL` should use a non-SUPERUSER role.

## Health Checks

| Endpoint | Purpose | Used by |
|---|---|---|
| `GET /api/health/live` | Liveness (process alive) | ECS container health check |
| `GET /api/health/ready` | Readiness (DB + Redis connectivity) | ALB target group |

- Set ALB target group health check path to `/api/health/ready`
- Use `/api/health/live` for ECS task definition container health check
- Set `HEALTH_REDIS_REQUIRED=true` to return 503 on Redis failure (default: degraded 200)

## Monitoring & Alerts

Defined in Terraform (`infra/terraform/monitoring.tf`):

- **CloudWatch Metric Filters**: 5xx errors, health check failures, high latency
- **CloudWatch Alarms**: ALB 5xx, health check failures, unhealthy hosts, high latency
- **EventBridge**: ECS task stop detection
- **SNS Topic**: Alarm notifications (email, etc.)

Enable with `enable_monitoring = true`, set `alarm_email` for email notifications.

## Deploy Order

⚠️ When introducing health checks, deploy app code first, then run Terraform apply.
Reversing this order causes ALB to mark all targets as unhealthy (cannot reach `/api/health/ready`).

## Notes

- Use ALB with HTTPS (ACM cert).
- Restrict `jackson` access if possible.
- Run Redis as a separate ElastiCache cluster (not inside RDS).
- Do not store secrets in task definitions or source code.
