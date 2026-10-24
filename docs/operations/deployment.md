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
- `terraform apply` sets `var.app_image` for the `app`, `migrate`, and all four worker task definitions, guaranteeing they run the same image
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
migration as a one-off ECS task → only then advance app + jackson + the four
workers to the new revision. New code never runs against an un-migrated schema.

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

### One-time upgrade: anchor publisher converged, DCR role retired

The release carrying migration `20261023010000_retire_dcr_cleanup_worker_role`
also makes the grant audit expect `passwd_anchor_publisher` to be a `LOGIN` role.
On RDS only `scripts/bootstrap-rds-roles.mjs` gives it `LOGIN` (the migration that
created it made it `NOLOGIN`), and that bootstrap needs the new image. So the
first `deploy.sh` of this release on an existing RDS deployment stops at the
audit by design. Before starting, add `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` to the
app secret (`infra/terraform/README.md` "Adding a key to an existing app
secret").

1. Run `./scripts/deploy.sh`. Its migrate task applies the retirement migration
   and then fails the audit; `deploy.sh` exits at the migrate step, before the
   rollback trap is armed or any `update-service` is issued, so the old services
   keep serving. The migration is compatible with the old image — nothing uses
   the DCR role.
2. Read the migrate task's log (group `/ecs/<name_prefix>/app`, stream prefix
   `migrate/`):

   ```bash
   aws logs tail /ecs/passwd-sso-prod/app --log-stream-name-prefix migrate/ \
     --since 1h --region <region>
   ```

   Proceed only if the audit findings are exactly this pair:

   ```
   UNEXPECTED_GRANT: ROLEATTR:passwd_anchor_publisher rolcanlogin false
   MISSING_GRANT: ROLEATTR:passwd_anchor_publisher rolcanlogin true
   ```

   Anything else — a `ROLE_STATE_VIOLATION`, a migration error, another key — is
   a stop: diagnose it before going on.
3. Run the new bootstrap through ECS Exec on the migrate task definition step 1
   just registered (`terraform output -raw migrate_task_definition_arn` now names
   it), exactly as in `infra/terraform/README.md` "Creating the DB roles on RDS",
   with all four passwords exported.
4. Re-run `./scripts/deploy.sh`. `prisma migrate deploy` is a no-op, the audit
   passes, and the services roll.

**Prior password exposure.** Before `#941` the bootstrap sent role passwords in
cleartext: `ALTER ROLE … NOSUPERUSER … PASSWORD '<cleartext>'` for every role,
which RDS refuses with 42501 and — under the default `log_min_error_statement` —
writes to the PostgreSQL log in full, and every `CREATE/ALTER ROLE` it sent was
kept verbatim by `pg_stat_statements`, which RDS preloads (`track_utility` on). It
now sends a SCRAM-SHA-256 verifier instead (see "What a logged verifier exposes"
below). For any RDS deployment where an earlier bootstrap ran:

- check `pg_stat_statements` from the `postgres` database — never `CREATE
  EXTENSION` in `passwd_sso`: its PUBLIC grants fail the grant audit on the next
  deploy. The view is cluster-wide; the query matches the password clause rather
  than the word (the app's `password_*` tables contain it) and prints a count, not
  the text:

  ```sql
  -- connected to the postgres database
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
  SELECT count(*) FROM pg_stat_statements
   WHERE query ~* '\m(ROLE|USER)\M.*\mPASSWORD\s+E?'''
     AND query NOT ILIKE '%PASSWORD ''SCRAM-SHA-256$%'
     AND query NOT ILIKE '%PASSWORD ''md5%';
  ```

  A non-zero count means cleartext is still held there: clear it with `SELECT
  pg_stat_statements_reset();` (needs EXECUTE on it; whether the RDS master holds
  that, and may create the extension in `postgres` and read other roles' query
  text, is unverified) — and rotate if it cannot be cleared or a snapshot taken
  since may hold it;
- confirm the RDS PostgreSQL logs from those runs have expired and were never
  downloaded or exported (this Terraform sets no
  `enabled_cloudwatch_logs_exports`; check whether anyone added it). "The logs
  expired" alone is not enough while `pg_stat_statements` may still hold the text;
- or rotate those roles' passwords in step 3: generate new values, write them into
  the `*_DATABASE_URL` app-secret keys first (the same read-merge-write), then
  export them for the bootstrap. The running old tasks hold the old passwords in
  their environment, so they cannot open NEW connections from step 3 until step
  4 replaces them — run step 3 immediately before step 4 and accept that window.
  The bootstrap is one transaction — role convergence and the privilege
  sequence commit together, and every role is checked before the first password
  is sent — so it either prints `bootstrap-rds-roles: done` and has applied
  everything, or has changed nothing. If it did not print that line, the
  database keeps the old passwords while the secret holds the new ones: restore
  the secret's previous version (`AWSPREVIOUS`) before any task restarts. If it
  did, keep the new secret. A connection lost during the final commit is the one
  ambiguous case: check which of the two passwords a role accepts before
  choosing.

### Audit anchor publisher on ECS

`*-audit-anchor-publisher` signs one manifest per daily cadence boundary (00:05
UTC) and writes it to the anchors bucket; `*-audit-chain-verify-worker` verifies
every tenant's chain hourly. The Terraform side — variables, the prefix rule, the
bucket policy, the task roles — is `infra/terraform/README.md` "Audit anchor
publisher"; the alarms are in `docs/operations/alerts.md`. This section is what
an operator does.

#### `DEPLOYMENT_ID`

Every manifest names its deployment by `DEPLOYMENT_ID` (an app-secret key mapped
into the publisher task only). The publisher stores it in `system_settings`
(`audit_anchor_deployment_id`) on its first boot and refuses to boot when the
value it is given differs (`DeploymentIdMismatchError`, one
`AUDIT_ANCHOR_PUBLISH_FAILED` row with `DEPLOYMENT_ID_MISMATCH`).

- **New deployment**: generate one, once: `node -e
  'console.log(crypto.randomUUID())'`.
- **Reuse a stored value only for a successor of the same deployment whose
  predecessor is gone** — the same database moved to new infrastructure, or a
  restore that replaces a deployment no longer running. Its database already
  holds the value, so the successor must be given the same one.
- **A clone, or a restored copy while the original still runs**, is a second
  deployment: generate a new value and follow "DEPLOYMENT_ID change recovery" in
  `docs/operations/audit-anchor-rotation-runbook.md`. The copy also inherits the
  original's manifest pointer and boundary marker (`system_settings`), so its
  first manifest's `previousManifest` names the original's last manifest, which
  is not in the copy's bucket.

To add it to the app secret of an existing deployment (read-merge-write, as in
`infra/terraform/README.md` "Adding a key to an existing app secret"; run from
`infra/terraform`):

```bash
(
  set -euo pipefail
  umask 077
  MERGED=$(mktemp "${TMPDIR:-/tmp}/app-secrets.XXXXXX")
  trap 'rm -f "$MERGED"' EXIT

  NEW_DEPLOYMENT_ID=$(node -e 'console.log(crypto.randomUUID())')
  export NEW_DEPLOYMENT_ID

  aws secretsmanager get-secret-value --region <region> \
    --secret-id "$(terraform output -raw app_secrets_arn)" \
    --query SecretString --output text \
    | jq 'if (has("DATABASE_URL") | not) then error("app secret has no DATABASE_URL — refusing to replace it")
          elif has("DEPLOYMENT_ID") then error("app secret already has DEPLOYMENT_ID — keep it (see the reuse rule)")
          elif (has("AUDIT_ANCHOR_SIGNING_KEY") and has("AUDIT_ANCHOR_TAG_SECRET") and has("AUDIT_ANCHOR_PUBLISHER_DATABASE_URL")) | not
            then error("app secret lacks a publisher key — add it before DEPLOYMENT_ID")
          else . + {DEPLOYMENT_ID: env.NEW_DEPLOYMENT_ID} end' > "$MERGED"
  [ -s "$MERGED" ] || { echo "merged secret is empty — refusing to write it" >&2; exit 1; }

  ../../scripts/put-terraform-secrets.sh --name-prefix passwd-sso-prod \
    --region <region> --app-file "$MERGED"
)
```

The filter refuses to overwrite a `DEPLOYMENT_ID` already present, and refuses to
run while a publisher key is missing: an ECS task whose secret names a missing
key does not start. A deployment created before this release has
`AUDIT_ANCHOR_SIGNING_KEY` and `AUDIT_ANCHOR_TAG_SECRET` already (the app task
used to receive them); `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` is added as in the
README.

#### Existing anchors bucket without Object Lock

The anchors bucket now always has Object Lock. The aws provider marks the
bucket's `object_lock_enabled` ForceNew, so on a bucket created without it
(`enable_s3_object_lock = false` before this release) the next plan would
REPLACE the bucket. `prevent_destroy` on the bucket makes such a plan fail
(`Instance cannot be destroyed`) rather than apply. Never answer that by
removing `prevent_destroy`, emptying the bucket or recreating it — it holds
versions, and the anchors are the evidence. Enable Object Lock in place first,
so the refreshed state already reads it as enabled:

```bash
B=$(terraform output -raw audit_anchors_bucket_name)

# 1. Is it already on? "ObjectLockEnabled": "Enabled" means nothing to do;
#    ObjectLockConfigurationNotFoundError means it is off.
aws s3api get-object-lock-configuration --bucket "$B" --region <region>

# 2. Object Lock can be enabled only on a versioned bucket: expect "Status": "Enabled".
aws s3api get-bucket-versioning --bucket "$B" --region <region>

# 3. Enable it in place. Irreversible. No Rule here: Terraform's
#    aws_s3_bucket_object_lock_configuration sets the COMPLIANCE default on apply.
aws s3api put-object-lock-configuration --bucket "$B" --region <region> \
  --object-lock-configuration '{"ObjectLockEnabled":"Enabled"}'

# 4. Plan. aws_s3_bucket.audit_anchors must show no replacement (no "-/+",
#    no "must be replaced"); the object-lock configuration, policy and
#    encryption resources are created or updated in place.
terraform plan -var-file=envs/prod/terraform.tfvars
```

If step 4 still plans a replacement, stop and diagnose; do not apply. Objects
written before step 3 keep no retention: Object Lock applies to versions written
after it. Whether the provider version in use reads the enabled state back on
refresh is checked in the manual test
(`docs/archive/review/aws-anchor-publisher-verify-worker-manual-test.md`).

#### CloudTrail prerequisite

Three EventBridge rules — `<name_prefix>-ecs-execute-command`,
`<name_prefix>-audit-anchor-bucket-config-change` and
`<name_prefix>-audit-anchor-publisher-role-override` — match "AWS API Call via
CloudTrail" events, which EventBridge receives only from an account with a trail
logging management events. Terraform defines no trail. Before relying on those
rules, have one in the region (an organisation trail counts) that:

- logs **management events** (write events at least: `ExecuteCommand`,
  `PutBucketPolicy`, `PutObjectLockConfiguration`, `RunTask`, … are writes), and
- has a **data-event selector on the anchors bucket** (`AWS::S3::Object`, ARN
  prefix `arn:aws:s3:::<bucket>/`): it records the break-glass role's Step 4–5
  writes and any refused write attempt, which no rule here alarms on.

```bash
aws cloudtrail describe-trails --region <region>
aws cloudtrail get-trail-status --name <trail> --region <region>       # IsLogging: true
aws cloudtrail get-event-selectors --trail-name <trail> --region <region>
```

`put-event-selectors` REPLACES every selector on the trail, so read the current
ones first and send them back with the anchors-bucket selector added; never send
the bucket selector alone. With advanced selectors the addition is:

```json
{
  "Name": "Audit anchors bucket object writes",
  "FieldSelectors": [
    { "Field": "eventCategory", "Equals": ["Data"] },
    { "Field": "resources.type", "Equals": ["AWS::S3::Object"] },
    { "Field": "readOnly", "Equals": ["false"] },
    { "Field": "resources.ARN", "StartsWith": ["arn:aws:s3:::<bucket>/"] }
  ]
}
```

```bash
aws cloudtrail put-event-selectors --trail-name <trail> --region <region> \
  --advanced-event-selectors file://selectors.json   # the existing ones + the above
```

The manual test checks both: an exec session produces the SNS notification, and
a bucket-configuration change produces one.

#### First publish

- **No chain-enabled tenant**: every boundary reports `skipped_no_tenants` with
  `everChainEnabled: false`. That is healthy, and it is what keeps the
  cadence-absent alarm OK; nothing is written to the bucket and no attempt is
  counted.
- **Once a tenant enables the chain**, the next boundary (or the next boot run)
  publishes, and reports `MISSING_PRIOR_CADENCE_PUBLICATION` once — a warn line
  `audit-anchor-publisher.missing_prior_cadence` and one
  `AUDIT_ANCHOR_PUBLISH_FAILED` row — because no earlier manifest exists. It is
  expected exactly once; a later one means a boundary was never committed.
- A deploy across a boundary: the old task drains and stops before the new one
  starts; the new task's boot run publishes the boundary if it is unpublished,
  otherwise reports `skipped_already_published`.
- The verify worker's `audit-chain-verify-heartbeat` appears hourly from its
  first tick.

Check the publisher's lines:

```bash
aws logs tail /ecs/passwd-sso-prod/audit-anchor-publisher --since 2d --region <region> \
  --filter-pattern '{ $._logType = "audit-anchor-publisher.cadence" }'
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

Background workers: `audit-outbox-worker` (drains `audit_outbox` → `audit_logs`)
and `retention-gc-worker` (enforces retention / hard-deletes). On AWS they are
dedicated Terraform-managed ECS services (`infra/terraform/ecs.tf`); on Docker
Compose they are in `docker-compose.workers.yml` (production) /
`docker-compose.override.yml` (dev tsx). Without them, audit events accumulate as
`PENDING` and retention is never enforced. On AWS two more run as ECS services,
`audit-anchor-publisher` and `audit-chain-verify-worker` ("Audit anchor publisher
on ECS" above); the compose files do not define them yet (SC1) — run them with
`npm run worker:audit-anchor-publisher` and `npm run worker:audit-chain-verify`.

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

The application uses these database roles with separated privileges:

| Role | Privileges | Purpose |
|------|-----------|---------|
| `passwd_user` (or equivalent) | DDL-capable (`rds_superuser`-class on RDS) | Table owner, migrations (`prisma migrate deploy`), one-shot data migrations |
| `passwd_app` (or equivalent) | NOSUPERUSER NOBYPASSRLS | App runtime (Next.js), RLS enforced. Also the audit-chain verify worker's role on ECS, which needs only reads of `tenants`, `audit_chain_anchors` and `audit_logs` but can read every table the app reads and holds every write the app has; a dedicated read-only role is a follow-up (SC3) |
| `passwd_outbox_worker` (or equivalent) | NOSUPERUSER NOBYPASSRLS; SELECT/UPDATE/DELETE on `audit_outbox`, INSERT on `audit_logs`, SELECT on `tenants` | Audit outbox drain worker (least privilege) |
| `passwd_retention_gc_worker` (or equivalent) | NOSUPERUSER NOBYPASSRLS; scoped DELETE/SELECT on the retention-swept tables | Retention GC worker (least privilege) |
| `passwd_anchor_publisher` | NOSUPERUSER NOBYPASSRLS; SELECT + column-scoped UPDATE on `audit_chain_anchors`, INSERT on `audit_outbox`, SELECT/INSERT/UPDATE on `system_settings`, SELECT on `tenants` | Audit-anchor publisher (least privilege) |
| `passwd_dcr_cleanup_worker` | **Retired** — NOLOGIN, no password, nothing beyond `PUBLIC` (migration `20261023010000`) | None. Kept only so older dumps that name it still restore; the grant audit asserts the retired state |

> **`rds_superuser` is a role MEMBERSHIP, not a role ATTRIBUTE.** On RDS the
> master user is a member of `rds_superuser` but has `rolsuper = false` and
> `rolbypassrls = false` (RDS creates it `NOSUPERUSER`, and `BYPASSRLS`
> defaults to `NOBYPASSRLS` when unspecified). Tables carrying `FORCE ROW
> LEVEL SECURITY` therefore bind that role too — including the table owner.
>
> Anything that must read across tenants (the one-shot data migrations,
> `scripts/tenant-domain.ts`) must open a `withBypassRls` transaction rather
> than rely on a role attribute. Skipping it does not error: the read returns
> zero rows and the job reports a clean, empty success.
>
> **`tenants` itself is under this same FORCE RLS** (#923) — it is the
> tenancy root, not an exception. A data migration or ad-hoc SQL run as the
> owner that reads or writes `tenants` on RDS must set a scope
> (`SET LOCAL app.tenant_id = …`) or the bypass GUCs (`SET LOCAL
> app.bypass_rls = 'on'` + `app.bypass_tables`), transaction-locally, exactly
> like a read of any other RLS table — never session-wide (`ALTER ROLE …
> SET app.*` / `ALTER DATABASE … SET app.*`, which `audit-db-grants.mjs`
> already flags as drift).

On AWS RDS these roles are NOT auto-created (the `infra/postgres/initdb/*.sql`
scripts run only on the Docker Postgres image) — create them during bootstrap,
before the first migration, with `scripts/bootstrap-rds-roles.mjs`, which
converges the four login roles above (not `passwd_user`, not the retired DCR
role). See `infra/terraform/README.md` "First-time bootstrap".

### Ownership of role attributes vs table ACLs

These are owned by different things, which matters when auditing:

| Aspect | Owner | Converged by a re-run? |
|--------|-------|------------------------|
| Role attributes (`NOSUPERUSER`, `NOBYPASSRLS`, `NOREPLICATION`, …), password, role memberships | `scripts/bootstrap-rds-roles.mjs` | Yes — always re-applied and asserted. As a non-superuser (the RDS master) it cannot write `SUPERUSER` / `BYPASSRLS` / `REPLICATION`: those are checked, and the run stops before sending the password if one is set |
| `passwd_app` schema + table ACLs | `scripts/bootstrap-rds-roles.mjs` | Yes — revoke-then-grant |
| Worker table ACLs (`passwd_outbox_worker`, `passwd_retention_gc_worker`, `passwd_anchor_publisher`) | The Prisma migrations that create each table | **No** |
| The retired `passwd_dcr_cleanup_worker` | Migration `20261023010000_retire_dcr_cleanup_worker_role` | n/a — asserted by the audit (`RETIRED_ROLES`) |

The worker table ACLs cannot be converged by the bootstrap: it runs *before* the
first migration, so those grants do not exist yet, and a blanket
`REVOKE ALL ON ALL TABLES` on a re-run would strip exactly what the migrations
installed. A privilege granted to a worker out of band is therefore **not**
removed by re-running the bootstrap.

Detection runs automatically on **every deploy**: the migrate task's command is
`prisma migrate deploy && node scripts/audit-db-grants.mjs`
(`infra/terraform/ecs.tf`), so a migration that grants more than the manifest
sanctions fails the migrate task — and `deploy.sh` aborts before any service is
advanced. The audit needs a DDL-capable connection and RDS admits only the ECS
security group, so the migrate task is the only place it can run.

To run it manually against a deployed database:

```bash
MIGRATION_DATABASE_URL=<superuser-url> node scripts/audit-db-grants.mjs
```

It diffs the live ACLs of every audited role (`AUDITED_ROLES`: `passwd_app`,
`passwd_outbox_worker`, `passwd_retention_gc_worker`, `passwd_anchor_publisher`
and the retired `passwd_dcr_cleanup_worker`) against
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
| `MEMBER:<role> <granted_role> admin=<t\|f>,inherit=<t\|f>,set=<t\|f>` | role membership — an inheritance path; the audited roles should have none. Also every membership IN a retired role. An ADMIN-only row (`inherit=f,set=f`) into a retired role held by a non-audited role is allowed and left out of the manifest comparison: PostgreSQL 16 gives one to the non-superuser role that created the role (on RDS, the master), a deliberately granted one cannot be told apart from it, and neither confers its privileges. `roleStateViolations` decides, not the query |
| `PUBLIC:<schema>.<table> <priv>` | granted to `PUBLIC`, so inherited by every role |
| `SCHEMA:<grantee> <schema> <priv>` | `USAGE`/`CREATE` (`CREATE` lets the role add its own objects) |
| `SEQUENCE:<grantee> <schema>.<seq> <priv>` | `USAGE`/`SELECT`/`UPDATE` |
| `FUNCTION:<grantee> <schema>.<identity> EXECUTE` | routine `EXECUTE`, suffixed `SECURITY_DEFINER` when it runs with its owner's privileges |
| `DATABASE:<grantee> <db> <priv>` | `CONNECT`/`CREATE`/`TEMP` |
| `DEFAULTACL:<owner> <schema> <type> <acl>` | pre-authorises objects that do not exist yet |
| `ROLEATTR:<role> <attr> <value>` | `SUPERUSER`/`BYPASSRLS`/`REPLICATION`/`CREATEDB`/`CREATEROLE`/`LOGIN` |
| `ROLESETTING:<role\|*> <db\|*> <name>=<value>` | a session default from `ALTER ROLE/DATABASE … SET` (`*` = every role / every database). It applies to every connection, invisibly to the connection's own options. Settings named `app.*`, `client_min_messages`, `log_min_messages` or `row_security` are refused outright (`DENIED_SETTING_*`), live and in the manifest |

The manifest is descriptive, so two findings make some states unrecordable
regardless of what it says. `ROLE_STATE_VIOLATION` (live) and
`ROLE_STATE_IN_MANIFEST` (the manifest records one) cover: an elevated attribute
(`SUPERUSER`/`BYPASSRLS`/`REPLICATION`/`CREATEDB`/`CREATEROLE`) or any membership
on an audited role; any `PUBLIC:` table grant; and a retired role that can log
in, that another role can act as (an `inherit` or `set` membership in it), that
a default ACL names, or that holds any privilege `PUBLIC` does not also hold.
A `MEMBER` key that does not parse as exactly that three-field form is itself a
violation. `--write` refuses while a live violation exists.

Columns are keyed individually on purpose: a table that legitimately carries
`UPDATE (fail_count)` must still fail the audit if `UPDATE (secret_encrypted)` is
added.

`FUNCTION` matters because PostgreSQL grants `EXECUTE` on new routines to
`PUBLIC` by default. A `SECURITY DEFINER` routine is therefore callable by every
role unless a migration revokes it — and it runs with its **owner's** privileges,
which no table-level audit would reveal. Role attributes are re-asserted on every
deploy because migrations run as the table owner and can re-grant them, so the
bootstrap-time convergence is not durable on its own.

When a migration intentionally changes a grant, regenerate the manifest with
`--write` and review the diff — that diff is the security-relevant part of the
migration.

```sql
-- Production: create a non-superuser application role. No PASSWORD clause here:
-- a cleartext literal would be logged on a refused statement, under
-- log_statement=ddl|all, and kept by pg_stat_statements. Set it below with
-- \password, which sends a verifier computed client-side.
CREATE ROLE passwd_app LOGIN NOSUPERUSER NOBYPASSRLS;
-- The settings that record statement text (scripts/lib/statement-text-settings.mjs):
SET password_encryption = 'scram-sha-256';
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET log_transaction_sample_rate = 0;
SET debug_print_parse = off;
SET debug_print_rewritten = off;
SET debug_print_plan = off;
SET pg_stat_statements.track_utility = off;
\password passwd_app
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE passwd_sso TO passwd_app;
GRANT USAGE ON SCHEMA public TO passwd_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO passwd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO passwd_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO passwd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO passwd_app;
-- The migrations that create these routines grant EXECUTE only to roles that
-- exist when they run, so a role created after migrating needs them here (run
-- after `prisma migrate deploy`; the routines must exist). Every RLS policy
-- calls the rls_bypass_* functions; the SECURITY DEFINER audit routines are the
-- app role's only path to purge or re-tenant audit_logs.
GRANT EXECUTE ON FUNCTION public.rls_bypass_admits(text), public.rls_bypass_enforced() TO passwd_app;
GRANT EXECUTE ON FUNCTION public.audit_log_purge(uuid, timestamptz) TO passwd_app;
GRANT EXECUTE ON PROCEDURE public.audit_log_tenant_migrate(uuid, uuid, uuid) TO passwd_app;
```

**Environment variables:**
- `DATABASE_URL` — app runtime connection (`NOSUPERUSER NOBYPASSRLS` role, e.g. `passwd_app`)
- `MIGRATION_DATABASE_URL` — Prisma CLI connection (SUPERUSER role, e.g. `passwd_user`)
- `OUTBOX_WORKER_DATABASE_URL` — audit outbox worker connection (least-privilege role, e.g. `passwd_outbox_worker`). Set the worker role password with `scripts/set-outbox-worker-password.sh`.
- `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` — audit-anchor publisher connection (`passwd_anchor_publisher`). On RDS the role's password is set by `scripts/bootstrap-rds-roles.mjs` from `PASSWD_ANCHOR_PUBLISHER_PASSWORD`.

The Docker Compose dev setup enforces the same role separation: the `app` service connects as `passwd_app` (NOSUPERUSER, NOBYPASSRLS) while the `migrate` service connects as `passwd_user` (SUPERUSER). RLS is enforced in all environments.

**Existing dev volumes.** `npm run db:migrate` retires `passwd_dcr_cleanup_worker`
on its own. `passwd_anchor_publisher`, though, is `NOLOGIN` on a volume created
before `infra/postgres/initdb/02-create-app-role.sql` gained it (the migration
that created it there makes it `NOLOGIN`), and on any volume initialised without
`PASSWD_ANCHOR_PUBLISHER_PASSWORD` set — the initdb no longer falls back to a
published password — while the grant audit expects `LOGIN`. Set
`PASSWD_ANCHOR_PUBLISHER_PASSWORD` in `.env` to the password your
`AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` carries. Check with
`docker compose exec -T db psql -U passwd_user -d passwd_sso -Atc "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'passwd_anchor_publisher'"`;
if it prints `f`, give it `LOGIN` and set the password:

```bash
# Recreate db so it carries .env's current value; the volume is kept. Compose,
# not the shell, reads .env (it is not shell syntax, and init:env quotes values).
docker compose up -d db
docker compose exec -T db sh -c '
  [ -n "$PASSWD_ANCHOR_PUBLISHER_PASSWORD" ] || { echo "PASSWD_ANCHOR_PUBLISHER_PASSWORD is not set in the db container" >&2; exit 1; }
  printf "%s\n%s\n" "$PASSWD_ANCHOR_PUBLISHER_PASSWORD" "$PASSWD_ANCHOR_PUBLISHER_PASSWORD" \
    | psql -X -v ON_ERROR_STOP=1 -U passwd_user -d passwd_sso -q \
        -c "SET password_encryption = '\''scram-sha-256'\''; SET log_statement = '\''none'\''; SET log_min_error_statement = '\''panic'\''; SET log_min_duration_statement = -1; SET log_min_duration_sample = -1; SET log_transaction_sample_rate = 0; SET debug_print_parse = off; SET debug_print_rewritten = off; SET debug_print_plan = off; SET pg_stat_statements.track_utility = off" \
        -c "\password passwd_anchor_publisher" \
        -c "ALTER ROLE passwd_anchor_publisher WITH LOGIN"'
```

`LOGIN` comes last, after the guard and the password: an unset variable stops the
procedure with the role unchanged. `\password` sends a verifier computed client-side, never the password. It reads
the two lines from stdin only because `exec -T` gives psql no terminal — with one
it would prompt instead, which is why `scripts/set-*-password.sh` do not use it.
The value comes from the `db` container's environment (as for Jackson below), and
`printf` is a shell builtin, so it reaches no process argument list.

**Existing self-hosted volumes: the anchor publisher's published password.**
Until this release, `docker-compose.yml` never forwarded
`PASSWD_ANCHOR_PUBLISHER_PASSWORD` to `db`, so every volume initialised since
`02-create-app-role.sql` gained the role has `passwd_anchor_publisher` as a
`LOGIN` role whose password, `passwd_anchor_publisher_pass`, is in this
repository — usable by any process on the compose network. On every such
deployment, once:

- if you run the publisher, rotate it: `scripts/set-audit-anchor-publisher-password.sh
  < <(printf '%s' "$NEW_PASSWORD")`, then put the same value in
  `PASSWD_ANCHOR_PUBLISHER_PASSWORD` and `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` in
  `.env`;
- if you do not, `ALTER ROLE passwd_anchor_publisher NOLOGIN` — the grant audit
  then reports `rolcanlogin` against its manifest, which expects `LOGIN`.

Check over a password path — the local socket and loopback are `trust` in the
`postgres` image, so only `-h db` tests the password:
`docker compose exec -T -e PGPASSWORD=passwd_anchor_publisher_pass db psql -h db -U passwd_anchor_publisher -d passwd_sso -c 'select 1'`
must fail with `password authentication failed` (rotated) or `not permitted to
log in` (`NOLOGIN`).

**Role passwords must be ASCII.** `scripts/bootstrap-rds-roles.mjs` and
`scripts/set-*-password.sh` compute the SCRAM verifier themselves, without the
SASLprep normalisation the server and node-postgres apply (it is the identity for
ASCII), so they refuse any other character. A value that worked before but is not
ASCII must be rotated to one that is, e.g. `openssl rand -hex 32`.

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
    | psql -X -v ON_ERROR_STOP=1 -U passwd_user -d postgres -q \
        -c "SET password_encryption = '\''scram-sha-256'\''; SET log_statement = '\''none'\''; SET log_min_error_statement = '\''panic'\''; SET log_min_duration_statement = -1; SET log_min_duration_sample = -1; SET log_transaction_sample_rate = 0; SET debug_print_parse = off; SET debug_print_rewritten = off; SET debug_print_plan = off; SET pg_stat_statements.track_utility = off" \
        -c "\password jackson_user"'
```

The SETs are not decoration. `\password` hashes with the session's
`password_encryption`, and an `md5` hash works as the password itself under md5
authentication, hence the first. It then issues `ALTER USER ... PASSWORD
'SCRAM-SHA-256$4096:...'`, which is DDL — so under `log_statement=ddl` or `all`
the **verifier** is written to the `db` container log, which this stack retains at
20 MB × 5, and a refused one is logged under the default
`log_min_error_statement=error`, and duration or sampled logging, the debug_print_*
parse trees and `pg_stat_statements` record it too; the rest of the SETs (the list
in `scripts/lib/statement-text-settings.mjs`) keep it out. If that log has been
exported anywhere, rotate `PASSWD_JACKSON_PASSWORD`.

**What a logged verifier exposes.** Not the password. It allows an offline guess
against at least 4096 PBKDF2 iterations of it — slow against a generated secret
(`openssl rand -hex 32`). And because it holds both StoredKey and ServerKey,
whoever has it can pose as the server to a client that does not authenticate the
server (no `sslmode=verify-full`, no `channel_binding=require`), take ClientKey
from one exchange, and log in. The app on AWS connects with `verify-full`;
operator `psql` sessions and a self-hosted network without TLS do not — rotate
after a verifier leaks there.

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
