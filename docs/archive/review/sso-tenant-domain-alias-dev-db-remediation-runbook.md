# Runbook: Dev-Database Remediation — Stray Tenant from a Pre-Fix Denied Sign-In (C13)

**Audience**: the operator of the shared dev database for this repository.
**Trigger**: the reported production bug this branch (`fix/sso-tenant-claim-registry`,
plan `docs/archive/review/sso-tenant-domain-alias-plan.md`) fixes — under the
pre-fix code (`findOrCreateSsoTenant`), a Google sign-in whose claim did not
match any existing tenant committed a **new** `tenants` row before the
downstream denial check ran (see
`docs/archive/review/sso-tenant-domain-alias-deviation.md` D-5, and D2 in the
plan). The user's sign-in was still denied, but the tenant it created was not
rolled back. The dev database carries exactly this artifact: a tenant with
`external_id = alias.example` and zero members, alongside the user's real,
pre-existing tenant that should have received the sign-in.
**Status**: **written, not executed.** This document is authorised by the
plan to be written; execution requires explicit user confirmation at the time
it is run (R-d in the plan's Risks section) because the dev database is
shared between working copies — running it now would affect other people's
in-progress work without their sign-off. Nothing in this runbook has been run
against any database.

## Preconditions

- `MIGRATION_DATABASE_URL` set to a privileged (SUPERUSER-class) connection
  string for the shared dev database — the same variable
  `scripts/tenant-domain.ts` and `npm run db:migrate` use.
- The C1 migration (`prisma/migrations/20260729110000_add_tenant_claims`) has
  already been applied, so `tenant_claims` exists and has been backfilled.
  Confirm with `npm run tenant-domain -- list --tenant <stray-tenant-id>`.
- You know (or can look up) three values before starting:
  - `<stray-tenant-id>` — the `tenants.id` of the tenant with
    `external_id = 'alias.example'`.
  - `<existing-tenant-id>` — the `tenants.id` (or any already-registered
    claim) of the user's real tenant, the one that should receive the
    `alias.example` claim.
  - the affected user's email, for the post-remediation sign-in check.

Find `<stray-tenant-id>`:

```sql
SELECT id, name, slug, external_id, is_bootstrap, created_at
FROM tenants
WHERE external_id = 'alias.example';
```

Confirm it has zero members (matching the plan's stated precondition — if
this returns non-zero, stop; this is not the tenant this runbook is for):

```sql
SELECT count(*) FROM tenant_members WHERE tenant_id = '<stray-tenant-id>';
```

## Step 0 — Prove the stray tenant owns nothing (acceptance criterion)

Enumerate every table that has a `tenant_id` foreign key referencing
`tenants(id)` **from the database catalog**, not from a hand-maintained list —
a hand-written list is exactly the kind of thing that goes stale as new
tenant-scoped tables are added, silently turning this check into a false
green. This lists the tables:

```sql
SELECT tc.table_name, kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
 AND tc.table_schema = ccu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND ccu.table_name = 'tenants'
  AND kcu.column_name = 'tenant_id'
ORDER BY tc.table_name;
```

Then count referencing rows in every one of those tables in a single pass,
driven off that same catalog query (never re-typed, so it cannot omit a
table the first query found):

```sql
DO $$
DECLARE
  r RECORD;
  cnt BIGINT;
  total BIGINT := 0;
  stray_id UUID := '<stray-tenant-id>';
BEGIN
  FOR r IN
    SELECT tc.table_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND ccu.table_name = 'tenants'
      AND kcu.column_name = 'tenant_id'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1', r.table_name)
      INTO cnt USING stray_id;
    RAISE NOTICE '%: % row(s)', r.table_name, cnt;
    total := total + cnt;
  END LOOP;
  RAISE NOTICE 'TOTAL (excluding the expected tenant_claims row): %', total;
END $$;
```

**Interpreting the output**: `tenant_claims` is expected to report exactly
**1** — the row the C1 backfill created for this tenant's own
`external_id = 'alias.example'` (`created_by = 'backfill'`). That row is not
"owned data"; it is the claim record for the tenant being deleted, and it is
removed automatically by `ON DELETE CASCADE` (`tenant_claims_tenant_id_fkey`,
`prisma/migrations/20260729110000_add_tenant_claims/migration.sql`) in the
same statement that deletes the tenant. **Every other table must report 0.**
If any other table reports a non-zero count, **stop here and report it** —
the tenant is not the empty artifact this runbook assumes, and deleting it
would destroy real data.

## Step 1 — Delete the stray tenant

Only after Step 0 shows zero referencing rows outside `tenant_claims`:

```sql
DELETE FROM tenants WHERE id = '<stray-tenant-id>';
```

This cascades to the tenant's own `tenant_claims` row (the `alias.example`
claim) via `ON DELETE CASCADE`, freeing the claim string for Step 2. Confirm:

```sql
SELECT count(*) FROM tenants WHERE id = '<stray-tenant-id>';                 -- expect 0
SELECT count(*) FROM tenant_claims WHERE claim = 'alias.example';            -- expect 0
```

## Step 2 — Register the claim for the user's real tenant

Order matters and Step 1 enforces it structurally: `UNIQUE(claim)` on
`tenant_claims` means Step 2 would refuse with a uniqueness violation while
the stray tenant's backfilled row still holds `alias.example` — there is no
way to run these out of order and have it silently succeed.

```bash
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- add \
  --tenant <existing-tenant-id> \
  --domain alias.example \
  --by <operator-label>
```

This is the same `add` path `README.md`'s "IdP domain changed / tenant locked
out" section documents — running the real remediation through it, rather than
a raw `INSERT`, is deliberate: it exercises the path being documented, prints
the tenant summary and the row-6/9a bootstrap-absorption warning before
prompting for confirmation, and is idempotent if re-run.

## Acceptance criteria

- [ ] Step 0's per-table scan reports 0 for every table except
      `tenant_claims` (which reports 1, the tenant's own backfilled claim
      row).
- [ ] After Step 1, `tenants` and `tenant_claims` both show no row for the
      stray tenant / `alias.example`.
- [ ] After Step 2, `tenant_claims` shows exactly one **active**
      (`revoked_at IS NULL`) row for `claim = 'alias.example'`, owned by
      `<existing-tenant-id>`.
- [ ] The affected user signs in with Google and succeeds (no
      `AUTH_LOGIN_FAILURE`).
- [ ] `audit_logs` for that user's next sign-in shows `AUTH_LOGIN`, not
      `AUTH_LOGIN_FAILURE`:
      ```sql
      SELECT action, created_at, metadata
      FROM audit_logs
      WHERE user_id = (SELECT id FROM users WHERE email = '<user-email>')
      ORDER BY created_at DESC
      LIMIT 5;
      ```

## Idempotency and the shared dev database

This runbook is written to be safe to re-run:

- Step 0 is read-only.
- Step 1's `DELETE ... WHERE id = '<stray-tenant-id>'` affects zero rows on a
  second run (the row is already gone) rather than erroring.
- Step 2's `tenant-domain add` is idempotent by design (VE2 in the plan) —
  re-running it against a claim already owned by `<existing-tenant-id>`
  reports success with no write.

That said, **the dev database is shared between working copies** on this
branch. Another developer's session may be concurrently exercising sign-in
against the same tenants while this runs. Do not run this against the shared
dev database without confirming with whoever else may be using it, and do
not run it at all without the explicit go-ahead described in "Status" above
— this document only authorises writing the procedure, not executing it.

## References

- `docs/archive/review/sso-tenant-domain-alias-plan.md` — C13 (source
  requirement), D-5 in the linked deviation log (why the stray tenant exists).
- `docs/archive/review/sso-tenant-domain-alias-deviation.md` — D-5.
- `scripts/tenant-domain.ts` — `add` command used in Step 2.
- `prisma/migrations/20260729110000_add_tenant_claims/migration.sql` — the
  `tenant_claims_tenant_id_fkey ... ON DELETE CASCADE` constraint Step 1
  relies on.
- `README.md` — "IdP domain changed / tenant locked out" (the general-purpose
  version of Step 2's recovery path).
