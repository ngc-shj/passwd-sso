# Coding Deviation Log: separate-db-roles
Created: 2026-03-28

## Deviations from Plan

### DEV-1: migrate service build.args also changed to dummy URL
- **Plan description**: "migrate service keeps existing passwd_user URL (no change)"
- **Actual implementation**: Changed `migrate` service `build.args.DATABASE_URL` to dummy URL (`build:build@localhost`) for consistency with `app` service
- **Reason**: Defense-in-depth — `build.args` values are visible in Docker image layers via `docker inspect`. The runtime `DATABASE_URL` env var (unchanged, still `passwd_user`) is what matters for migration execution. `build.args` only affects `prisma generate` at build time.
- **Impact scope**: `docker-compose.yml` only. No behavioral change — `prisma generate` doesn't connect to a real DB.

### DEV-2: Additional files updated beyond plan's Files to Update
- **Plan description**: 14 files listed in Files to Update table
- **Actual implementation**: Also updated:
  - `load-test/README.md` — changed `passwd_user` to `passwd_app` in seed/cleanup commands
  - `infra/terraform/terraform.tfvars.example` — added `MIGRATION_DATABASE_URL` and role comments
  - `infra/terraform/envs/prod/terraform.tfvars.example` — same
  - `infra/terraform/envs/dev/terraform.tfvars.example` — same
- **Reason**: Impact analysis (Step 2-1) discovered these files reference `passwd_user` DATABASE_URL and need updating for consistency
- **Impact scope**: Documentation/config examples only. No runtime behavior change.

### DEV-3: CI rls-smoke job adds re-grant step after migration
- **Plan description**: Plan shows `psql` role creation + `prisma migrate deploy` + RLS verification
- **Actual implementation**: Added an intermediate "Re-grant on newly created tables" step between migration and verification
- **Reason**: `ALTER DEFAULT PRIVILEGES` only applies to tables created by the role that executed the ALTER. Since the role creation and migration happen in separate `psql` sessions, the `DEFAULT PRIVILEGES` grant ensures the `passwd_app` role can access tables created by the migration. Without re-granting, the RLS verification would fail with "permission denied" rather than testing RLS policy behavior.
- **Impact scope**: `.github/workflows/ci.yml` only.

---
