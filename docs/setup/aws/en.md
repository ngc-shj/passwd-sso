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
- `audit-outbox-worker` + `retention-gc-worker` (dedicated ECS services, Terraform-managed)
- `audit-anchor-publisher` + `audit-chain-verify-worker` (dedicated ECS services, Terraform-managed)
- `audit-anchors` S3 bucket (Object Lock COMPLIANCE, written only by the publisher)

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

    Publisher["audit-anchor-publisher<br/>ECS/Fargate"] --> RDS
    Publisher --> |signed manifest, daily| Anchors["S3 audit-anchors<br/>(Object Lock)"]
    Verifier["audit-chain-verify-worker<br/>ECS/Fargate"] --> RDS

    Secrets["Secrets Manager"] -.-> |Task env vars| App
    Secrets -.-> |Task env vars| Jackson
    Secrets -.-> |Task env vars| Worker
    Secrets -.-> |Task env vars| Publisher
    Secrets -.-> |Task env vars| Verifier
```

> **Note**: `audit-outbox-worker` (drains `audit_outbox` → `audit_logs`) and
> `retention-gc-worker` (enforces retention / hard-deletes) are long-running
> processes defined as dedicated Terraform-managed ECS services. Without them,
> audit events accumulate as `PENDING` and retention is never enforced. See
> [Background worker services](#background-worker-services-terraform-managed).

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
- `RETENTION_GC_DATABASE_URL` (least-privilege role `passwd_retention_gc_worker` — used by retention-gc-worker)
- `AUTH_SECRET`
- `AUTH_GOOGLE_ID`
- `AUTH_GOOGLE_SECRET`
- `AUTH_JACKSON_ID` (the Jackson connection's own `clientID`; empty string when SAML is unused)
- `AUTH_JACKSON_SECRET` (that connection's own `clientSecret`)
- `SHARE_MASTER_KEY`
- `REDIS_URL` (REQUIRED in production — see [Redis](#app-service))
- `BLOB_BACKEND`
- `JACKSON_API_KEY` (passed to the Jackson container as `JACKSON_API_KEYS` — note the trailing `S`)
- `PASSWD_OUTBOX_WORKER_PASSWORD` (sets the `passwd_outbox_worker` DB role password; on AWS rotate it by re-running `scripts/bootstrap-rds-roles.mjs` with the new value — the image has no `psql`, which `scripts/set-*-password.sh` need)
- `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` (least-privilege role `passwd_anchor_publisher` — used by audit-anchor-publisher; in production it has no `DATABASE_URL` fallback)
- `AUDIT_ANCHOR_SIGNING_KEY`, `AUDIT_ANCHOR_TAG_SECRET` (mapped into the publisher task only; the app no longer receives them)
- `DEPLOYMENT_ID` (a UUID naming this deployment in every manifest; publisher task only — see [Audit anchor publisher](#audit-anchor-publisher))
- `PASSWD_ANCHOR_PUBLISHER_PASSWORD` is not stored on its own: it is an input to `scripts/bootstrap-rds-roles.mjs` only, taken from the userinfo of `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` (a second stored copy could drift from the URL)

Optional:
- `AUTH_JACKSON_CONNECTIONS` (further Jackson connections, one provider `saml-jackson-<id>` each; Terraform reads it only with `enable_jackson_connections = true`)
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
npm run generate:audit-anchor-signing-key -- --out /secure/path/signing-key.hex  # mode 0600, outside the repo
npm run generate:audit-anchor-tag-secret -- --out /secure/path/tag-secret.hex     # mode 0600, outside the repo
node -e 'console.log(crypto.randomUUID())'  # DEPLOYMENT_ID (once per deployment)
```

## RDS (PostgreSQL)

- Use PostgreSQL 16
- Enable backups and Multi-AZ if required
- Set `DATABASE_URL` as:
```
postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem
```

### TLS is mandatory, and verified

**Every** DB URL that points at RDS needs those two parameters — `DATABASE_URL`,
`MIGRATION_DATABASE_URL`, `OUTBOX_WORKER_DATABASE_URL`,
`RETENTION_GC_DATABASE_URL`, `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`, and
Jackson's `DB_URL`. Two independent reasons:

- RDS PostgreSQL 15+ ships `rds.force_ssl = 1`, so a plaintext connection is
  rejected at authentication time: `no pg_hba.conf entry for host "...", no
  encryption`.
- Current node-postgres treats `sslmode=require` as `verify-full`, and RDS
  certificates chain to Amazon's own RDS CAs, which are in no public trust
  store. Without `sslrootcert` the handshake fails with
  `SELF_SIGNED_CERT_IN_CHAIN`.

The Dockerfile fetches the Amazon RDS global CA bundle to
`/app/certs/rds-global-bundle.pem` under a pinned SHA-256, so that path is
already present in the app, worker and migrate containers. Point `sslrootcert`
somewhere else if you prefer a single-region bundle.

Local Docker Compose runs a plain PostgreSQL container with no `force_ssl`, so
these parameters are AWS-only — the compose URLs stay as they are. That asymmetry
is why the requirement is invisible until you deploy: a fully green local test
suite says nothing about it.

### RDS master users are not SUPERUSER

The master user created by `manage_master_user_password` is an `rds_superuser`,
not a real PostgreSQL superuser (`pg_user.usesuper` is false). Anything needing
true superuser fails with SQLSTATE 42501, including:

- `ALTER ROLE ... NOSUPERUSER / NOBYPASSRLS / NOREPLICATION` — even when the
  attribute already has that value. `CREATE ROLE ... NOSUPERUSER` is fine.
  `scripts/bootstrap-rds-roles.mjs` therefore re-converges an existing role
  without those clauses when it is not connected as a superuser. Before any
  statement that carries a password it checks, for every role, that the
  connection has CREATEROLE and CREATEDB (a role without CREATEDB may not send
  even a no-op `NOCREATEDB`), that it holds ADMIN OPTION on each existing role,
  and that none has `rolsuper` / `rolbypassrls` / `rolreplication` set (only AWS
  support can clear those); any failure stops the run with nothing sent. All
  roles converge in the same transaction as the privilege sequence, so a run
  that fails anywhere leaves no role changed.
  The master has CREATEROLE and CREATEDB and holds ADMIN OPTION on every role it
  created. What no check can see — a role dropped in between, a password-check
  hook in a custom parameter group, a read-only or cancelled session — can
  still refuse the statement and log it. What it logs is a SCRAM-SHA-256
  verifier: the script never sends the password (see
  `docs/operations/deployment.md` "Prior password exposure" for runs made before
  that).
- Attaching a placeholder GUC to a routine (`CREATE FUNCTION ... SET app.x`),
  and `GRANT SET ON PARAMETER` to work around it.

Session-level `SET app.x` and `set_config('app.x', ..., true)` are unrestricted.

## ECS/Fargate Services

### app service

Env vars:
- `DATABASE_URL` (RDS)
- `AUTH_URL` (public URL of app)
- `AUTH_SECRET`
- `AUTH_GOOGLE_ID`
- `AUTH_GOOGLE_SECRET`
- `GOOGLE_WORKSPACE_DOMAINS` (optional)
- `JACKSON_URL` (Jackson's public URL, the same as its `EXTERNAL_URL`; Terraform sets `https://<jackson_domain>`)
- `AUTH_JACKSON_ID`, `AUTH_JACKSON_SECRET` (one connection's own client credentials — provider `saml-jackson`)
- `AUTH_JACKSON_CONNECTIONS` (optional — further connections)
- `AUTH_CLAIM_BINDING` (`strict` when two or more SSO providers are configured — the app refuses to start otherwise; Terraform variable `auth_claim_binding`. On an existing deployment, run the README's [SSO tenant claim binding upgrade](../../../README.md#sso-tenant-claim-binding-upgrade) first)
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
- `FLATTEN_RAW_CLAIMS=false` (Terraform sets it. With `true`, an IdP can override the id_token's `nonce` and `requested` fields, which the SAML connection binding relies on)

### Background worker services (Terraform-managed)

The Terraform (`infra/terraform/ecs.tf`) defines four background workers as
dedicated ECS/Fargate services on the same image as `app`, `desired_count =
var.worker_desired_count` (0 for the bootstrap apply, 1 in steady state; the
publisher is capped at 1), no load balancer. ECS restarts a crashed task
automatically; liveness is alarmed via `RunningTaskCount < 1` (Container
Insights) for the outbox, retention-GC and publisher services, and by the
heartbeat's absence for the verify worker. No operator setup is needed beyond
populating the secret keys below before apply.

| Service | Command | DB URL secret (role) |
|---------|---------|----------------------|
| `*-audit-outbox-worker` | `node dist/audit-outbox-worker.js` | `OUTBOX_WORKER_DATABASE_URL` (`passwd_outbox_worker`) |
| `*-retention-gc-worker` | `node dist/retention-gc-worker.js` | `RETENTION_GC_DATABASE_URL` (`passwd_retention_gc_worker`) |
| `*-audit-anchor-publisher` | `node dist/audit-anchor-publisher.js` | `AUDIT_ANCHOR_PUBLISHER_DATABASE_URL` (`passwd_anchor_publisher`) |
| `*-audit-chain-verify-worker` | `node dist/audit-chain-verify-worker.js` | the app secret's `DATABASE_URL`, as `AUDIT_CHAIN_VERIFY_DATABASE_URL` (`passwd_app`) |

The verify worker connects as `passwd_app` and so holds far more than it uses:
it only reads `tenants`, `audit_chain_anchors` and `audit_logs`, but the role
reads every table the app reads and keeps every write the app has. A dedicated
read-only role is a follow-up (SC3). It has no task role, so it holds no AWS
credentials.

Without audit-outbox-worker, `audit_outbox` rows accumulate as `PENDING` and
audit logs are never persisted. Without retention-gc-worker, nothing is ever
purged and retention/deletion guarantees fail. The `*_DATABASE_URL` keys are
injected out-of-band into the app Secrets Manager secret (see
`infra/terraform/README.md` → Secrets Management).

### Audit anchor publisher

Production refuses to boot without external audit anchoring, and on AWS the
anchor goes to the Terraform-managed anchors bucket (`enable_s3_audit_anchors`
must stay `true`; the GitHub destination has no wiring here). Once a day, at
the cadence boundary (00:05 UTC), the publisher signs a manifest of every
chain-enabled tenant's chain head and writes it to
`<prefix>/YYYY-MM-DD.kid-<kid>.jws` with a COMPLIANCE retain-until 2555 days
(7 × 365) out.

- Its own task role carries only `s3:PutObject` and `s3:PutObjectRetention` on
  `<bucket>/<prefix>/*`; the bucket policy lets that role, and nobody else,
  write a manifest key. The verify worker has no task role.
- The bucket has Object Lock (COMPLIANCE, `audit_anchor_object_lock_days`,
  default 2557), versioning and SSE-S3. Its policy refuses deletes, lifecycle
  rules, a PUT without COMPLIANCE mode, a retention more than 31 days past the
  default, and SSE other than `AES256`. The rotation runbook's operator writes
  go to `<prefix>/key-rotation-*` and `<prefix>/public-keys/*`, and only the
  role in `audit_anchor_break_glass_role_arn` may write them.
- Terraform variables, the prefix rule and the outputs:
  `infra/terraform/README.md` "Audit anchor publisher". `DEPLOYMENT_ID`, an
  existing anchors bucket without Object Lock, the first-publish report and
  the CloudTrail prerequisite: `docs/operations/deployment.md` "Audit anchor
  publisher on ECS".

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

- **CloudWatch Metric Filters**: 5xx errors, health check failures, high latency;
  the anchor publisher's cadence and failure lines; the verify worker's heartbeat
- **CloudWatch Alarms**: ALB 5xx, health check failures, unhealthy hosts, high
  latency; worker and publisher liveness; anchor cadence absent (~25 h); anchor
  publisher failures; verify-worker heartbeat absent, errored and failed tenants
- **EventBridge**: ECS task stop detection; ECS Exec sessions (CloudTrail
  `ExecuteCommand`); anchors-bucket configuration changes. The two CloudTrail
  rules need a trail logging management events in the account — Terraform
  defines none (`docs/operations/deployment.md` "CloudTrail prerequisite")
- **SNS Topic**: Alarm notifications (email, etc.)

What each alarm means and what to do: `docs/operations/alerts.md`.

Enable with `enable_monitoring = true`, set `alarm_email` for email notifications.

## Deploy Order

⚠️ When introducing health checks, deploy app code first, then run Terraform apply.
Reversing this order causes ALB to mark all targets as unhealthy (cannot reach `/api/health/ready`).

## Notes

- Use ALB with HTTPS (ACM cert).
- Restrict `jackson` access if possible.
- Run Redis as a separate ElastiCache cluster (not inside RDS).
- Do not store secrets in task definitions or source code.
