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

## Deploy Checklist

- [ ] All tests pass (`npm test`)
- [ ] Build succeeds (`npm run build`)
- [ ] Image built with immutable tag (git SHA)
- [ ] Image pushed to ECR
- [ ] `terraform apply` completed (updates both app + migrate task definitions)
- [ ] `deploy.sh` completed successfully
- [ ] Health check passes after deployment
- [ ] Verify app functionality in production

## Environment Variables

The deploy script uses these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ECS_CLUSTER` | `passwd-sso-prod-cluster` | ECS cluster name |
| `MIGRATE_TASK_DEF` | `passwd-sso-prod-migrate` | Migration task definition family |
| `APP_SERVICE` | `passwd-sso-prod-app` | ECS app service name |
| `SUBNETS` | *(required)* | Comma-separated subnet IDs |
| `SECURITY_GROUPS` | *(required)* | Comma-separated security group IDs |
