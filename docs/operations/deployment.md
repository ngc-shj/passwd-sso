# Deployment Guide

## Environment Configuration

Before deploying, generate and verify your environment configuration:

- `npm run init:env` — interactive generator that writes `.env` with all required variables (supports dev / ci / production profiles)
- `npm run check:env-docs` — CI drift check: validates `.env.example` against the Zod schema (`src/lib/env-schema.ts`) and allowlist

Configuration precedence: `.env` (canonical base) → `.env.local` (per-developer override). Production deployments should use `.env` only; `.env.local` is for local tweaks. Do not commit either file.

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

**Terraform owns the deploy ordering.** A single `terraform apply` registers the
new task definitions, runs the DB migration (`null_resource.run_migration` in
`infra/terraform/migrate-run.tf`), and only THEN updates the app + both worker
services (they `depends_on` the migration) — so new code never runs against an
un-migrated schema.

```
1. docker build    →  Build image with immutable tag
2. docker push     →  Push to ECR
3. terraform apply →  register task defs → run migration → update app + workers
```

### Step-by-step (steady state)

```bash
export AWS_REGION=<region>
export ECR_URL=<account>.dkr.ecr.<region>.amazonaws.com/passwd-sso-prod-app
./scripts/deploy.sh   # build → push → terraform apply (migration is inside apply)
```

`scripts/deploy.sh` is a thin wrapper: it builds/pushes an immutable git-SHA tag
and runs `terraform apply -var app_image=…`. It does NOT run migrations itself —
Terraform does, gated before the service updates.

> **First-time bootstrap of a NEW environment.** The migration runs inside apply
> and needs (a) the image pushed to ECR and (b) the app secret VALUES present, but
> ECR and the empty secret containers are created BY apply. Bootstrap in phases —
> see `infra/terraform/README.md` "First-time bootstrap": create ECR only
> (`terraform apply -target=aws_ecr_repository.app`), push the image, inject
> secrets (`scripts/put-terraform-secrets.sh`), THEN run the full `terraform apply`.

### Code-only release (no schema change)

The migration task is idempotent (`prisma migrate deploy` is a no-op when there
are no pending migrations), so a code-only release is the same `./scripts/deploy.sh`
— apply re-runs the (no-op) migration and updates the services.

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

Background workers: `audit-outbox-worker` (drains `audit_outbox` → `audit_logs`)
and `retention-gc-worker` (enforces retention / hard-deletes). On AWS they are
dedicated Terraform-managed ECS services (`infra/terraform/ecs.tf`); on Docker
Compose they are in `docker-compose.workers.yml` (production) /
`docker-compose.override.yml` (dev tsx). Without them, audit events accumulate as
`PENDING` and retention is never enforced.

## Migration Failure

The migration runs inside `terraform apply` (`null_resource.run_migration`). If
it fails, the local-exec returns non-zero, so:

1. **`terraform apply` aborts** — because the app + worker services `depends_on`
   the migration, they are NOT updated to the new task-def revision when
   migration fails. Running code keeps the old (schema-compatible) image.
2. Check CloudWatch Logs (`migrate` stream prefix) for error details.
3. Fix the migration issue (migration SQL, or data conflicts).
4. Re-run `./scripts/deploy.sh` (or `terraform apply`). Prisma migrations are
   idempotent for already-applied migrations, so the retry resumes from the
   failed point.

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

When deploying at a sub-path (e.g., `https://example.com/passwd-sso`), set `NEXT_PUBLIC_BASE_PATH=/passwd-sso` **before** building the image. This is a build-time variable baked into the client bundle. Set `AUTH_URL` to the origin only (e.g., `https://example.com`) — do NOT include the basePath. Set `APP_URL` as well when the public origin differs from the app's internal origin behind a reverse proxy/CDN. Cookie-authenticated mutating API routes now fail closed if neither canonical origin is configured. Update OAuth redirect URIs to include the basePath. See `docs/setup/docker/en.md` for details.

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

Admin and maintenance scripts are authenticated with per-operator `op_*` bearer tokens. See [admin-tokens.md](admin-tokens.md) for the canonical guide on minting, rotating, and revoking tokens.

To obtain a token: sign in as a tenant OWNER or ADMIN, navigate to **Admin → Tenant → Operator tokens** (`/admin/tenant/operator-tokens`), and create a token. Pass it as the `ADMIN_API_TOKEN` shell variable at invocation time — do not set it in the app environment.

### Rotate ShareLink Master Key

Rotates the server-side master key used to encrypt ShareLink blobs (share links and sends). This operation **does not** re-encrypt vault data — vault keys are client-derived and the server master key plays no role in vault encryption.

**Prerequisites:**
- New key version configured in the app environment: `SHARE_MASTER_KEY_V<N>=<hex64>` and `SHARE_MASTER_KEY_CURRENT_VERSION=<N>` (generate a key with `npm run generate:key`)
- App restarted to load the new environment variables

```bash
ADMIN_API_TOKEN=op_<43-char base64url> \
TARGET_VERSION=<N> \
APP_URL=https://your-app-url \
scripts/rotate-master-key.sh
```

| Option | Default | Description |
|--------|---------|-------------|
| `REVOKE_SHARES` | `false` | Set `true` to revoke share links encrypted with older key versions |
| `INSECURE` | `false` | Skip TLS verification (dev only, **never use in production**) |

### Purge Password History

System-wide purge of password entry history records older than the retention period. See [admin-tokens.md](admin-tokens.md) for full details.

```bash
ADMIN_API_TOKEN=op_<43-char base64url> \
APP_URL=https://your-app-url \
scripts/purge-history.sh
```

### Purge Audit Logs

System-wide purge of audit log records older than the retention period.

```bash
ADMIN_API_TOKEN=op_<43-char base64url> \
APP_URL=https://your-app-url \
scripts/purge-audit-logs.sh
```

### Vault / Team Key Rotation

Personal vault and team encryption key rotation are performed via the web UI:

- **Personal vault**: Settings → Security → Key Rotation
- **Team vault**: Team Settings → Security → Key Rotation

These operations re-encrypt all entries client-side and submit the results atomically. No admin script is needed.

## Environment Variables

`scripts/deploy.sh` uses these environment variables (cluster / subnets / SG /
task-def ARNs are read from `terraform output`, not passed in):

| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_REGION` | *(required)* | AWS region |
| `ECR_URL` | *(required)* | App ECR repo URL (`<acct>.dkr.ecr.<region>.amazonaws.com/passwd-sso-prod-app`) |
| `TF_VAR_FILE` | *(required)* | tfvars path (e.g. `envs/prod/terraform.tfvars`) — passed as `-var-file` |
| `TF_DIR` | `infra/terraform` | Terraform working directory |

## Database User Permissions

The application uses four database roles with separated privileges:

| Role | Privileges | Purpose |
|------|-----------|---------|
| `passwd_user` (or equivalent) | SUPERUSER or DDL-capable | Table owner, migrations (`prisma migrate deploy`) |
| `passwd_app` (or equivalent) | NOSUPERUSER NOBYPASSRLS | App runtime (Next.js), RLS enforced |
| `passwd_outbox_worker` (or equivalent) | NOSUPERUSER NOBYPASSRLS; SELECT/UPDATE/DELETE on `audit_outbox`, INSERT on `audit_logs`, SELECT on `tenants` | Audit outbox drain worker (least privilege) |
| `passwd_retention_gc_worker` (or equivalent) | NOSUPERUSER NOBYPASSRLS; scoped DELETE/SELECT on the retention-swept tables | Retention GC worker (least privilege) |

On AWS RDS these roles are NOT auto-created (the `infra/postgres/initdb/*.sql`
scripts run only on the Docker Postgres image) — create them manually during
bootstrap, before the first migration. See `infra/terraform/README.md`
"First-time bootstrap".

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
- `OUTBOX_WORKER_DATABASE_URL` — audit outbox worker connection (least-privilege role, e.g. `passwd_outbox_worker`). Set the worker role password with `scripts/set-outbox-worker-password.sh`.

The Docker Compose dev setup enforces the same role separation: the `app` service connects as `passwd_app` (NOSUPERUSER, NOBYPASSRLS) while the `migrate` service connects as `passwd_user` (SUPERUSER). RLS is enforced in all environments.

> **⚠️ Breaking change for existing dev environments**: After upgrading, run `docker compose down -v && docker compose up` to recreate the database with the new `passwd_app` role. The initdb scripts only run on first initialization (empty volume).
