# Coding Deviation Log: departed-member-leaked-authority

## D1 — Test-only env override for the C3 red-proof

`share-departure.integration.test.ts` reads `SHARE_CREATOR_DEPARTED_SQL` (default: the
`20261114000100_share_creator_departed` migration) so a mutated copy can be loaded for the
red-proof. It follows the file's existing `RUNBOOK_MD` / `RLS_BACKFILL_RERUN_SQL` overrides. No
production code reads it.

## D2 — Guest-creator fixture files the user under the share's tenant

The first A10 guest-creator fixture filed the guest's `users` row under another tenant, which
broke teardown and leaked a test tenant. The fixture now files it under the share's tenant; the
leaked rows were removed and a final check found no leftover test tenants, functions or triggers.

## D3 — Red-proof coverage

The testing strategy says every new test is red-proved on a scratch copy. B4 red-proved the C4
route term, the C6 predicate, the C3 function (A10b), the C5 in-transaction audit, and the three
runbook predicates (RP1–RP7). The C2 trigger, the C6 backfill block and the worker
`column_privileges` cell need a mutated migration on a database; they are red-proved on an
isolated scratch database (see D6), never on the shared dev database.

## D4 — Pre-PR gate fixes

- `scripts/rls-cross-tenant-verify.sql` (10b) pins `share_creator_admitted`'s exact bypass list;
  it now names the seven tables C3 grants (`tenant_members`, `tenant_member_departures` added).
- The C5 rollback cell's probe function has a fixed name, `c5_accept_rollback_probe`, allowlisted
  in `check-bypass-rls.mjs` `FUNCTION_RULE_ALLOWLIST` for that file only. The gate's routine-name
  parser reads a schema-qualified `public.<name>` as `public`, so the CREATE is unqualified.

## D5 — Step 2-5 self R-check

- Functionality and security: no findings.
- Testing:
  - F1 (C3/C4 divergence for a deleted tenant row with a departure record) refuted:
    `lockTenantRows` seeds an entry for every requested user, so the record is attached with
    `hasRow: false` (pinned at `tenant-row-lock.test.ts`, the `gone` entry). A helper cell for
    exactly that state was added.
  - F2: approve allow cell with `created_at < departure < admitted_at`, red-proved against the
    `createdAt`-only mutation on a scratch copy (1 failed / 21 passed; control 22 passed).
  - F3: not-called assertions added to the two status-only deny cells.
  - F4: stale `activeTeamRole` mock and comment removed from the confirm-key test.
  - Adjacent: `check-bypass-rls` named a schema-qualified `CREATE FUNCTION public.x` as `public`.
    It now names the routine after the dot, with a gate test.

## D6 — Red-proofs on an isolated scratch database

A separate database (`passwd_sso_rp1035`, migrated, granted as CI does, then dropped); nothing ran
against `passwd_sso`. Every control was green first.

| Mutation | Result |
|---|---|
| C2 trigger uses `now()` | the `clock_timestamp()` cell red |
| C2 ELSE no longer copies `OLD.admitted_at` | the active-row cell red |
| C2 INSERT no longer forces NULL | the INSERT cell red |
| C6 backfill `ORDER BY … ASC` | the backfill cell red |
| C6 backfill without the tenant match | the backfill cell red |
| Worker table-level `SELECT` on `team_members` | the column-privileges cell red |
| Worker `REVOKE SELECT (role)` | the column-privileges cell red |
| Worker `GRANT DELETE` | the table-privileges assertion red on its own |
| `audit_logs` dropped from the backfill's `bypass_tables` | `check-migration-rls-dml` fails at both lines |

## D7 — Simplify pass

- `webhookCreatorVerdicts(tx, teamId, webhooks)` in `webhook-creator-authority.ts` replaces the
  two copies of the creator lookup (the worker's `resolveWebhookSubscribers` and the webhooks
  GET), so the delivery decision and the "paused" display come from one read. Unit-tested.
- Mirror comments: `departedAt` names its SQL copies; `activeTeamAdmission` names the inlined
  `COALESCE(admitted_at, created_at)` sites.
- Not applied: a comment in `20261114000100` on why the share rule keeps `m.created_at` (editing
  an applied migration changes its checksum). The reason: a share older than a re-admitting
  departure is refused by the `GREATEST(...) >= s.created_at` clause, so `admitted_at` adds
  nothing there.
- Skipped: member DELETE and `rotate-key` keep `activeTeamRole` — they reduce authority (plan C4
  exclusions).
