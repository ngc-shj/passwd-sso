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
    │   ├── backend.hcl              # state key for this env (committed)
    │   └── terraform.tfvars.example
    └── prod/
        ├── backend.hcl
        └── terraform.tfvars.example
```

## Quick Start

### 1. Setup

```bash
cd infra/terraform

# Copy the example tfvars and fill in actual values
cp envs/dev/terraform.tfvars.example envs/dev/terraform.tfvars
# Edit envs/dev/terraform.tfvars with real secrets

# The S3 backend is declared unconditionally, so its bucket and lock table must
# already exist (see "Remote State Backend"); -backend-config picks this env's
# state key.
terraform init -reconfigure -backend-config=envs/dev/backend.hcl
```

> **Secrets end up in Terraform state.** Any secret value passed via tfvars is
> written to `terraform.tfstate` in plaintext (see the SECURITY note in
> `secrets.tf`). Before applying with real secrets you MUST configure the
> encrypted S3 remote backend below — do not run a real deployment on local
> state. Every tfvars file is gitignored; never commit real secret values.

### 2. First-time bootstrap (NEW environment)

Bootstrapping a brand-new AWS environment has real ordering constraints that a
single `terraform apply` cannot satisfy on its own:

- The connection-string secrets (`DATABASE_URL`, `MIGRATION_DATABASE_URL`,
  `REDIS_URL`, the worker DB URLs) can only be built AFTER RDS/Redis exist and
  their endpoints + the AWS-managed RDS master password are known.
- **RDS does NOT run the `infra/postgres/initdb/*.sql` scripts** (those are for
  the Docker Postgres image only), so the least-privilege roles — `passwd_app`,
  `passwd_outbox_worker`, `passwd_retention_gc_worker`, `passwd_anchor_publisher`
  — must be created manually on RDS. `passwd_app` must exist BEFORE `prisma migrate deploy`, because some
  migrations conditionally GRANT/REVOKE privileges to it.
- The app/worker services start their tasks as soon as they exist, so their
  secrets and roles must be ready first.

Phased bootstrap. **Every service is created with `desired_count = 0` first** so
NO app/jackson/worker task starts against an un-migrated schema; the migration
runs; only then are the services scaled up. This is required because
`ignore_changes = [task_definition]` on the services only takes effect on
UPDATES — on first CREATE the service would otherwise launch tasks on the
initial task-def immediately, before `deploy.sh` runs the migration.

```bash
TFV="-var-file=envs/prod/terraform.tfvars"

# In terraform.tfvars set ALL desired counts to 0 for the bootstrap apply:
#   app_desired_count     = 0
#   jackson_desired_count = 0
#   worker_desired_count  = 0

# Phase A — network + data stores + registries + empty secret containers.
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

# Push the image (step 3), then inject ALL secret values built from the above:
#   app-secrets.json: DATABASE_URL (passwd_app@$DB_HOST), MIGRATION_DATABASE_URL
#   (master@$DB_HOST), REDIS_URL ($REDIS_HOST), OUTBOX_WORKER_DATABASE_URL,
#   RETENTION_GC_DATABASE_URL, AUDIT_ANCHOR_PUBLISHER_DATABASE_URL (password from
#   `openssl rand -hex 32`), the publisher's AUDIT_ANCHOR_SIGNING_KEY,
#   AUDIT_ANCHOR_TAG_SECRET and DEPLOYMENT_ID (see "Audit anchor publisher"),
#   plus the app secrets (AUTH_*, SHARE_MASTER_KEY, SESSION_TOKEN_HMAC_KEY, …).
scripts/put-terraform-secrets.sh --name-prefix passwd-sso-prod \
  --app-file ./app-secrets.json --jackson-file ./jackson-secrets.json

# Phase C — full apply. Every service is created at desired_count = 0 (no tasks
# start yet), and the migrate task def is registered. Then create the DB roles
# on RDS and run the migration (both need to reach RDS, which only the ECS SG
# can — see "Creating the DB roles on RDS" below).
terraform apply $TFV   # creates services at 0, registers migrate task def

# Create the least-privilege DB roles on RDS BEFORE the migration (passwd_app must
# exist first — some migrations GRANT to it). Use the migrate task via ECS Exec —
# see "Creating the DB roles on RDS" below for the exact commands.

# Run the migration (migrate task def; still with the services at 0):
CLUSTER=$(terraform output -raw ecs_cluster_name)
MIGRATE_TD=$(terraform output -raw migrate_task_definition_arn)
SUBNETS=$(terraform output -json private_subnet_ids | jq -r 'join(",")')
SG=$(terraform output -raw ecs_security_group_id)
aws ecs run-task --cluster "$CLUSTER" --task-definition "$MIGRATE_TD" \
  --launch-type FARGATE --region <region> \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG]}"
# wait for exit code 0 (aws ecs wait tasks-stopped + describe-tasks).

# Phase D — scale services up to steady state. Set the desired counts in
# terraform.tfvars to their real values (app_desired_count >= 2 for prod HA,
# jackson_desired_count, worker_desired_count = 1) and apply. Because the
# services already exist, ignore_changes = [task_definition] now holds, so this
# apply changes ONLY desired_count and starts tasks on the already-migrated
# schema. deploy.sh then advances every service to the current task-def revision.
terraform apply $TFV

# deploy.sh signs images and verifies signatures, so the deploy principal needs
# kms:Sign on the signing key. Attach once per environment (see "Image Signing"
# in docs/operations/deployment.md).
aws iam attach-role-policy --role-name <deploy-role> \
  --policy-arn "$(terraform output -raw image_signing_policy_arn)"

AWS_REGION=<region> ECR_URL=<app-ecr-url> TF_VAR_FILE=envs/prod/terraform.tfvars \
  ./scripts/deploy.sh
```

#### Creating the DB roles on RDS

RDS's security group allows 5432/TCP **only from the ECS security group**
(`network.tf`), so no operator laptop can reach it — there is no bastion. Create
the roles from INSIDE the VPC using the migrate task via **ECS Exec**. The
migrate task runs under a DEDICATED task role carrying the four `ssmmessages:*`
actions ECS Exec needs (`iam.tf`; the app/worker tasks do NOT get this). The
`node:alpine` base has no `psql` binary, so a version-controlled Node script,
`scripts/bootstrap-rds-roles.mjs` (baked into the image), does the work via the
`pg` module. It is idempotent and re-runnable: each role is guarded by a
`pg_roles` existence check, and the statements carry a SCRAM-SHA-256 verifier
computed in the script, never the password (DDL cannot use bind parameters —
`CREATE ROLE x PASSWORD $1` is a Postgres syntax error — so whatever is sent is
recorded by a refused-statement log line and by `pg_stat_statements`, which RDS
preloads). Passwords must be ASCII. Table-specific worker grants are issued later by the
Prisma migrations, exactly as with the Docker initdb path.

The RDS master is NOT a superuser (docs/setup/aws/en.md "RDS master users are
not SUPERUSER"), and the script adapts to that. Creating a role works as
everywhere else. For a role that already exists it writes only `LOGIN
NOCREATEDB NOCREATEROLE PASSWORD …`: it checks — not writes —
`SUPERUSER` / `BYPASSRLS` / `REPLICATION`. Before any statement carrying a
password it also checks that the connection has CREATEROLE and CREATEDB and
holds ADMIN OPTION on every existing role (the master has both attributes and
holds ADMIN OPTION on every role it created); a failure stops the run with
nothing sent, because a refused statement is written to the RDS log in full
(now a verifier, not the password). Role convergence and the privilege sequence run in one
transaction, so a run that does not print `bootstrap-rds-roles: done` changed
nothing. Clearing an escalated attribute needs a real
superuser, which on RDS means AWS support. A refusal no check can foresee (a
role dropped in between, a password-check hook, a read-only or cancelled
session) can still be logged — as a verifier. Runs made before `#941` sent the
cleartext: see `docs/operations/deployment.md` "Prior password exposure".

```bash
CLUSTER=$(terraform output -raw ecs_cluster_name)
MIGRATE_TD=$(terraform output -raw migrate_task_definition_arn)
SUBNETS=$(terraform output -json private_subnet_ids | jq -r 'join(",")')
SG=$(terraform output -raw ecs_security_group_id)

# Launch the migrate container idle, WITH the exec channel enabled.
RUN=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$MIGRATE_TD" \
  --launch-type FARGATE --region <region> --enable-execute-command \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG]}" \
  --overrides '{"containerOverrides":[{"name":"migrate","command":["sleep","3600"]}]}' \
  --output json)
TASK=$(echo "$RUN" | jq -r '.tasks[0].taskArn')
aws ecs wait tasks-running --cluster "$CLUSTER" --tasks "$TASK" --region <region>

# Open a shell in the task (MIGRATION_DATABASE_URL = master@RDS is in its env).
aws ecs execute-command --cluster "$CLUSTER" --task "$TASK" \
  --container migrate --interactive --command "/bin/sh" --region <region>
```

Inside the shell, export the four role passwords (the SAME values used to build
the `DATABASE_URL`, `OUTBOX_WORKER_DATABASE_URL`, `RETENTION_GC_DATABASE_URL` and
`AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` secrets injected in Phase B) and run the
bootstrap script. It exits before connecting if any of the four is unset:

```sh
export PASSWD_APP_PASSWORD='…'
export PASSWD_OUTBOX_WORKER_PASSWORD='…'
export PASSWD_RETENTION_GC_WORKER_PASSWORD='…'
export PASSWD_ANCHOR_PUBLISHER_PASSWORD='…'
node scripts/bootstrap-rds-roles.mjs   # idempotent; MIGRATION_DATABASE_URL is already in env
```

Exit the shell; the task exits when `sleep` ends (or `aws ecs stop-task` it).

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

Every ECS service has `ignore_changes = [task_definition]`, so a plain
`terraform apply` registers a new task-def revision but does NOT move the running
services — that is deliberate. `scripts/deploy.sh` owns the migration-first
ordering: it applies (task defs only), runs the DB migration, and only then
advances each service to the new revision (see
docs/operations/deployment.md).

```bash
# Steady-state deploy (build → push git-SHA tag → apply → migrate → roll services):
AWS_REGION=<region> ECR_URL=<app-ecr-url> TF_VAR_FILE=envs/prod/terraform.tfvars \
  ./scripts/deploy.sh
```

> Do NOT use `aws ecs update-service --force-new-deployment` for a version bump:
> it only restarts tasks on the SAME task definition (same old image), so it
> would redeploy the previous version. `--force-new-deployment` is only for
> same-tag content changes, which this repo's IMMUTABLE tags disallow anyway.

`deploy.sh` requires `cosign` on PATH and `kms:Sign` on the image-signing key: it
signs every image it pushes and refuses to deploy one whose signature does not
verify. Attach the policy once per environment:

```bash
aws iam attach-role-policy --role-name <deploy-role> \
  --policy-arn "$(terraform output -raw image_signing_policy_arn)"
```

Without this, an operator with ECR push rights but no `kms:Sign` can push an
image but cannot make `deploy.sh` accept it — which is the point of the control.
See docs/operations/deployment.md "Image Signing".

## Remote State Backend

`backend.tf` declares the encrypted S3 + DynamoDB backend **unconditionally**, so
it is not opt-in: `terraform init` fails until the bucket and the lock table
exist. Create them FIRST — see the comments in `backend.tf` for the exact
commands (bucket + versioning + encryption + public-access block + lock table).
Terraform state holds secret values in plaintext, so local state on a laptop or
in a CI artifact is a secret exposure; the remote backend provides at-rest
encryption (`encrypt = true`), versioning, and — via bucket policy/IAM — strict
access control and access logging.

### One state per environment

`backend.tf` hardcodes `key = "env/terraform.tfstate"`. That single key is shared
by every environment, so running `dev` and `prod` from this same directory would
make them collide in ONE state file. Each environment carries its own key in
`envs/<env>/backend.hcl`, selected at init time:

```bash
terraform init -reconfigure -backend-config=envs/dev/backend.hcl
terraform plan -var-file=envs/dev/terraform.tfvars
```

Switching environments requires re-running `init -reconfigure` with the other
`backend.hcl`. A mismatch between the backend key and `-var-file` points one
environment's state at the other's resources, so prefer a separate checkout or
git worktree per environment if you switch often.

### Variable files are never committed

Every tfvars form Terraform auto-loads is gitignored (`*.tfvars`,
`*.tfvars.json`, including `*.auto.tfvars`, at any depth under
`infra/terraform/`); only the `*.tfvars.example` templates are tracked. This
matters because tfvars is **not** secret-free: the 2026-07 review (F3) moved the
app/Jackson secret values out of Terraform, but `redis_auth_token` still has to
be passed as a variable — ElastiCache has no AWS-managed-token equivalent — so a
tracked variables file is a credential leak. `backend.hcl` holds only a state
key and IS committed.

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

### Adding a key to an existing app secret

`put-secret-value` replaces the whole JSON object, so adding one key (here
`AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`) is read-merge-write. The merged file holds
EVERY app secret in plaintext: create it under `umask 077` at a `mktemp` path
outside the repository, remove it with `trap … EXIT`, and never open it in an
editor or print it to a terminal that keeps scrollback or history. Run from
`infra/terraform`:

```bash
(
  set -euo pipefail
  umask 077
  MERGED=$(mktemp "${TMPDIR:-/tmp}/app-secrets.XXXXXX")
  trap 'rm -f "$MERGED"' EXIT

  ANCHOR_PW=$(openssl rand -hex 32)
  DB_HOST=$(terraform output -raw db_endpoint)
  # Passed to jq through the environment, not argv (visible in `ps`).
  # passwd_sso is var.db_name's default; use your value if you changed it.
  export ANCHOR_URL="postgresql://passwd_anchor_publisher:${ANCHOR_PW}@${DB_HOST}:5432/passwd_sso?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem"

  aws secretsmanager get-secret-value --region <region> \
    --secret-id "$(terraform output -raw app_secrets_arn)" \
    --query SecretString --output text \
    | jq 'if has("DATABASE_URL") then . + {AUDIT_ANCHOR_PUBLISHER_DATABASE_URL: env.ANCHOR_URL}
          else error("app secret has no DATABASE_URL — refusing to replace it") end' > "$MERGED"

  ../../scripts/put-terraform-secrets.sh --name-prefix passwd-sso-prod \
    --region <region> --app-file "$MERGED"
)
```

The subshell keeps `umask`, the trap and the password variables out of your
login shell; `pipefail` and the `has("DATABASE_URL")` guard stop a failed or
empty read from being written back as a one-key secret. The password
`bootstrap-rds-roles.mjs` needs as `PASSWD_ANCHOR_PUBLISHER_PASSWORD` is the
userinfo of that URL — the secret is its only copy.

### Required Secrets (app)

| Key | Description |
|-----|-------------|
| `DATABASE_URL` | PostgreSQL connection string (app role, NOSUPERUSER) |
| `MIGRATION_DATABASE_URL` | SUPERUSER connection string used by the migrate task (`prisma migrate deploy` DDL). Read the RDS master password from `db_master_user_secret_arn`. |
| `AUTH_URL` | Public app URL |
| `AUTH_SECRET` | Auth.js session encryption key |
| `AUTH_GOOGLE_ID` | Google OAuth Client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth Client Secret |
| `AUTH_JACKSON_ID` | Client ID of one Jackson connection (provider `saml-jackson`) — that connection's own `clientID`, never `dummy` or a `tenant=…&product=…` id. Empty string when SAML is unused. |
| `AUTH_JACKSON_SECRET` | That connection's own `clientSecret` |
| `AUTH_JACKSON_CONNECTIONS` | Further Jackson connections, as a JSON array string `[{"id","name","clientId","clientSecret"}]` — one provider `saml-jackson-<id>` each. Read only when `enable_jackson_connections = true`. With two or more SSO providers set `auth_claim_binding = "strict"` (the app refuses to start otherwise) after the root README's "SSO tenant claim binding upgrade". |
| `SHARE_MASTER_KEY` | Share links/sends encryption master key (256-bit hex) |
| `SESSION_TOKEN_HMAC_KEY` | Session-token HMAC key (256-bit hex). **Required in production** (env validation + runtime fail closed). Decouples session auth from master-key rotation. Mapped into the app ECS task. Generate with `npm run generate:key`. |
| `REDIS_URL` | Redis connection string |
| `OUTBOX_WORKER_DATABASE_URL` | Least-privilege DB URL for the audit-outbox-worker ECS service (`passwd_outbox_worker` role) |
| `RETENTION_GC_DATABASE_URL` | Least-privilege DB URL for the retention-gc-worker ECS service (`passwd_retention_gc_worker` role) |
| `VERIFIER_PEPPER_KEY` | Vault-data HMAC pepper (256-bit hex). **Required in production.** Mapped into the app ECS task. Generate with `npm run generate:key`. |
| `SMTP_USER` | SMTP username for magic-link email. Read only when `smtp_host` is set and `smtp_auth_enabled = true`; an empty string means an unauthenticated relay (ECS refuses a missing key). |
| `SMTP_PASS` | SMTP password, under the same conditions as `SMTP_USER`. |
| `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` | Least-privilege DB URL for the audit-anchor publisher ECS service (`passwd_anchor_publisher` role). `bootstrap-rds-roles.mjs` gives the role `LOGIN` with this password; the secret is its only copy. |
| `AUDIT_ANCHOR_SIGNING_KEY` | Ed25519 seed the publisher signs manifests with (32-byte hex). Mapped into the publisher task only. Generate with `npm run generate:audit-anchor-signing-key`. |
| `AUDIT_ANCHOR_TAG_SECRET` | HMAC secret for tenant tags in manifests (32-byte hex). Mapped into the publisher task only. Generate with `npm run generate:audit-anchor-tag-secret`. |
| `DEPLOYMENT_ID` | UUID naming this deployment in every manifest; the publisher refuses to boot when it differs from the one stored on its first boot. Generate once per deployment; reuse a stored value only for a successor of the same deployment whose predecessor is gone — a clone or a restored copy gets a new one. Mapped into the publisher task only. |

The four background workers run as dedicated ECS services
(`*-audit-outbox-worker`, `*-retention-gc-worker`, `*-audit-anchor-publisher`,
`*-audit-chain-verify-worker`) on the app image (`node dist/<worker>.js`),
`desired_count = var.worker_desired_count` (the publisher's capped at 1), no load
balancer. ECS restarts a crashed task automatically. Liveness is alarmed via
`RunningTaskCount < 1` (Container Insights) for the first three and by heartbeat
absence for the verify worker — see monitoring.tf. Without these workers, audit
events stay PENDING, retention is never enforced and nothing is anchored, so the
worker DB URLs and the publisher's keys above MUST be populated before apply.

> **Rotating `SESSION_TOKEN_HMAC_KEY`.** The session-token DB digest and the
> Redis session-cache key are both derived from this key, so changing it changes
> every digest → INVALIDATES ALL SESSIONS (every user re-authenticates). Use a
> hard cutover: (1) scale the app service to `desired_count = 0` so no old-key
> task can mint a session mid-rotation, (2) put the new value, (3) `DELETE FROM
> sessions` + flush the Redis session keyspace, (4) scale the app back up on the
> new key. Skipping step 1 lets an old task create an orphaned old-key session
> between the purge and the redeploy. See docs/operations/key-provider-setup.md.

### Required Secrets (jackson)

| Key | Description |
|-----|-------------|
| `JACKSON_API_KEYS` | Jackson API keys |
| `DB_URL` | PostgreSQL connection string |
| `NEXTAUTH_URL` | Jackson public URL |
| `EXTERNAL_URL` | Jackson external URL |
| `NEXTAUTH_SECRET` | Jackson session encryption key |

## Audit anchor publisher

`*-audit-anchor-publisher` (`ecs.tf`) signs one manifest per daily cadence
boundary (00:05 UTC) and writes it to the anchors bucket (`storage.tf`);
`*-audit-chain-verify-worker` walks every tenant's audit chain hourly and logs a
heartbeat. Both run on the app image.

| Variable | Default | Meaning |
|----------|---------|---------|
| `audit_anchor_s3_prefix` | `"audit-anchors"` | Key prefix the publisher writes under, and that every bucket-policy statement is built on. Validated by `modules/anchor-prefix` (rule below). The default is the rotation runbook's existing layout, so an existing environment's next plan needs no new value. |
| `audit_anchor_break_glass_role_arn` | `""` | IAM role ARN (validated as `arn:aws…:iam::<12 digits>:role/<name>`) of the operator allowed to write the rotation runbook's Step 4–5 objects. Empty: nobody may write those paths (an unconditional Deny). Set it before running those steps. |
| `audit_anchor_object_lock_days` | `2557` | Default COMPLIANCE retention of the bucket, validated `>= 2557`. The publisher sends its own retain-until (2555 days, 7 × 365) on every PUT; the bucket policy refuses a retention more than 31 days past this value, so raising it also raises that cap. |
| `enable_s3_audit_anchors` | `true` | Validated `true`: production refuses to boot without an anchor destination, and the S3 bucket is the only one this configuration wires. |

**Prefix rule.** One or more `/`-separated segments of `[A-Za-z0-9._-]`, none
`.` or `..`: no `*` or `?` (which would widen every policy statement) and no
leading, trailing or doubled `/` (which would make the documented keys differ
from the ones the publisher builds). `a`, `a/b`, `a.b` and `.a` are accepted;
`""`, `*`, `?`, `/a`, `a/`, `a//b`, `.`, `..`, `a/../b` and `a/./b` are refused.
The rule exists once in Terraform, as the variable validation of the
provider-less module `modules/anchor-prefix`; the root calls it unconditionally,
and the bucket policy, the publisher's IAM policy and its task env all read the
module's output. It is exercised without AWS credentials by `terraform test` in
that module against `prefix-vectors.json`, the same vectors the publisher's Zod
schema is tested with. The publisher itself accepts an unset or empty prefix
(bucket root) for deployments outside this Terraform; here it is always
non-empty, because the bucket policy needs it.

**Who may write what** (`aws_s3_bucket_policy.audit_anchors`; every statement is a
`Deny` with `Principal: "*"` and, where it has an exception, an `ArnNotEquals
aws:PrincipalArn` condition):

| Keys | Holds | Writer |
|------|-------|--------|
| `<prefix>/????-??-??.kid-*.jws` | daily manifests | the publisher's task role only |
| `<prefix>/key-rotation-*` | rotation advisory (runbook Step 4) | the break-glass role only |
| `<prefix>/public-keys/*` | public-key archive (runbook Step 5) | the break-glass role only |
| anything else | — | nobody, the publisher included |

On top of that: `s3:DeleteObject` and `s3:DeleteObjectVersion` are refused to
everyone; so are `s3:ReplicateObject`, `s3:ReplicateDelete` and
`s3:ReplicateTags` (a replica is written under those, not `s3:PutObject`, and
this bucket is never a replication destination); `s3:PutObjectRetention` is refused to all but those two roles;
`s3:PutLifecycleConfiguration` is refused on the bucket; a `PutObject` without
`x-amz-object-lock-mode: COMPLIANCE` (header absent included), with a retention
past the cap, or with SSE other than `AES256` is refused. The bucket has Object
Lock (always, independent of `enable_s3_object_lock`), versioning and SSE-S3
(never `s3_kms_key_arn`: a CMK scheduled for deletion would make locked evidence
unreadable), and `prevent_destroy`. The policy holds only while nobody replaces
it, and the account root always can: a change to the bucket's policy,
lifecycle, Object Lock or versioning configuration fires the EventBridge rule
`<name_prefix>-audit-anchor-bucket-config-change` (a Terraform apply that
touches them is the expected false positive). An existing anchors bucket
created without Object Lock needs an in-place step before the next plan — see
`docs/operations/deployment.md` "Existing anchors bucket without Object Lock".

**Services.**

- Publisher: its own task role (`*-ecs-audit-anchor-publisher-task`, only
  `s3:PutObject` and `s3:PutObjectRetention` on `<bucket>/<prefix>/*` — no read,
  list or delete; assumable by this account's ECS tasks only, `aws:SourceAccount`,
  and any `RunTask`/`StartTask` passing it as a task-role override fires the
  EventBridge rule `<name_prefix>-audit-anchor-publisher-role-override`; IAM
  changes to the role are not alarmed by this stack, see
  `docs/operations/alerts.md`); env `AUDIT_ANCHOR_PUBLISHER_ENABLED=true`, the bucket, the
  prefix and `AWS_REGION`; secrets `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`,
  `AUDIT_ANCHOR_SIGNING_KEY`, `AUDIT_ANCHOR_TAG_SECRET` and `DEPLOYMENT_ID` (no
  other task receives the last three). `desired_count = min(1,
  worker_desired_count)`, `deployment_maximum_percent = 100`,
  `deployment_minimum_healthy_percent = 0`: a deploy stops the old task (SIGTERM;
  it stops scheduling and finishes an in-flight run within `stopTimeout = 120`)
  before the new one starts, and the new task's boot run publishes the current
  boundary only if it is unpublished. Log group
  `/ecs/<name_prefix>/audit-anchor-publisher`.
- Verify worker: no task role (it calls no AWS API); its only secret is the app
  secret's `DATABASE_URL`, passed as `AUDIT_CHAIN_VERIFY_DATABASE_URL`. That is
  the `passwd_app` role, which reads every table the app reads and keeps every
  write the app has, though the worker reads only `tenants`,
  `audit_chain_anchors` and `audit_logs` — a dedicated read-only role is a
  follow-up (SC3). Log group `/ecs/<name_prefix>/audit-chain-verify-worker`.
- Both log groups are in the RLS bypass-report metric filters.
- The cluster sets ECS Exec session logging to `NONE` explicitly: the bootstrap's
  operator shell handles role passwords, and a transcript would keep them. The
  remaining audit of an exec session is CloudTrail's `ExecuteCommand`, alarmed by
  the EventBridge rule `<name_prefix>-ecs-execute-command` — which, like the
  bucket-configuration rule, receives events only from an account with a trail
  logging management events. Terraform defines no trail; see
  `docs/operations/deployment.md` "CloudTrail prerequisite".

**`DEPLOYMENT_ID`.** Generate once per deployment (`node -e
'console.log(crypto.randomUUID())'`) and add it to the app secret. Reuse a stored
value only for a successor of the same deployment whose predecessor is gone; a
clone or a restored copy generates a new one and follows the rotation runbook's
"DEPLOYMENT_ID change recovery". See `docs/operations/deployment.md`
"`DEPLOYMENT_ID`".

**Outputs** used by the runbooks and `scripts/deploy.sh`:
`audit_anchors_bucket_name`, `audit_anchor_s3_prefix`,
`audit_anchor_publisher_task_role_arn`, `ecs_audit_anchor_publisher_service_name`,
`ecs_audit_chain_verify_worker_service_name`,
`audit_anchor_publisher_task_definition_arn` and
`audit_chain_verify_worker_task_definition_arn`. `deploy.sh` advances and rolls
back all six services.

Alarms and what to do about each: `docs/operations/alerts.md`.

## Production Recommendations

- `db_skip_final_snapshot = false`, `db_deletion_protection = true`
- `db_multi_az = true`
- `redis_use_replication_group = true` + enable encryption/auth
- `nat_gateway_count = 2` (1 per AZ)
- `app_desired_count >= 2`
- If `create_acm_certificate = false`, set `acm_certificate_arn`
- When using CloudFront, ACM certificate must be in `us-east-1`
