# Tenant Boundary Matrix

This document consolidates the tenant-isolation surface: which tables enforce
Row Level Security (RLS), where RLS is intentionally bypassed and why, which
database roles a background worker connects as and what those roles can
touch, and the GUC (`SET`/`current_setting`) mechanism that makes tenant
scoping and bypass observable at the SQL layer.

---

## RLS-enabled tables

55 tables have `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` in
`prisma/migrations/`. Derived by:

```bash
grep -rhoE 'ALTER TABLE "[a-z_]+" ENABLE ROW LEVEL SECURITY' prisma/migrations/ \
  | grep -oE '"[a-z_]+"' | tr -d '"' | sort -u
```

| Table |
| --- |
| `access_requests` |
| `accounts` |
| `admin_vault_resets` |
| `api_keys` |
| `attachments` |
| `audit_chain_anchors` |
| `audit_deliveries` |
| `audit_delivery_targets` |
| `audit_logs` |
| `audit_outbox` |
| `delegation_sessions` |
| `directory_sync_configs` |
| `directory_sync_logs` |
| `emergency_access_grants` |
| `emergency_access_key_pairs` |
| `extension_bridge_codes` |
| `extension_tokens` |
| `folders` |
| `master_key_rotations` |
| `mcp_access_tokens` |
| `mcp_authorization_codes` |
| `mcp_clients` |
| `mcp_refresh_tokens` |
| `mobile_bridge_codes` |
| `notifications` |
| `operator_tokens` |
| `password_entries` |
| `password_entry_histories` |
| `password_shares` |
| `personal_log_access_grants` |
| `scim_external_mappings` |
| `scim_group_mappings` |
| `scim_tokens` |
| `service_account_tokens` |
| `service_accounts` |
| `sessions` |
| `share_access_logs` |
| `system_settings` |
| `tags` |
| `team_folders` |
| `team_invitations` |
| `team_member_keys` |
| `team_members` |
| `team_password_entries` |
| `team_password_entry_histories` |
| `team_password_favorites` |
| `team_policies` |
| `team_tags` |
| `team_webhooks` |
| `teams` |
| `tenant_members` |
| `tenant_webhooks` |
| `users` |
| `vault_keys` |
| `webauthn_credentials` |

`system_settings` (added in `prisma/migrations/20260502000000_audit_anchor_publisher_phase2/migration.sql`)
uses a bypass-only policy — `USING (COALESCE(current_setting('app.bypass_rls', true), '') = 'on')` — rather
than a `tenant_id = current_setting('app.tenant_id')` policy, because the table has no per-tenant rows (it is
a global key-value store for publisher state). All other tables use the standard tenant-scoped policy shape.

A table absent from this list has no RLS policy at all (e.g. `verification_tokens`, the sole
`RLS_FREE_EXPIRY_TABLES` member in `src/workers/retention-gc-worker/registry.ts:189-191`) — access
control for those tables is enforced entirely at the application layer.

---

## Bypass surface

Every bypass names a **grant**: a member of `BYPASS_GRANT` in `src/lib/tenant-rls-grants.ts`,
built with `defineGrant(purpose, models)`. `withBypassRls(prisma, fn, grant)` and
`setBypassGucs(tx, grant)` write the grant's tables into the transaction-local
`app.bypass_tables` GUC, and every RLS policy admits a bypassed row only through
`public.rls_bypass_admits('<its own table>')`.

- **Runtime (database), report mode:** a bypassed statement that examines a row of a table outside
  its grant is admitted, and the database raises
  `WARNING rls_bypass_not_granted table=<t> purpose=<p>`. The pool listener in
  `src/lib/db/pool-factory.ts` logs it as `_logType: "rls.bypass_not_granted"`, and CloudWatch
  counts it (`RlsBypassNotGranted`). Refusing such a statement (enforce mode) is a separate,
  later step (#911). Until then the grant is observed, not enforced. A statement that examines no
  row raises nothing. FK cascades, and `SECURITY DEFINER` bodies owned by an RLS-exempt role, are
  outside this control.
- **Static (CI), `scripts/checks/check-bypass-rls.mjs`:** a limited, development-time aid.
  1. **File allowlist** (`ALLOWED_USAGE`): a file may call `withBypassRls` only if it is listed.
  2. **Grant resolution:** each call's grant must resolve to a `BYPASS_GRANT` member, or to a
     `BypassGrant` parameter, whose production callers are then charged.
  3. **Per-call reach:** every model a call reaches (followed through the functions it calls, by
     type) must be in its grant. Unnamed grants and unreached models fail as stale.
  4. **Writer, pool and function rules:** only `tenant-rls.ts` / `tenant-rls-grants.ts` may write the
     bypass GUCs; only `src/lib/db/pool-factory.ts` may construct a pg pool, client or Prisma
     adapter (so every connection carries the report listener); no code may create a database
     function.

  The tx-less callback shape (`() => prisma.x` instead of `(tx) => tx.x`) is banned for both
  `withBypassRls` and `withTenantRls`. Code the analysis does not follow is left to the
  database report.

This document does not copy the allowlist or the grants. `scripts/checks/check-bypass-rls.mjs` and
`src/lib/tenant-rls-grants.ts` are the SSoT, CI-enforced on every push.

Purpose classes (`BYPASS_PURPOSE` in `src/lib/tenant-rls-purpose.ts`), each covering a distinct reason a
call site legitimately needs to see across tenant boundaries:

| Purpose | Typical call sites |
| --- | --- |
| `AUTH_FLOW` | Session callbacks, passkey verify/options routes, account lockout — pre-session or session-establishing code with no tenant context yet. |
| `CROSS_TENANT_LOOKUP` | Team invitations/guest membership, emergency access grantor/grantee resolution, MCP client/consent pages — reads that must resolve an identity or resource whose tenant differs from the caller's. |
| `SYSTEM_MAINTENANCE` | The 6 `src/app/api/maintenance/**` routes, resource-quota aggregation — operator/background tooling that intentionally spans all tenants. |
| `AUDIT_WRITE` | `src/lib/audit/audit.ts`, `audit-outbox.ts` — writing audit rows attributed to a tenant that may differ from the active RLS context. |
| `WEBHOOK_DISPATCH` | `src/lib/webhook-dispatcher.ts` — tenant/team webhook delivery. |
| `TOKEN_LIFECYCLE` | Token issuance/refresh/revocation across the token-lifecycle surface (extension, mobile, MCP, operator, service-account tokens). |
| `AUDIT_ANCHOR_PUBLISH` | `src/workers/audit-anchor-publisher.ts` — cross-tenant manifest generation reads all tenants' chain state in one pass. |

---

## Worker roles and grants

Three non-application Postgres login roles exist alongside the interactive `passwd_app` role, each
scoped to the minimum privileges its worker needs, plus one retired role that holds nothing (below).
All are `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` —
RLS is enforced for every one of them; a worker that needs to see across tenants sets
`app.bypass_rls = 'on'` explicitly inside its own transaction (an application-level GUC), which is
independent from the role-level `NOBYPASSRLS` grant.

### `passwd_app` (interactive Next.js app)

Created out-of-band by infra/initdb (dev: `docker-compose`; prod: deployment tooling), not by a
migration. `NOSUPERUSER NOBYPASSRLS` — RLS is enforced for every app-role query, matching the
production connection.

Notable grant *narrowing* (not widening) applied via migration
`prisma/migrations/20260522000200_audit_log_revoke_via_definer/migration.sql`:
`REVOKE UPDATE, DELETE ON audit_logs, audit_chain_anchors FROM passwd_app`, replaced with
`GRANT EXECUTE ON PROCEDURE audit_log_tenant_migrate(...)` and
`GRANT EXECUTE ON FUNCTION audit_log_purge(UUID, TIMESTAMPTZ)` — both `SECURITY DEFINER`. The app
role can no longer issue an arbitrary `UPDATE`/`DELETE` against the immutable audit tables; it can
only invoke the two closed-signature definer routines.

**A migration is not sufficient to hold this control, and for a period it did not.**
`scripts/bootstrap-rds-roles.mjs` converges role privileges with a table-blind
`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO passwd_app`. That statement
re-grants exactly what the migration revoked, and the script is documented as convergent and
re-runnable — so any convergence run performed after the migrations reopened it. It went unnoticed
because `scripts/checks/db-grants-manifest.json` is *descriptive*: it is generated from a live
database with `audit-db-grants.mjs --write`, so a regeneration against the reopened state recorded
`passwd_app` holding `UPDATE`/`DELETE` as the expected set, and the grant audit reported OK.

The control is therefore declared *prescriptively* in
[`scripts/checks/app-role-denied-privileges.json`](../../scripts/checks/app-role-denied-privileges.json),
which two consumers read: `bootstrap-rds-roles.mjs` re-applies the revokes after its blanket grant,
and `audit-db-grants.mjs` fails on `DENIED_PRIVILEGE_HELD` (the database holds one) and on
`DENIED_PRIVILEGE_IN_MANIFEST` (the descriptive manifest sanctions one), the latter also refusing
`--write` so a broken database can no longer be laundered into the expected set.
`src/__tests__/db-integration/app-role-denied-privileges.integration.test.ts` asserts the
declaration against a live database, deriving its cases from the file.

### `passwd_outbox_worker` (audit outbox drain)

Migration: `prisma/migrations/20260412100001_add_audit_outbox_worker_role/migration.sql`
(+ `20260428200000_revoke_references_from_outbox_worker`).

| Table | Grant | Reason |
| --- | --- | --- |
| `audit_outbox` | `SELECT, UPDATE, DELETE` | claim / deliver / delete SENT or FAILED rows |
| `audit_logs` | `SELECT, INSERT` | `SELECT` for `ON CONFLICT (outbox_id) DO NOTHING` dedup check; `INSERT` to deliver |
| `tenants`, `users`, `teams`, `service_accounts` | `SELECT` | FK-referenced tables — RLS FK-integrity checks need read access |

### `passwd_retention_gc_worker` (retention GC sweep)

Migration: `prisma/migrations/20260618000000_add_retention_gc_worker_role/migration.sql`, extended
by 7 follow-on grant migrations (`20260618120000` mcp-token-family, `20260618140000`
forensic-credential, `20260618170000` trash, `20260618200000` history, `20260618230000` log,
`20260619001000` security-record, `20260619100000` emergency-access).

Grants are least-privilege per registry entry kind (`src/workers/retention-gc-worker/registry.ts`):
`SELECT, DELETE` on every leaf table it purges directly (`mcp_clients`, `sessions`,
`verification_tokens`, `extension_bridge_codes`, `mobile_bridge_codes`, `mcp_authorization_codes`,
`api_keys`, `service_account_tokens`, `operator_tokens`, `extension_tokens`, `password_entries`,
`team_password_entries`, `password_entry_histories`, `team_password_entry_histories`,
`share_access_logs`, `directory_sync_logs`, `notifications`, `access_requests`,
`admin_vault_resets`, `master_key_rotations`, `personal_log_access_grants`, `password_shares`,
`team_invitations`, `emergency_access_grants`); `SELECT`-only on cascade-child tables it never
deletes directly (`mcp_refresh_tokens`, `delegation_sessions`, `attachments` — the FK
`ON DELETE CASCADE` runs internally and does not re-check the invoking role's table privileges);
`SELECT` on `tenants` for per-tenant retention-column enumeration; `SELECT, INSERT` on
`audit_outbox` to enqueue provenance/heartbeat rows; and
`GRANT EXECUTE ON FUNCTION audit_log_purge(UUID, TIMESTAMPTZ)` — the only path by which this role
deletes `audit_logs` rows (no direct `DELETE` grant on that table exists for this role either).

**Single-instance deployment contract (C4-S4 / A2)**: the retention-GC worker has no cross-instance
mutual-exclusion primitive (no advisory lock, no leader election) — unlike the audit-anchor
publisher, which acquires `pg_try_advisory_xact_lock` before each cadence run (see
[`audit-chain-threat-model.md`](audit-chain-threat-model.md)). Running more than one
`retention-gc-worker` instance concurrently is therefore an accepted-risk deployment constraint, not
a bug: two racing instances could both select the same batch of expiry-eligible rows before either
deletes. The one confirmed double-emit risk this created — `sweepAuditProvenanceEntry` enqueuing a
provenance audit row *before* the batch `DELETE`, so two racing instances could both capture and
both emit for the same row — was fixed by reordering to delete-first
(`DELETE ... RETURNING id, <provenanceColumns>`, emit only from the `RETURNING` rows; commit
`30e89367`). With delete-first, a losing racer's `DELETE` affects zero rows and therefore emits
nothing, closing that specific double-emit path. The broader "no mutual exclusion between
instances" constraint remains: operate `retention-gc-worker` as a single instance until a locking
mechanism is added.

### `passwd_anchor_publisher` (audit anchor publish cadence)

Migration: `prisma/migrations/20260502000000_audit_anchor_publisher_phase2/migration.sql`
(+ `20260502000001_audit_anchor_grant_updated_at_fix`). A `LOGIN` role: the anchor-publisher
process connects as it (`AUDIT_ANCHOR_PUBLISHER_DATABASE_URL`). The migration creates it `NOLOGIN`
on clusters that lack it; the Docker initdb (`infra/postgres/initdb/02-create-app-role.sql`) and,
on RDS, `scripts/bootstrap-rds-roles.mjs` give it `LOGIN` and its password, and the bootstrap
converges its attributes and memberships like the other login roles. `scripts/audit-db-grants.mjs`
audits it on every ECS deploy (`AUDITED_ROLES`, including `ROLEATTR … rolcanlogin true`).

| Table | Grant | Reason |
| --- | --- | --- |
| `audit_chain_anchors` | `SELECT`; `UPDATE (publish_paused_until, last_published_at, updated_at)` | read chain-seq snapshot; column-scoped update — cannot touch `chain_seq`, `prev_hash`, or any other column |
| `tenants` | `SELECT` | chain-enabled tenant enumeration (`audit-anchor-publisher.ts`, under the `AUDIT_ANCHOR_PUBLISH` grant) |
| `audit_outbox` | `INSERT` | enqueue SYSTEM-attributed publish-event audit rows |
| `system_settings` | `SELECT, INSERT, UPDATE` | publish-state key-value storage (deployment-ID guard, pause bookkeeping) |

### `passwd_dcr_cleanup_worker` (retired)

Unused since the retention GC worker absorbed DCR cleanup. Migration
`prisma/migrations/20261023010000_retire_dcr_cleanup_worker_role/migration.sql` retires it in place
(the role is kept, not dropped): `NOLOGIN`, no password, no memberships either way, no grants or
default ACLs naming it — nothing beyond what `PUBLIC` holds. `scripts/audit-db-grants.mjs` lists it
in `RETIRED_ROLES` and asserts that state prescriptively (`ROLE_STATE_VIOLATION` /
`ROLE_STATE_IN_MANIFEST`, and `--write` refuses), so a re-enabled role cannot be recorded as the
expected set. A membership into it is allowed only as an `ADMIN`-only row (no `INHERIT`, no `SET`)
held by a non-audited role, and such rows are left out of the manifest comparison: PostgreSQL 16
gives one to the non-superuser role that created it (on RDS, the master), and a deliberately granted
one cannot be told apart from it. Either confers none of the role's privileges, and every use of
one — granting the role on with `INHERIT`/`SET`, re-enabling `LOGIN`, granting it privileges — is a
`ROLE_STATE_VIOLATION`.

---

## Tenant-context GUC mechanism

Four Postgres GUCs (`current_setting` / `set_config`, transaction-scoped via the `true` third
argument) drive every RLS policy in this schema:

| GUC | Set by | Read by |
| --- | --- | --- |
| `app.tenant_id` | `withTenantRls` (the caller's tenant); `setBypassGucs` (`NIL_UUID` unless a tenant is given, keeping both OR-branches of the RLS policy castable) | Every RLS policy's `tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid)` clause (a sub-SELECT, so it is evaluated only when the bypass branch is false) |
| `app.bypass_rls` | `setBypassGucs` (`'on'`); `withTenantRls` pins it `'off'` | `public.rls_bypass_admits(table)`, called by every RLS policy's `OR (SELECT public.rls_bypass_admits('<table>'))` branch |
| `app.bypass_tables` | `setBypassGucs` (the grant's tables, `,`-joined); `withTenantRls` pins it `''` | `public.rls_bypass_admits(table)`: exact membership of the policy's own table |
| `app.bypass_purpose` | `setBypassGucs` (the grant's purpose) | `public.rls_bypass_admits(table)`: named, sanitised, in the report |

`src/lib/tenant-rls.ts` (`withTenantRls`, `withBypassRls`) and `src/lib/tenant-rls-grants.ts`
(`setBypassGucs`, for the workers that open their own transactions) are the only production writers
of these GUCs (the gate's writer rule). The helpers wrap `prisma.$transaction` and run the GUC-setting `$executeRaw` calls
inside that transaction, so the GUCs are transaction-scoped and cannot leak across requests.

**Nesting rule (symmetric, enforced at runtime)**: `AsyncLocalStorage` (the in-process context that
`getTenantRlsContext()` reads) does not roll back Postgres GUCs, and Prisma's transaction proxy
folds a nested `$transaction` into the outer one — so a `set_config()` call from either helper
persists for the remainder of the *outer* transaction regardless of which helper issued it. Both
directions are therefore rejected at runtime:

- `withTenantRls` inside an active `withBypassRls` context throws
  `INVALID_RLS_NESTING: withTenantRls inside withBypassRls is forbidden`.
- `withBypassRls` inside an active `withTenantRls` context throws
  `INVALID_RLS_NESTING: withBypassRls inside withTenantRls is forbidden`.

**`tx`-argument discipline**: `check-bypass-rls.mjs` additionally bans the tx-less callback form
(`(prisma, () => prisma.x.method(...), purpose)`) for both helpers — production call sites must use
`(tx) => tx.x.method(...)`. The bare-`prisma` form only works because of the `AsyncLocalStorage`
proxy injection at runtime; it silently breaks under dependency injection or a raw `PrismaClient` in
tests, so the checker treats it as a violation independent of the model/purpose checks.

**A refused nesting fails the outer transaction**: the refusal marks the outer context, and the outer
helper throws `INVALID_RLS_NESTING: a nested RLS context was refused inside this <helper>` when its
callback returns, rolling the outer transaction back even if the caller caught the inner error.
Two limits remain, both still logged (`rls.nesting_refused`): nested work detached from the callback
and refused after the outer transaction committed, and a caller that catches the outer error.
This covers nested contexts only. `logAuditAsync` called inside a context never reaches an opener:
`src/lib/audit/audit.ts` refuses the emit and logs `audit-refused`, and the outer transaction commits
without that audit row. Code that must audit inside a context uses `logAuditInTx`.
