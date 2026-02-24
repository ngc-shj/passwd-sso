# passwd-sso Vercel Setup

This guide covers a minimal production deployment of `passwd-sso` on [Vercel](https://vercel.com/).  
Use external managed services for stateful components (database/redis/blob).

## 1. Prerequisites

- Vercel account
- GitHub repository connected
- PostgreSQL (required)
- Redis (recommended for production)

Examples:
- PostgreSQL: Neon / Supabase / RDS / Cloud SQL
- Redis: Upstash Redis / ElastiCache / Memorystore

## 2. Create the Vercel Project

1. In Vercel dashboard, click **Add New... → Project**
2. Select the `passwd-sso` repository
3. Framework Preset: **Next.js**
4. Root Directory: repository root (default)

## 3. Environment Variables

Set these in Vercel Project Settings → Environment Variables:

- `DATABASE_URL` (PostgreSQL connection string)
- `AUTH_URL` (production URL, e.g. `https://your-app.vercel.app`)
- `AUTH_SECRET` (generate with `openssl rand -base64 32`)
- `SHARE_MASTER_KEY` (generate with `openssl rand -hex 32`)
- `REDIS_URL` (recommended in production)
- `BLOB_BACKEND` (`db` / `s3` / `azure` / `gcs`)
- SSO:
  - `AUTH_GOOGLE_ID`
  - `AUTH_GOOGLE_SECRET`
  - `GOOGLE_WORKSPACE_DOMAIN` (optional)
  - `JACKSON_URL`
  - `AUTH_JACKSON_ID`
  - `AUTH_JACKSON_SECRET`
  - `SAML_PROVIDER_NAME`

If you use cloud blob storage, also set backend-specific variables from `.env.example`.

## 4. Database Migrations (Important)

`prisma migrate deploy` is not automatically executed by Vercel.  
Run migrations separately before/with deployment.

Example (run from local machine against production DB):

```bash
DATABASE_URL='postgresql://...' npx prisma migrate deploy
```

Recommended: enforce migrations in CI (e.g., GitHub Actions) before production deploy.

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
- Treat `REDIS_URL` as required in production to keep rate limiting enabled
