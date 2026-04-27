# passwd-sso Vercel Setup

This guide covers a minimal production deployment of `passwd-sso` on [Vercel](https://vercel.com/).  
Use external managed services for stateful components (database/redis/blob).

## 1. Prerequisites

- Vercel account
- GitHub repository connected
- PostgreSQL (required)
- Redis (REQUIRED in production)
- External host for `audit-outbox-worker` (required — Vercel functions are short-lived and cannot run a continuous worker)
- External host for SAML Jackson (required if using SAML SSO — Vercel cannot run Docker containers)

Examples:
- PostgreSQL: Neon / Supabase / RDS / Cloud SQL
- Redis: Upstash Redis (recommended as a natural Vercel pairing) / ElastiCache / Memorystore
- Worker host: Fly.io Machine / Railway worker / AWS Fargate / Render background worker / GCE VM
- Jackson host: Fly.io / Railway / Render / dedicated VM

## 2. Create the Vercel Project

1. In Vercel dashboard, click **Add New... → Project**
2. Select the `passwd-sso` repository
3. Framework Preset: **Next.js**
4. Root Directory: repository root (default)

## 3. Environment Variables

`npm run init:env` generates `.env` locally — it is gitignored and not read by Vercel. Enter all values manually in Vercel Project Settings → Environment Variables (or use the `vercel env` CLI).

Set these in Vercel Project Settings → Environment Variables:

- `DATABASE_URL` (PostgreSQL connection string — non-SUPERUSER app role `passwd_app`)
- `MIGRATION_DATABASE_URL` (PostgreSQL connection string — SUPERUSER role `passwd_user`, for migrations only)
- `AUTH_URL` (production URL, e.g. `https://your-app.vercel.app`)
- `AUTH_SECRET` (generate with `openssl rand -base64 32`)
- `SHARE_MASTER_KEY` (generate with `openssl rand -hex 32`)
- `REDIS_URL` (REQUIRED in production — Zod schema enforces this for `NODE_ENV=production`; backs session cache (PR #407) and rate limiting. Use Upstash Redis for Vercel deployments.)
- `BLOB_BACKEND` (`db` / `s3` / `azure` / `gcs`)
- SSO:
  - `AUTH_GOOGLE_ID`
  - `AUTH_GOOGLE_SECRET`
  - `GOOGLE_WORKSPACE_DOMAINS` (optional)
  - `JACKSON_URL` (URL of your externally-hosted Jackson service — Vercel cannot run Docker containers)
  - `AUTH_JACKSON_ID`
  - `AUTH_JACKSON_SECRET`
  - `SAML_PROVIDER_NAME`
  - `JACKSON_API_KEY` (API key for the externally-hosted Jackson container; passed to Jackson as `JACKSON_API_KEYS`)

If you use cloud blob storage, also set backend-specific variables from `.env.example`.

> **Note on operator tokens (admin scripts)**: Admin scripts (`scripts/purge-history.sh`, etc.) require a per-operator `op_*` token. Mint tokens in the application UI at `/admin/tenant/operator-tokens`. Pass as `ADMIN_API_TOKEN=op_<your-token> scripts/...` at invocation time only. Do NOT store as a persistent Vercel environment variable.

## 4. Database Migrations (Important)

`prisma migrate deploy` is not automatically executed by Vercel.  
Run migrations separately before/with deployment.

Example (run from local machine against production DB):

```bash
MIGRATION_DATABASE_URL='postgresql://SUPERUSER:password@HOST:5432/DB' npx prisma migrate deploy
```

Recommended: enforce migrations in CI (e.g., GitHub Actions) before production deploy.

## 4b. Audit-outbox-worker (Required)

> **Vercel cannot host the audit-outbox-worker.** Vercel serverless functions are short-lived and unsuitable for a continuous drain worker. Without this worker, audit events accumulate as `PENDING` in `audit_outbox` and are never persisted to `audit_logs`.

Host the worker externally on one of:
- Fly.io Machine
- Railway background worker
- AWS Fargate (ECS)
- Render background worker
- GCE VM (systemd service)

The worker runs: `npm run worker:audit-outbox` (or `npx tsx scripts/audit-outbox-worker.ts`).

Required env var: `OUTBOX_WORKER_DATABASE_URL` (least-privilege `passwd_outbox_worker` DB role connection string).

## 4c. Jackson Deployment (Required for SAML SSO)

> **Vercel cannot run Docker containers.** BoxyHQ SAML Jackson (`boxyhq/jackson:1.52.2`) must be deployed externally. It is not an npm package.

Host Jackson on one of: Fly.io, Railway, Render, or a dedicated VM. Set `JACKSON_URL` in your Vercel environment variables to the public or private URL of the Jackson service.

Jackson required env vars:
- `JACKSON_API_KEYS` (your `JACKSON_API_KEY` value — note the trailing `S`)
- `DB_ENGINE=sql`, `DB_TYPE=postgres`, `DB_URL` (external PostgreSQL)
- `NEXTAUTH_URL` and `EXTERNAL_URL` (public URL of Jackson)
- `NEXTAUTH_SECRET` (same value as `AUTH_SECRET`)
- `NEXTAUTH_ACL=*`

## 5. Post-deploy Verification

1. `/auth/signin` loads
2. Sign-in works
3. Vault setup/unlock works
4. Entry create/read works
5. If blob is enabled, upload/download/delete works

## 6. Security Notes

- Rotate `AUTH_SECRET` and `SHARE_MASTER_KEY` with a defined policy
- Enforce TLS for DB/Redis/blob connections
- Separate Preview and Production environment variables
- `REDIS_URL` is REQUIRED in production (Zod schema enforces this); use Upstash Redis for Vercel deployments
