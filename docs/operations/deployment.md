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
- [`cosign`](https://docs.sigstore.dev/cosign/system_config/installation/) — `deploy.sh` signs every image it pushes and verifies signatures before deploying
- `kms:Sign` on the image-signing key (attach the `image_signing_policy_arn` output to the deploy principal)

## Image Tag Rules

- **Immutable tags required**: Use git SHA (`git-abc1234`) or digest (`repo@sha256:...`)
- **`:latest` is prohibited** — migrate and app task definitions must reference the exact same image
- `terraform apply` sets `var.app_image` for the `app`, `migrate`, and both worker task definitions, guaranteeing they run the same image
- `deploy.sh` resolves the tag to a **digest** and passes that to Terraform, so the bytes it signature-verified are exactly the bytes that run

## Image Signing (cosign + KMS)

Every image `deploy.sh` deploys must carry a valid cosign signature made with the
KMS key in `infra/terraform/ecr.tf`.

**Why.** ECR immutability stops a tag being *overwritten*, but it does not stop a
tag being *created first*. A principal holding only ECR push rights could
pre-place `git-<sha>` for a commit that is about to be deployed; `deploy.sh`'s
retry-safe "tag already exists → skip build" path would then adopt their image.
Where push and deploy permissions are separated — as they are here — that is a
privilege escalation. Signing authority is a distinct IAM permission
(`kms:Sign`), so a push-only principal cannot produce a signature that verifies.

**What happens on each path:**

| Path | Signing / verification |
|------|------------------------|
| Forward deploy, image not yet in ECR | build → push → `cosign sign` the digest → verify |
| Forward deploy, tag already in ECR (retry) | verify only — an unsigned pre-placed tag is rejected |
| `--rollback-to` | verify the resolved digest before deploying |

A failed verification aborts the deploy before `terraform apply` and before any
service is updated.

```bash
# One-time: grant the deploy principal kms:Sign
terraform -chdir=infra/terraform output -raw image_signing_policy_arn
aws iam attach-role-policy --role-name <deploy-role> --policy-arn <that-arn>

# Verify an image by hand
cosign verify --key "awskms:///$(terraform -chdir=infra/terraform output -raw image_signing_key_arn)" \
  <account>.dkr.ecr.<region>.amazonaws.com/passwd-sso-prod-app@sha256:<digest>
```

`COSIGN_KEY=awskms:///<arn>` overrides the key `deploy.sh` reads from the stack
output — use it when the signing key lives outside this Terraform state.

> **Three slashes.** cosign's URI is `awskms://[ENDPOINT]/[ID]`. We use no custom
> endpoint, so the authority is empty and the ARN goes in the path:
> `awskms:///arn:aws:kms:...`. With two slashes cosign parses the ARN as the
> endpoint *host* (`Failed to parse uri: https://arn:aws:kms:...`), never reaches
> KMS, and — since verification fails closed — aborts every deploy.
> `scripts/checks/check-cosign-kms-uri.sh` runs the real binary against a dummy
> ARN to keep this from regressing; a stub-based unit test cannot catch it.

> **Images pushed before signing was introduced carry no signature** and will be
> refused. Re-push from a clean checkout (which signs them), or sign the existing
> digest once with `cosign sign --key awskms:///<arn> <repo>@sha256:<digest>`.

> **Do not delete the KMS key.** Losing the private half invalidates every
> signature already attached to images in ECR; the key is created with a 30-day
> deletion window for that reason. KMS cannot auto-rotate asymmetric keys — to
> rotate, create a new key, re-sign the images you still need to deploy, then
> point `image_signing_key_arn` at it.

## Deploy Flow (AWS ECS)

**`scripts/deploy.sh` owns the deploy ordering — not Terraform.** Every ECS
service has `ignore_changes = [task_definition]`, so `terraform apply` registers a
new task-definition revision but does NOT move the running services. The script
enforces migration-first ordering explicitly: apply (task defs only) → run the DB
migration as a one-off ECS task → only then advance app + jackson + both workers
to the new revision. New code never runs against an un-migrated schema.

```
1. reject dirty/untracked worktree  →  deployed SHA == committed code
2. docker build + push              →  immutable git-SHA tag (skip if already in ECR)
3. terraform apply                  →  register task defs (services unchanged)
4. ECS run-task (migrate)           →  wait for exit 0
5. update-service app+jackson+workers →  advance to new revision
6. wait services-stable, then assert BOTH rolloutState == COMPLETED AND the
   PRIMARY deployment's taskDefinition == the ARN we requested; on any failure,
   compensating-rollback every service to its pre-deploy revision
```

Step 6 checks the task-definition ARN, not just `rolloutState`, because an ECS
deployment-circuit-breaker rollback ALSO settles at `COMPLETED` — on the OLD task
definition. `COMPLETED` alone would report a phantom success for a deploy that
was actually reverted.

The compensating rollback exists because ECS only auto-reverts the service(s)
that failed: without it, a partial failure leaves a version SPLIT (app on the new
revision, a worker back on the old). It restores every service to the revision
captured before the deploy, then waits and verifies; if it cannot, it exits
non-zero saying manual intervention is required. It is armed by an `ERR/INT/TERM`
trap before the first `update-service`, so a failure of an `update-service` call
itself also triggers compensation.

### Step-by-step (steady state)

```bash
export AWS_REGION=<region>
export ECR_URL=<account>.dkr.ecr.<region>.amazonaws.com/passwd-sso-prod-app
export TF_VAR_FILE=envs/prod/terraform.tfvars   # required — passed as -var-file
./scripts/deploy.sh
```

All three variables are required; the script exits immediately if any is unset.
It builds/pushes an immutable git-SHA tag, runs `terraform apply
-var-file=$TF_VAR_FILE -var app_image=…`, runs the migration itself (as an ECS
`run-task`, NOT inside apply), then rolls the services.

> **First-time bootstrap of a NEW environment.** Do NOT use `deploy.sh` — the ECR
> repos and empty secret containers don't exist yet, and the least-privilege DB
> roles must be created on RDS before the first migration. Follow the phased
> bootstrap in `infra/terraform/README.md` "First-time bootstrap" (services are
> created at `desired_count = 0`, roles created via ECS Exec, migration run, then
> scale up).

### Code-only release (no schema change)

The migration task is idempotent (`prisma migrate deploy` is a no-op when there
are no pending migrations), so a code-only release is the same `./scripts/deploy.sh`
— it re-runs the (no-op) migration and advances the services.

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

## Migration Compatibility Rules

Migration-first ordering protects NEW code from an un-migrated schema. It does
**not** protect OLD code from a new schema: `prisma migrate deploy` runs while the
previous app + workers are still serving traffic, and they keep running until
step 5 rolls them. So for the whole migration window — and for the rollback
window after it — the OLD code is live against the NEW schema.

Therefore every steady-state migration MUST be **expand-and-contract**:
compatible with both the old and the new code.

| Phase | What ships | Safe with old code running |
|-------|-----------|----------------------------|
| Expand | Add the new column/table, nullable and defaulted; dual-write in code | Yes |
| Migrate data | Backfill in a separate migration | Yes |
| Contract | Drop/rename/narrow the old column — only AFTER no running code reads it | Only once the old code is fully gone |

Concretely, in a single steady-state deploy do **not**: `DROP COLUMN`,
`DROP TABLE`, `RENAME`, `SET NOT NULL` on a column old code omits, or
`ALTER COLUMN ... TYPE` to a representation old code does not write. These are
enforced by `scripts/checks/check-destructive-migration.mjs`, which fails the
build for a new migration containing that DDL unless it is listed in
`scripts/checks/destructive-migration-baseline.txt` with a reason. Pre-existing
migrations are baselined there; the gate binds new ones.

Two further rules:

- **Wrap multi-statement DDL in an explicit transaction.** Prisma does not wrap
  PostgreSQL migrations in a transaction automatically, so a migration that fails
  on its 3rd statement leaves the first two applied — a schema that is neither
  the old nor the new one. Add explicit `BEGIN;` / `COMMIT;` around multi-step
  DDL so a failure rolls the whole migration back. (Statements that cannot run
  inside a transaction, e.g. `CREATE INDEX CONCURRENTLY`, must be their own
  migration.)
- **Incompatible migrations use the maintenance path**, not the steady-state
  deploy: scale the app + workers to `desired_count = 0`, run the migration, then
  scale back up on the new image. This is a deliberate operator decision with
  downtime, which is exactly why it is not the default path.

## Migration Failure

The migration runs as a one-off ECS `run-task` inside `deploy.sh`, BEFORE any
service is advanced. If it exits non-zero:

1. **`deploy.sh` aborts at step 4** — the `update-service` calls (step 5) never
   run, so the running services stay on their previous revision. New code never
   touches the failed schema.
2. Check CloudWatch Logs (`migrate` stream prefix) for error details.
3. **Determine what was actually applied.** Prisma marks the failed migration in
   `_prisma_migrations` and refuses to proceed until it is resolved. Because
   Prisma does NOT wrap PostgreSQL migrations in a transaction by default, a
   migration that failed midway may have applied some statements — so the live
   schema is not necessarily the old one, and the still-running old code may
   already be interacting with a partially-migrated schema. Inspect the schema
   before deciding.
4. Resolve the failed migration, via the migrate task (ECS Exec — see
   `infra/terraform/README.md`):
   - Statements were applied and the schema is now correct →
     `npx prisma migrate resolve --applied <migration_name>`
   - Nothing was applied, or you manually reverted the partial effects →
     `npx prisma migrate resolve --rolled-back <migration_name>`, then fix the
     migration SQL.
5. Re-run `./scripts/deploy.sh`. The immutable git-SHA tag already exists in ECR,
   so the build/push is skipped (retry-safe), and already-applied migrations are
   no-ops, so the retry resumes from the failed point.

> If the partially-applied schema is incompatible with the running old code
> (see "Migration Compatibility Rules"), treat it as an incident: the fastest
> safe route is usually to finish the migration forward and roll the services,
> not to try to reconstruct the old schema under live traffic.

## Rollback

### Code-only rollback (no schema change)

`deploy.sh --rollback-to <image>` re-points every service at a previous
known-good image WITHOUT rebuilding from HEAD and WITHOUT running a migration
(the forward-compatible schema is left in place):

```bash
export AWS_REGION=<region>
export ECR_URL=<account>.dkr.ecr.<region>.amazonaws.com/passwd-sso-prod-app
export TF_VAR_FILE=envs/prod/terraform.tfvars
./scripts/deploy.sh --rollback-to <account>.dkr.ecr.<region>.amazonaws.com/passwd-sso-prod-app:git-<previous-sha>
```

The target image must already exist in ECR (it is a prior release — `deploy.sh`
verifies this before touching any service). It then applies with that image,
skips the migration, advances the services, and waits for them to stabilize.

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
- [ ] Worktree clean (no uncommitted OR untracked files — `deploy.sh` rejects both)
- [ ] `AWS_REGION`, `ECR_URL`, `TF_VAR_FILE` exported
- [ ] `deploy.sh` completed successfully (apply → migrate → roll services → services-stable)
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
scripts run only on the Docker Postgres image) — create them during bootstrap,
before the first migration, with `scripts/bootstrap-rds-roles.mjs`. See
`infra/terraform/README.md` "First-time bootstrap".

### Ownership of role attributes vs table ACLs

These are owned by different things, which matters when auditing:

| Aspect | Owner | Converged by a re-run? |
|--------|-------|------------------------|
| Role attributes (`NOSUPERUSER`, `NOBYPASSRLS`, `NOREPLICATION`, …), password, role memberships | `scripts/bootstrap-rds-roles.mjs` | Yes — always re-applied and asserted |
| `passwd_app` schema + table ACLs | `scripts/bootstrap-rds-roles.mjs` | Yes — revoke-then-grant |
| Worker table ACLs (`passwd_outbox_worker`, `passwd_retention_gc_worker`) | The Prisma migrations that create each table | **No** |

The worker table ACLs cannot be converged by the bootstrap: it runs *before* the
first migration, so those grants do not exist yet, and a blanket
`REVOKE ALL ON ALL TABLES` on a re-run would strip exactly what the migrations
installed. A privilege granted to a worker out of band is therefore **not**
removed by re-running the bootstrap.

Detection runs automatically on **every deploy**: the migrate task's command is
`prisma migrate deploy && node scripts/audit-db-grants.mjs`
(`infra/terraform/ecs.tf`), so a migration that grants more than the manifest
sanctions fails the migrate task — and `deploy.sh` aborts before any service is
advanced. The audit needs a SUPERUSER connection and RDS admits only the ECS
security group, so the migrate task is the only place it can run.

To run it manually against a deployed database:

```bash
MIGRATION_DATABASE_URL=<superuser-url> node scripts/audit-db-grants.mjs
```

It diffs the live ACLs of all three roles against
`scripts/checks/db-grants-manifest.json` and exits non-zero on any
`UNEXPECTED_GRANT` (over-privilege) or `MISSING_GRANT` (migrations not applied).

Privileges are **effective**, not direct-ACL: they are computed with
`has_*_privilege`, so a privilege reached via `PUBLIC` or via role inheritance
counts. (`information_schema.role_table_grants` omits both, and contains no
column-scoped grants at all — reading only that view misses all three.) Object
names are schema-qualified and **every non-system schema** is audited, not just
`public` (`pg_catalog`, `information_schema` and the temp/toast schemas are
excluded).

Manifest keys:

| Key | Covers |
|-----|--------|
| `TABLE:<role> <schema>.<table> <priv>` | table-level privileges |
| `COLUMN:<role> <schema>.<table>.<col> <priv>` | column-scoped grants not implied by the table-level privilege (13 today, e.g. the webhook workers' `UPDATE (fail_count, last_error, …)`) |
| `MEMBER:<role> <granted_role>` | role membership — an inheritance path; these roles should have none |
| `PUBLIC:<schema>.<table> <priv>` | granted to `PUBLIC`, so inherited by every role |
| `SCHEMA:<grantee> <schema> <priv>` | `USAGE`/`CREATE` (`CREATE` lets the role add its own objects) |
| `SEQUENCE:<grantee> <schema>.<seq> <priv>` | `USAGE`/`SELECT`/`UPDATE` |
| `FUNCTION:<grantee> <schema>.<identity> EXECUTE` | routine `EXECUTE`, suffixed `SECURITY_DEFINER` when it runs with its owner's privileges |
| `DATABASE:<grantee> <db> <priv>` | `CONNECT`/`CREATE`/`TEMP` |
| `DEFAULTACL:<owner> <schema> <type> <acl>` | pre-authorises objects that do not exist yet |
| `ROLEATTR:<role> <attr> <value>` | `SUPERUSER`/`BYPASSRLS`/`REPLICATION`/`CREATEDB`/`CREATEROLE`/`LOGIN` |

Columns are keyed individually on purpose: a table that legitimately carries
`UPDATE (fail_count)` must still fail the audit if `UPDATE (secret_encrypted)` is
added.

`FUNCTION` matters because PostgreSQL grants `EXECUTE` on new routines to
`PUBLIC` by default. A `SECURITY DEFINER` routine is therefore callable by every
role unless a migration revokes it — and it runs with its **owner's** privileges,
which no table-level audit would reveal. Role attributes are re-asserted on every
deploy because migrations run as SUPERUSER and can re-grant them, so the
bootstrap-time convergence is not durable on its own.

When a migration intentionally changes a grant, regenerate the manifest with
`--write` and review the diff — that diff is the security-relevant part of the
migration.

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

### Jackson runs as its own role (`jackson_user`) since v0.4.57

Jackson used to connect to the `jackson` database as the bootstrap superuser
(`passwd_user`). It now connects as `jackson_user` — NOSUPERUSER, NOBYPASSRLS,
owner of the `jackson` database only, and without `CONNECT` on `passwd_sso`.

`jackson_user` is created by `infra/postgres/initdb/01-create-jackson-db.sql`,
and **initdb runs only against an empty data directory**. On a volume
initialized before this change the role does not exist, so after upgrading,
Jackson fails to connect — every second, forever:

```
error connecting to engine: sql, type: postgres db: error:
password authentication failed for user "jackson_user"
```

PostgreSQL returns *authentication failed* for a role that does not exist at all
(it does not confirm which names are valid), so this reads as a wrong password.
Confirm which it is before changing anything:

```bash
docker compose exec db psql -U passwd_user -d postgres \
  -Atc "SELECT count(*) FROM pg_roles WHERE rolname = 'jackson_user'"
```

Both counts need an answer, because the error message does not distinguish them:

- `0` — the role was never created. Repair below.
- `1` — the role exists but Jackson still cannot authenticate, so its password or
  its `LOGIN` attribute is out of sync. This is not hypothetical:
  `01-create-jackson-db.sql` creates the role **NOLOGIN** when
  `PASSWD_JACKSON_PASSWORD` was unset at first boot. The same repair below
  covers it — it converges the role rather than only creating it.

Jackson keeps its HTTP port open while it retries, so it accepts TCP connections
and never answers. Docker's own health check does bound this (`timeout: 10s`), so
the container goes `unhealthy` after roughly `start_period` + `retries` ×
`interval`, and a fresh `docker compose up` aborts with `dependency failed to
start … is unhealthy` because `app` gates on `service_healthy`. An *external*
probe without a timeout is the one that hangs instead of failing — check
`docker compose ps jackson` first.

#### Repair (data-preserving, operator-only)

> **Takes `ACCESS EXCLUSIVE` locks on the Jackson tables.** Stop Jackson first;
> a live writer will block or fail. Run it in a maintenance window.

Ownership must move along with the role: the tables inside the `jackson`
database are still owned by `passwd_user`, and creating the role alone leaves
Jackson unable to write to them. `REASSIGN OWNED BY` cannot be used —
PostgreSQL refuses to reassign objects owned by the bootstrap superuser.

```bash
docker compose stop jackson

# Record the SAML connection count. The repair must not change it.
# to_regclass keeps this from erroring on a volume where Jackson never ran its
# schema bootstrap — which is exactly the NOLOGIN case above.
docker compose exec -T db psql -U passwd_user -d jackson -Atc \
  "SELECT CASE WHEN to_regclass('public.jackson_store') IS NULL
               THEN -1 ELSE (SELECT count(*) FROM jackson_store) END"   # call this N
```

`N = -1` means Jackson has never connected, so there is no schema and nothing to
preserve: skip verify checks 2 and 3 below, and expect check 1 to be trivially
satisfied because the database is empty. `N = 0` — tables exist but hold no
connections — is also legitimate; check 3 still applies.

Step 1 — converge the role. No `PASSWORD` clause here: `log_min_error_statement`
defaults to `error`, so a statement that fails is written to the server log in
full, and under `log_statement=ddl` every DDL statement is logged whether it
fails or not. Either way the cleartext would land in the `db` container's log.

```bash
docker compose exec -T db psql -U passwd_user -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jackson_user') THEN
    CREATE ROLE jackson_user;
  END IF;
END $$;

-- Report what we are about to converge, so a role that was hand-repaired into
-- something privileged is visible rather than silently demoted.
SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
  FROM pg_roles WHERE rolname = 'jackson_user';

-- Unconditional, so a role that already exists is converged rather than left
-- as-is. This CLEARS the attributes above; it is the repair, not a check.
ALTER ROLE jackson_user WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

-- Memberships are what ALTER ROLE does NOT touch, and they are the escalation
-- that survives it: `GRANT postgres TO jackson_user` is the usual "just make it
-- work" hand-repair, and it leaves a NOSUPERUSER role one `SET ROLE` away from
-- superuser — on the same cluster as passwd_sso. Step 3 hands this role
-- ownership of a whole database, so refuse here rather than converge silently.
DO $$
DECLARE granted text;
BEGIN
  SELECT string_agg(g.rolname, ', ') INTO granted
    FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid
    JOIN pg_roles c ON c.oid = m.member
   WHERE c.rolname = 'jackson_user';
  IF granted IS NOT NULL THEN
    RAISE EXCEPTION 'jackson_user is a member of: % — revoke these before granting it database ownership', granted;
  END IF;
END $$;
SQL
```

If that raises, revoke each membership (`REVOKE <role> FROM jackson_user`) and
re-run Step 1. Do not skip ahead: Steps 2 and 3 are separate `psql` invocations,
so an exception here aborts only Step 1 — nothing stops you pasting the rest.
Verify check 0 below re-asserts it immediately before the ownership transfer.

Step 2 — set the password. `\password` computes the SCRAM-SHA-256 verifier
client-side, so the cleartext never reaches the server or its log. The value is
read from the `db` container's own environment and piped on stdin, so it reaches
neither the host's shell history nor any process argument list.

```bash
docker compose exec -T db sh -c '
  [ -n "$PASSWD_JACKSON_PASSWORD" ] || { echo "PASSWD_JACKSON_PASSWORD is not set in the db container" >&2; exit 1; }
  printf "%s\n%s\n" "$PASSWD_JACKSON_PASSWORD" "$PASSWD_JACKSON_PASSWORD" \
    | psql -U passwd_user -d postgres -q \
        -c "SET log_statement TO '\''none'\''" -c "\password jackson_user"'
```

The `SET log_statement` is not decoration. `\password` issues
`ALTER USER ... PASSWORD 'SCRAM-SHA-256$4096:...'`, which is DDL — so under
`log_statement=ddl` or `all` the **verifier** is written to the `db` container
log, which this stack now retains at 20 MB × 5. A verifier is not
password-equivalent, but it is offline-crackable at 4096 iterations, so it is
worth keeping out of a log that gets shipped. Residual: if the statement *fails*,
`log_min_error_statement=error` records it anyway. If that log has been exported
anywhere, rotate `PASSWD_JACKSON_PASSWORD`.

Step 3 — move ownership, then restart Jackson.

```bash
docker compose exec -T db psql -U passwd_user -d jackson -v ON_ERROR_STOP=1 <<'SQL'
-- Check 0, adjacent to the operation it guards. Step 1's identical assertion is
-- in a different psql invocation, so on its own it cannot stop this statement.
DO $$
DECLARE granted text;
BEGIN
  SELECT string_agg(g.rolname, ', ') INTO granted
    FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid
    JOIN pg_roles c ON c.oid = m.member
   WHERE c.rolname = 'jackson_user';
  IF granted IS NOT NULL THEN
    RAISE EXCEPTION 'jackson_user is a member of: % — refusing to grant it database ownership', granted;
  END IF;
END $$;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO jackson_user', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO jackson_user', r.sequencename);
  END LOOP;
  FOR r IN SELECT table_name FROM information_schema.views WHERE table_schema = 'public' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO jackson_user', r.table_name);
  END LOOP;
END;
$$;

ALTER DATABASE jackson OWNER TO jackson_user;
SQL

docker compose start jackson
```

`ALTER DATABASE ... OWNER` also carries the `public` schema, because that schema
is owned by `pg_database_owner` — no separate `ALTER SCHEMA` is needed.

#### Verify

Every check below has to be able to fail for the reason it claims, so run all
four. Note `-h db` and not `-h 127.0.0.1`: the `postgres` image's generated
`pg_hba.conf` puts `host all all 127.0.0.1/32 trust` above the scram rule, so a
loopback connection from inside the container succeeds with **any** password and
proves nothing about authentication. `-h db` takes the same bridge-network path
Jackson itself uses.

```bash
# 1. Ownership transfer is complete. One query over pg_class, so the assertion
#    and the repair loop share a member set — tables, partitions, sequences,
#    views, materialized views and foreign tables.
docker compose exec -T db psql -U passwd_user -d jackson -Atc "
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m','f')
     AND pg_get_userbyid(c.relowner) <> 'jackson_user'"
# expected: 0
#   Note this is 0 on an empty database too (N = -1 above), where it proves
#   nothing — check 3 is what tells you the repair worked in that case.

# 2. No SAML connection was lost.
docker compose exec -T db psql -U passwd_user -d jackson -Atc "SELECT count(*) FROM jackson_store"
# expected: N, the count recorded before the repair

# 3. jackson_user can authenticate and read its own database.
docker compose exec -T db sh -c \
  'PGPASSWORD="$PASSWD_JACKSON_PASSWORD" psql -h db -U jackson_user -d jackson -Atc "SELECT count(*) FROM jackson_store"'
# expected: N

# 4. jackson_user cannot reach passwd_sso — the point of the split role
#    (migration 20260611011121 revoked the PUBLIC CONNECT default).
docker compose exec -T db sh -c \
  'PGPASSWORD="$PASSWD_JACKSON_PASSWORD" psql -h db -U jackson_user -d passwd_sso -Atc "SELECT 1"'
# expected: FATAL: permission denied for database "passwd_sso"
#   NOT "password authentication failed" — that would mean check 3 should have
#   failed too, and this denial says nothing about the CONNECT privilege.
```

If check 3 fails with `password authentication failed` while checks 1 and 2 pass,
`$PASSWD_JACKSON_PASSWORD` has a trailing CR or is whitespace-only: `\password`
strips the line ending before hashing and still exits 0, so Step 2 set something
other than the value the `jackson` service uses. Fix the variable and re-run
Step 2.

Then confirm Jackson itself recovered — the checks above all pass with Jackson
stopped:

```bash
docker compose ps jackson                        # expected: healthy
docker compose logs --since 2m jackson | grep -c "error connecting to engine"
# expected: 0
```

If `N` was `0` on entry, check 2 is vacuous — there was nothing to preserve, and
the destructive path below is simpler.

The destructive alternative — drop and recreate the `jackson` database with
`OWNER jackson_user` — is faster but loses every stored SAML connection, which
must then be re-imported. Both paths are in
`docs/archive/review/security-audit-remediation-manual-test.md`.

### Applying the container log caps

`docker-compose.yml` bounds every service's log at `max-size: 20m` / `max-file: 5`.
The setting is part of a container's config, so it takes effect only when the
container is **recreated** — `docker compose restart` and `docker compose start`
leave an existing container on the unbounded default.

Run it with **the same `-f` set the stack was deployed with**. A bare
`docker compose up -d` resolves only `docker-compose.yml`, so on the production
topology (`-f docker-compose.yml -f docker-compose.workers.yml`, see
`docs/setup/docker/en.md`) it has no definition for the two workers and cannot
recreate them — they keep the unbounded config while `docker compose ps` still
lists them, and re-running the bare command changes nothing.

```bash
# dev (base + override is the default):
docker compose up -d
# production topology:
docker compose -f docker-compose.yml -f docker-compose.workers.yml up -d

docker inspect -f '{{.Name}} {{.HostConfig.LogConfig.Type}} {{.HostConfig.LogConfig.Config}}' \
  $(docker compose ps -aq)
# expected: json-file map[max-file:5 max-size:20m] for every container
# map[] means the cap is not in force for that container — recreate it with the
# -f set that defines it
```

`ps -aq`, not `ps -q`: a stopped container — `jackson`, if you are here straight
from the repair above — is absent from `-q` and its stale config goes
unreported. Confirm the list is non-empty first; with no containers,
`docker inspect` succeeds having examined nothing. Under
`docker-compose.logging.yml` the `app` container correctly reports the `fluentd`
driver with no `max-size` — that overlay ships its log off-host instead.
