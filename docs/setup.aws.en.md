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
- `ORG_MASTER_KEY`
- `REDIS_URL`

Optional:
- `GOOGLE_WORKSPACE_DOMAIN`
- `SAML_PROVIDER_NAME`

Generate:
```
openssl rand -base64 32  # AUTH_SECRET
openssl rand -hex 32     # ORG_MASTER_KEY
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
- `ORG_MASTER_KEY`
- `REDIS_URL`

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

## Notes

- Use ALB with HTTPS (ACM cert).
- Restrict `jackson` access if possible.
- Run Redis as a separate ElastiCache cluster (not inside RDS).
- Do not store secrets in task definitions or source code.
