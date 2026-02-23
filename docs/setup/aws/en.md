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

## System Architecture (ASCII)

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

## Prerequisites

- AWS account with VPC and subnets
- ECS cluster (Fargate)
- RDS PostgreSQL instance
- ElastiCache Redis cluster
- Secrets Manager
- Load Balancer (ALB) for `app` and `jackson` if public

## Secrets

Store these in Secrets Manager:
- `DATABASE_URL`
- `AUTH_SECRET`
- `AUTH_GOOGLE_ID`
- `AUTH_GOOGLE_SECRET`
- `AUTH_JACKSON_ID`
- `AUTH_JACKSON_SECRET`
- `SHARE_MASTER_KEY`
- `REDIS_URL`
- `BLOB_BACKEND`

Optional:
- `GOOGLE_WORKSPACE_DOMAIN`
- `SAML_PROVIDER_NAME`
- `AWS_REGION`, `S3_ATTACHMENTS_BUCKET` (when `BLOB_BACKEND=s3`)
- `AZURE_STORAGE_ACCOUNT`, `AZURE_BLOB_CONTAINER` (when `BLOB_BACKEND=azure`)
- `GCS_ATTACHMENTS_BUCKET` (when `BLOB_BACKEND=gcs`)
- `HEALTH_REDIS_REQUIRED=true` (fail health check when Redis is down)

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
- `GOOGLE_WORKSPACE_DOMAIN` (optional)
- `JACKSON_URL` (internal or public URL)
- `AUTH_JACKSON_ID`
- `AUTH_JACKSON_SECRET`
- `SAML_PROVIDER_NAME`
- `SHARE_MASTER_KEY`
- `REDIS_URL`
- `BLOB_BACKEND`
- `AWS_REGION`, `S3_ATTACHMENTS_BUCKET` (required if `BLOB_BACKEND=s3`)
- `AZURE_STORAGE_ACCOUNT`, `AZURE_BLOB_CONTAINER` (required if `BLOB_BACKEND=azure`)
- `GCS_ATTACHMENTS_BUCKET` (required if `BLOB_BACKEND=gcs`)

### jackson service

Env vars (example):
- `JACKSON_API_KEYS`
- `DB_ENGINE=sql`
- `DB_TYPE=postgres`
- `DB_URL` (RDS)
- `NEXTAUTH_URL` (public URL of jackson)
- `EXTERNAL_URL` (public URL of jackson)
- `NEXTAUTH_SECRET` (same as AUTH_SECRET)
- `NEXTAUTH_ACL=*`

## Migrations

Run Prisma migrations from a one-off task:
```
npx prisma migrate deploy
```

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
