# Plan: Separate DB Roles (Issue #265)

## Objective

Separate the PostgreSQL database roles so that the application runtime connects as a **non-SUPERUSER** role, ensuring Row Level Security (RLS) is enforced even in dev environments. Currently `passwd_user` is created by Docker's `POSTGRES_USER` and is automatically SUPERUSER, which silently bypasses all RLS policies including `FORCE ROW LEVEL SECURITY`.

## Requirements

### Functional
- F1: Application runtime connects as a non-SUPERUSER, non-BYPASSRLS role (`passwd_app`)
- F2: Migrations continue to run as a privileged role (`passwd_user`, SUPERUSER) that owns all tables
- F3: Jackson (SAML) continues to connect to its own `jackson` database without disruption
- F4: Existing `docker compose up` workflow remains simple (no manual SQL steps)
- F5: Dev environments require `docker compose down -v` + `docker compose up` to adopt the new setup (documented)

### Non-functional
- NF1: RLS policies are enforced for the app role in all environments (dev, staging, prod)
- NF2: No changes to RLS policy definitions (they already use `current_setting('app.tenant_id')`)
- NF3: Migration scripts that check `current_user` ownership continue to work
- NF4: Production deployment guide updated with new role requirements

## Technical Approach

### Role Architecture

| Role | Privileges | Purpose | Connects via |
|------|-----------|---------|-------------|
| `passwd_user` | SUPERUSER (Docker default) | Table owner, migration, DDL | `DATABASE_URL` in `migrate` service |
| `passwd_app` | NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE | App runtime (Next.js) | `DATABASE_URL` in `app` service |

### How It Works

1. Docker `POSTGRES_USER=passwd_user` creates the SUPERUSER role as before (table owner)
2. A new initdb script (`02-create-app-role.sql`) creates `passwd_app` and grants:
   - `CONNECT` on `passwd_sso` database
   - `USAGE` on `public` schema
   - `SELECT, INSERT, UPDATE, DELETE` on all current and future tables in `public`
   - `USAGE, SELECT` on all current and future sequences in `public`
3. `app` service `DATABASE_URL` switches to `passwd_app`
4. `migrate` service `DATABASE_URL` stays as `passwd_user` (SUPERUSER)
5. Jackson continues using `passwd_user` for its own `jackson` database (no change needed; Jackson doesn't need RLS)

### Why FORCE RLS Is Still Needed

Even with a separate app role, `FORCE ROW LEVEL SECURITY` remains important:
- It's defense-in-depth: if someone accidentally reconfigures the app to use the owner role, RLS still applies
- The existing migration that enables FORCE RLS does not need to change
- The owner-check guard in phase9 migration (`current_user` = table owner) continues to pass because migrations run as `passwd_user`

### Known Limitation: `app.bypass_rls` GUC

PostgreSQL user-defined GUCs (`app.*` prefix) can be set by any role, including `passwd_app`. This means the app can execute `SET LOCAL app.bypass_rls = 'on'` to bypass RLS. This is by design — `withBypassRls()` is used in 25 allowlisted code paths for cross-tenant operations (e.g., SCIM sync, admin operations).

Mitigations:
- **CI guard**: The existing RLS bypass allowlist is enforced by CI (any new `withBypassRls` callsite requires explicit approval)
- **Defense-in-depth**: Even with bypass, the app code validates authorization before calling `withBypassRls`
- **Future consideration**: Migrate bypass operations to a separate SUPERUSER connection pool (eliminates GUC bypass entirely)

This is NOT a regression — the current SUPERUSER role bypasses RLS entirely. The new `passwd_app` role is strictly more restrictive.

### Why Not Change Table Ownership

Transferring ownership to a dedicated non-login role was considered but rejected:
- Prisma migrations run DDL as the connecting user and expect to own the tables
- The phase9 migration explicitly checks `current_user` = table owner
- `FORCE ROW LEVEL SECURITY` already covers the owner-bypass case
- Lower complexity: fewer moving parts

## Implementation Steps

### Step 1: Create initdb script for app role

Create `infra/postgres/initdb/02-create-app-role.sql`:

```sql
-- Create non-superuser application role
-- This role is used by the Next.js app at runtime.
-- RLS policies are enforced for this role (no SUPERUSER or BYPASSRLS).
--
-- Password is read from PASSWD_APP_PASSWORD env var (set in docker-compose.yml).
-- Docker PostgreSQL makes all env vars available to initdb scripts via psql variables,
-- but we use \getenv for explicit control.

-- Read password from env var. \getenv sets a psql client-side variable,
-- which is expanded by :'varname' syntax (NOT accessible via current_setting).
\getenv passwd_app_password PASSWD_APP_PASSWORD

-- Guard: only create if role doesn't already exist
SELECT CASE WHEN NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app')
  THEN 'true' ELSE 'false' END AS should_create \gset

\if :should_create
  -- Use \if to branch on env var presence (\getenv sets empty string if unset)
  \if :{?passwd_app_password}
    CREATE ROLE passwd_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'passwd_app_password';
  \else
    -- Fallback for local dev when PASSWD_APP_PASSWORD is not set
    CREATE ROLE passwd_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'passwd_app_pass';
  \endif
\endif

-- Revoke default PUBLIC privileges on public schema (defense-in-depth)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Grant access to the application database
GRANT CONNECT ON DATABASE passwd_sso TO passwd_app;
GRANT USAGE ON SCHEMA public TO passwd_app;

-- Grant DML on all existing and future tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO passwd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO passwd_app;

-- Grant sequence usage (for auto-increment / serial columns)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO passwd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO passwd_app;
```

> **Note**: `\getenv` and `\if :{?var}` require PostgreSQL 14+ (we use 16). The env var approach avoids
> hardcoding credentials in SQL files while keeping the Docker Compose workflow simple.
> `\getenv` sets a **psql client-side variable** — it is NOT a GUC and cannot be read by `current_setting()`.
> Use `:'varname'` expansion in plain SQL statements, NOT inside `DO $$` blocks.

### Step 2: Update docker-compose.yml

Change `app` service `DATABASE_URL` to use `passwd_app`. Add `PASSWD_APP_PASSWORD` env var to `db` service for the initdb script:

```yaml
db:
  environment:
    POSTGRES_USER: passwd_user
    POSTGRES_PASSWORD: passwd_pass
    POSTGRES_DB: passwd_sso
    PASSWD_APP_PASSWORD: passwd_app_pass   # read by 02-create-app-role.sql

app:
  environment:
    - DATABASE_URL=postgresql://passwd_app:passwd_app_pass@db:5432/passwd_sso
  build:
    args:
      # Dummy URL for prisma generate (no actual DB connection at build time).
      # Do NOT use real credentials here — build args are visible in image metadata.
      DATABASE_URL: postgresql://build:build@localhost:5432/passwd_sso
```

`migrate` service keeps existing `passwd_user` URL (no change).

Also update `build.args.DATABASE_URL` for the `app` service. Note: this is only used for `prisma generate` during build — it doesn't need to be SUPERUSER, just a valid connection string format.

### Step 3: Update docker-compose.override.yml (if needed)

No changes needed — the override only exposes ports.

### Step 4: Update Dockerfile

The `DATABASE_URL` ARG in the Dockerfile is only used at build time for `prisma generate`. It doesn't connect to a real database during build, so the value format matters but the credentials don't need to be valid at build time. The `build.args` in `docker-compose.yml` now uses a dummy URL (`build:build@localhost`) to avoid embedding real credentials in Docker image layers (visible via `docker inspect`). No Dockerfile changes needed.

### Step 5: Update `.env.example`

Update the existing `.env.example` (NOT `.env.local.example` which doesn't exist):

```bash
# App runtime (non-SUPERUSER, RLS enforced)
DATABASE_URL=postgresql://passwd_app:passwd_app_pass@localhost:5432/passwd_sso

# Migration (SUPERUSER, used by `npm run db:migrate` and Prisma Studio)
MIGRATION_DATABASE_URL=postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso
```

### Step 6: Update prisma.config.ts for migration URL

`prisma.config.ts` needs to use the SUPERUSER URL for migrations. `env()` from `@prisma/config` **throws** when the variable is missing (it does NOT return `null`), so `??` fallback is impossible. Use `process.env` for the conditional check:

```typescript
datasource: {
  url: process.env.MIGRATION_DATABASE_URL
    ? env("MIGRATION_DATABASE_URL")
    : env("DATABASE_URL"),
},
```

This way:
- `npm run db:migrate` uses `MIGRATION_DATABASE_URL` (SUPERUSER) if set, else falls back to `DATABASE_URL`
- `env()` is only called for the variable that actually exists (no throw)
- The app runtime uses `DATABASE_URL` (non-SUPERUSER) via `src/lib/prisma.ts` (unchanged)
- In docker-compose, the `migrate` service explicitly sets `DATABASE_URL` to the SUPERUSER role, so the fallback path uses the correct SUPERUSER credentials
- For local `npm run db:migrate`, developers must set `MIGRATION_DATABASE_URL` in `.env.local` — document this clearly

### Step 7: Add `MIGRATION_DATABASE_URL` to env.ts Zod schema

Add `MIGRATION_DATABASE_URL` as an optional URL field to `src/lib/env.ts`. Follow the existing pattern (`refine()` + `new URL()`) used by `AUTH_URL` and `APP_URL` for consistency:

```typescript
MIGRATION_DATABASE_URL: z.string()
  .refine((val) => { try { new URL(val); return true; } catch { return false; } },
    { message: "MIGRATION_DATABASE_URL must be a valid URL" })
  .optional(),
```

This ensures startup-time validation catches malformed values. Existing tests in `env.test.ts` should be extended with:
- Valid PostgreSQL URL → accepted
- Empty/whitespace string → rejected
- Missing → accepted (optional)

### Step 8: Update threat-model.md

Remove the SUPERUSER warning callout from S5 (or update it to reflect the new setup):

```
> **RLS enforcement**: The application runtime connects as `passwd_app` (NOSUPERUSER, NOBYPASSRLS),
> ensuring RLS policies are enforced in all environments. Migrations run as `passwd_user` (SUPERUSER)
> which owns the tables.
```

### Step 9: Update deployment documentation

Update `docs/operations/deployment.md` with:
- New role requirements for production
- Replace `GRANT ALL ON ALL TABLES` with `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` (least privilege)
- Migration instructions for existing dev environments (`docker compose down -v`)
- Environment variable reference (`DATABASE_URL` vs `MIGRATION_DATABASE_URL`)

Also update all setup guides that reference `prisma migrate deploy`:
- `docs/setup/vercel/en.md`
- `docs/setup/aws/en.md`
- `docs/setup/gcp/en.md`
- `docs/setup/azure/en.md`
- `docs/setup/docker/en.md`

Each must document using `MIGRATION_DATABASE_URL` (SUPERUSER) for migrations.

### Step 10: Add CI RLS enforcement test (required)

Add a CI job or integration test that verifies the app database user cannot bypass RLS.

**Approach: CI workflow step** (`.github/workflows/ci.yml`)

GitHub Actions `services` containers do NOT support `volumes` mounts for `docker-entrypoint-initdb.d`. Instead, create the `passwd_app` role via a `psql` setup step after the PostgreSQL service starts:

```yaml
# In the rls-smoke job:
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_USER: passwd_user
      POSTGRES_PASSWORD: passwd_pass
      POSTGRES_DB: passwd_sso

steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version-file: .node-version
      cache: npm
  - run: npm ci
  - run: npx prisma generate

  - name: Create app role and run migrations
    run: |
      # Create passwd_app role (equivalent to 02-create-app-role.sql)
      psql postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso <<'SQL'
        CREATE ROLE passwd_app WITH LOGIN NOSUPERUSER NOBYPASSRLS
          NOCREATEDB NOCREATEROLE PASSWORD 'passwd_app_pass';
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE passwd_sso TO passwd_app;
        GRANT USAGE ON SCHEMA public TO passwd_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO passwd_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO passwd_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO passwd_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          GRANT USAGE, SELECT ON SEQUENCES TO passwd_app;
      SQL

      # Run migrations as SUPERUSER
      MIGRATION_DATABASE_URL=postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso \
        npx prisma migrate deploy

  - name: Verify RLS enforcement
    run: |
      # Connect as passwd_app (non-SUPERUSER) — MUST use this role for RLS verification
      psql postgresql://passwd_app:passwd_app_pass@localhost:5432/passwd_sso <<'SQL'
        -- 1. Verify role flags
        DO $$ BEGIN
          ASSERT (SELECT NOT rolsuper FROM pg_roles WHERE rolname = current_user),
            'passwd_app must not be SUPERUSER';
          ASSERT (SELECT NOT rolbypassrls FROM pg_roles WHERE rolname = current_user),
            'passwd_app must not have BYPASSRLS';
        END $$;

        -- 2. Verify RLS enforcement (no tenant_id set → 0 rows)
        DO $$ BEGIN
          ASSERT (SELECT count(*) = 0 FROM teams),
            'RLS must block access without app.tenant_id';
        END $$;
      SQL
```

This is **required** (not optional) — it is the primary automated guarantee that role separation works correctly.

## Testing Strategy

### Manual Testing
1. `docker compose down -v` to remove old volumes
2. `docker compose up` — verify both roles are created
3. `docker compose --profile migrate up migrate` — verify migrations succeed
4. Access the app — verify login, vault operations, team features work
5. Verify RLS enforcement: connect as `passwd_app` via psql, attempt cross-tenant query without setting `app.tenant_id` — should return 0 rows

### Automated Testing
- Existing `vitest` tests use mocked Prisma — no changes needed
- Integration tests that connect to a real DB should use the app role URL
- CI smoke test (Step 9) validates role privileges

## Considerations & Constraints

### Breaking Change for Dev Environments
- Existing dev environments **must** run `docker compose down -v && docker compose up` to recreate the DB with the new initdb script
- The initdb scripts only run on first database initialization (empty volume)
- This must be clearly documented in the PR description and commit message

### Jackson Database
- Jackson uses `passwd_user` to connect to its own `jackson` DB
- Since Jackson doesn't need RLS and has its own database, no change is needed
- `passwd_app` does NOT need access to the `jackson` database

### Prisma Studio
- `npm run db:studio` uses `prisma.config.ts` which reads `MIGRATION_DATABASE_URL` → connects as SUPERUSER
- This is intentional: Prisma Studio is a dev tool that needs full access

### Production Deployment
- Production should already use a non-SUPERUSER role (per existing docs)
- This change makes dev match production behavior
- `MIGRATION_DATABASE_URL` environment variable provides a clean separation

### initdb Script Ordering
- Docker PostgreSQL runs scripts in `docker-entrypoint-initdb.d/` in alphabetical order
- `01-create-jackson-db.sql` runs first (creates jackson DB)
- `02-create-app-role.sql` runs second (creates app role + grants)
- Grants on `ALL TABLES` in Step 2 will apply to tables created by future migrations
- `ALTER DEFAULT PRIVILEGES` ensures future tables get grants automatically

## User Operation Scenarios

### Scenario 1: Fresh dev setup
1. Clone repo
2. `cp .env.example .env.local` — `DATABASE_URL` points to `passwd_app`
3. `docker compose up -d` — DB initializes with both roles
4. `docker compose --profile migrate up migrate` — runs as `passwd_user`
5. `npm run dev` — app connects as `passwd_app`, RLS enforced

### Scenario 2: Existing dev environment upgrade
1. `docker compose down -v` (removes DB volume)
2. `docker compose up -d` — DB reinitializes with new initdb scripts
3. `docker compose --profile migrate up migrate` — recreates schema
4. `npm run db:seed` — reseed if needed

### Scenario 3: Local prisma migrate dev
1. Set `MIGRATION_DATABASE_URL=postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso` in `.env.local`
2. `npm run db:migrate` — Prisma reads `MIGRATION_DATABASE_URL` from `prisma.config.ts`
3. App continues to use `DATABASE_URL` (non-SUPERUSER)

### Scenario 4: Production deployment
1. Create two PostgreSQL roles: `passwd_app` (NOSUPERUSER) and `passwd_admin` (or similar, with DDL privileges)
2. Set `DATABASE_URL` to app role
3. Set `MIGRATION_DATABASE_URL` to admin role
4. Run migrations with admin role, app connects with app role

## Files to Update

| File | Change |
|------|--------|
| `infra/postgres/initdb/02-create-app-role.sql` | **New** — create app role + grants |
| `docker-compose.yml` | Update `app` `DATABASE_URL` to `passwd_app`; add `PASSWD_APP_PASSWORD` to `db`; use dummy `build.args` |
| `prisma.config.ts` | Add `MIGRATION_DATABASE_URL` conditional (using `process.env` check, not `??`) |
| `src/lib/env.ts` | Add `MIGRATION_DATABASE_URL` as optional URL to Zod schema |
| `.env.example` | Update `DATABASE_URL` to `passwd_app`; add `MIGRATION_DATABASE_URL` |
| `docs/security/threat-model.md` | Update SUPERUSER warning → RLS enforcement note |
| `docs/operations/deployment.md` | Add role separation docs; replace `GRANT ALL` with specific DML grants |
| `docs/setup/vercel/en.md` | Add `MIGRATION_DATABASE_URL` for `prisma migrate deploy` |
| `docs/setup/aws/en.md` | Add `MIGRATION_DATABASE_URL` for `prisma migrate deploy` |
| `docs/setup/gcp/en.md` | Add `MIGRATION_DATABASE_URL` for `prisma migrate deploy` |
| `docs/setup/azure/en.md` | Add `MIGRATION_DATABASE_URL` for `prisma migrate deploy` |
| `docs/setup/docker/en.md` | Add `MIGRATION_DATABASE_URL` for `prisma migrate deploy` |
| `.github/workflows/ci.yml` | Add RLS enforcement smoke test job (or integration test) |
| `CLAUDE.md` | Update Docker services section |
