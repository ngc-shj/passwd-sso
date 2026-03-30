# Deployment Guide

## Prerequisites

- AWS CLI v2 configured with appropriate credentials
- `jq` installed
- Docker + Docker Compose v2
- Terraform CLI

## Image Tag Rules

- **Immutable tags required**: Use git SHA (`git-abc1234`) or digest (`repo@sha256:...`)
- **`:latest` is prohibited** — migrate and app task definitions must reference the exact same image
- `terraform apply` sets `var.app_image` for both `app` and `migrate` task definitions, guaranteeing consistency

## Deploy Flow (AWS ECS)

```
1. docker build    →  Build image with immutable tag
2. docker push     →  Push to ECR
3. terraform apply →  Update app + migrate task definitions (same image)
4. deploy.sh       →  Run migration → update app service
```

### Step-by-step

```bash
# 1. Build
GIT_SHA=$(git rev-parse --short HEAD)
IMAGE="<account>.dkr.ecr.<region>.amazonaws.com/passwd-sso:git-${GIT_SHA}"
docker build -t "$IMAGE" .

# 2. Push
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker push "$IMAGE"

# 3. Update task definitions via Terraform
terraform -chdir=infra/terraform apply -var "app_image=$IMAGE"

# 4. Deploy (migrate + app update)
export SUBNETS="subnet-xxx,subnet-yyy"
export SECURITY_GROUPS="sg-xxx"
./scripts/deploy.sh
```

### Skip Migration

When a release has no schema changes (code-only deploy):

```bash
./scripts/deploy.sh --skip-migrate
```

## Deploy Flow (Local / Docker Compose)

### Run migration only

```bash
docker compose --profile migrate up migrate --abort-on-container-exit --exit-code-from migrate
```

Or with `run`:

```bash
docker compose --profile migrate run --rm migrate
```

### Start all services (without migration)

```bash
docker compose up
```

This starts `app`, `db`, `jackson`, and `redis` — but **not** the `migrate` service (it uses `profiles: ["migrate"]`).

## Migration Failure

If `deploy.sh` reports a migration failure:

1. **Do not proceed** — the app service is NOT updated when migration fails
2. Check CloudWatch Logs (`migrate` stream prefix) for error details
3. Fix the migration issue (e.g., fix the migration SQL, or address data conflicts)
4. Re-run `deploy.sh` (migration will retry from the failed point — Prisma migrations are idempotent for already-applied migrations)

## Rollback

### Code-only rollback (no schema change)

```bash
# Point to the previous known-good image
terraform -chdir=infra/terraform apply -var "app_image=<previous-image>"
./scripts/deploy.sh --skip-migrate
```

### Schema rollback

Prisma Migrate does not support automatic down migrations. To roll back a schema change:

1. Create a new migration that reverses the schema change
2. Build a new image containing the rollback migration
3. Deploy using the standard flow (`terraform apply` → `deploy.sh`)

## Sub-path Deployment Note

When deploying at a sub-path (e.g., `https://example.com/passwd-sso`), set `NEXT_PUBLIC_BASE_PATH=/passwd-sso` **before** building the image. This is a build-time variable baked into the client bundle. Set `AUTH_URL` to the origin only (e.g., `https://example.com`) — do NOT include the basePath. Update OAuth redirect URIs to include the basePath. See `docs/setup/docker/en.md` for details.

## Deploy Checklist

- [ ] All tests pass (`npm test`)
- [ ] Build succeeds (`npm run build`)
- [ ] Image built with immutable tag (git SHA)
- [ ] Image pushed to ECR
- [ ] `terraform apply` completed (updates both app + migrate task definitions)
- [ ] `deploy.sh` completed successfully
- [ ] Health check passes after deployment
- [ ] Verify app functionality in production

## Admin Operations

### Rotate ShareLink Master Key

Rotate the server-side master key used to encrypt ShareLink data. Run after adding a new `SHARE_MASTER_KEY_V<N>` to the environment.

**Prerequisites:**
- `ADMIN_API_TOKEN` set in the app environment (64-char hex, generate with `openssl rand -hex 32`)
- New master key version configured: `SHARE_MASTER_KEY_V<N>=<hex64>` and `SHARE_MASTER_KEY_CURRENT_VERSION=<N>`
- App restarted to load the new environment variables

```bash
ADMIN_API_TOKEN=<hex64> \
OPERATOR_ID=<user-cuid-or-uuid> \
TARGET_VERSION=<N> \
APP_URL=https://your-app-url \
scripts/rotate-master-key.sh
```

| Option | Default | Description |
|--------|---------|-------------|
| `REVOKE_SHARES` | `false` | Set `true` to revoke share links encrypted with older key versions |
| `INSECURE` | `false` | Skip TLS verification (dev only, **never use in production**) |

### Purge Password History

System-wide purge of password entry history records older than the retention period.

```bash
ADMIN_API_TOKEN=<hex64> \
OPERATOR_ID=<user-cuid-or-uuid> \
APP_URL=https://your-app-url \
scripts/purge-history.sh
```

| Option | Default | Description |
|--------|---------|-------------|
| `RETENTION_DAYS` | `90` | Purge history older than this many days |
| `DRY_RUN` | `false` | Preview without deleting |
| `INSECURE` | `false` | Skip TLS verification (dev only, **never use in production**) |

### Vault / Team Key Rotation

Personal vault and team encryption key rotation are performed via the web UI:

- **Personal vault**: Settings → Security → Key Rotation
- **Team vault**: Team Settings → Security → Key Rotation

These operations re-encrypt all entries client-side and submit the results atomically. No admin script is needed.

## Environment Variables

The deploy script uses these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ECS_CLUSTER` | `passwd-sso-prod-cluster` | ECS cluster name |
| `MIGRATE_TASK_DEF` | `passwd-sso-prod-migrate` | Migration task definition family |
| `APP_SERVICE` | `passwd-sso-prod-app` | ECS app service name |
| `SUBNETS` | *(required)* | Comma-separated subnet IDs |
| `SECURITY_GROUPS` | *(required)* | Comma-separated security group IDs |

## Database User Permissions

The application uses two database roles with separated privileges:

| Role | Privileges | Purpose |
|------|-----------|---------|
| `passwd_user` (or equivalent) | SUPERUSER or DDL-capable | Table owner, migrations (`prisma migrate deploy`) |
| `passwd_app` (or equivalent) | NOSUPERUSER NOBYPASSRLS | App runtime (Next.js), RLS enforced |

```sql
-- Production: create a non-superuser application role
CREATE ROLE passwd_app LOGIN PASSWORD '<strong-password>' NOSUPERUSER NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE passwd_sso TO passwd_app;
GRANT USAGE ON SCHEMA public TO passwd_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO passwd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO passwd_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO passwd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO passwd_app;
```

**Environment variables:**
- `DATABASE_URL` — app runtime connection (non-SUPERUSER role, e.g. `passwd_app`)
- `MIGRATION_DATABASE_URL` — Prisma CLI connection (SUPERUSER role, e.g. `passwd_user`)

The Docker Compose dev setup enforces the same role separation: the `app` service connects as `passwd_app` (NOSUPERUSER, NOBYPASSRLS) while the `migrate` service connects as `passwd_user` (SUPERUSER). RLS is enforced in all environments.

> **⚠️ Breaking change for existing dev environments**: After upgrading, run `docker compose down -v && docker compose up` to recreate the database with the new `passwd_app` role. The initdb scripts only run on first initialization (empty volume).
