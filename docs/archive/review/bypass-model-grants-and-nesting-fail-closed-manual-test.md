# Manual test: bypass-model-grants-and-nesting-fail-closed

Covers the deployment-facing parts of this change:
- the migration `20261019000000_rls_bypass_admits_report_mode`;
- the `rls_bypass_not_granted` metric filters in `infra/terraform/monitoring.tf`;
- the EXECUTE grants added to `bootstrap-rds-roles.mjs` and `ci-integration.yml`.

## Deploy note
- **C5 ships enforcing.** A refused nested RLS context now rolls back its outer transaction, where before only the inner call failed. Before release:
  1. Query production logs for `_logType = "rls.nesting_refused"` over a representative window (at least 7 days).
  2. List each (opening, active) helper pair with the site that produces it.
  3. Any pair found is a request that will now fail as a whole. Fix it before release, or accept it explicitly.

  If the query cannot be run, record in the release notes that C5 is accepted unobserved.
- **Report mode is admit-only** on every rollback path. Neither a code rollback nor a schema rollback can turn a report into a refusal.
- **After a code-only rollback,** the old code has no notice listener. Reports then reach only the RDS server log, which is not exported, and they are not rate-limited. The `RlsBypassNotGranted` metrics read 0 during that time, whatever the traffic.

## Pre-conditions
- A staging environment deployed from this branch, with `enable_monitoring = true`.
- The `migrate` task has run, and `scripts/audit-db-grants.mjs` passed afterwards (the manifest includes both new functions).
- CloudWatch access to the app, audit-outbox-worker and retention-gc-worker log groups.

## Steps
1. Confirm the functions and grants:
   - `SELECT proname, proacl FROM pg_proc WHERE proname LIKE 'rls_bypass_%';` shows both functions, with EXECUTE for `passwd_app`, `passwd_outbox_worker`, `passwd_retention_gc_worker`, `passwd_anchor_publisher` and (where it exists) `passwd_dcr_cleanup_worker`, and none for PUBLIC.
   - `SELECT public.rls_bypass_enforced();` returns `false`.
2. Confirm the policies: `SELECT count(*) FROM pg_policies WHERE schemaname='public' AND qual LIKE '%rls_bypass_admits%';` equals the number of policies (57 at the time of writing).
3. Normal traffic: sign in, open the vault, and let the outbox worker and retention GC run one cycle. Each `RlsBypassNotGranted` metric should stay at 0 for this release's code paths.
4. Canary, once per log group. As `passwd_app` in a transaction:
   - set `app.bypass_rls='on'` and `app.bypass_tables='users'`;
   - read one row of `sessions`, then `ROLLBACK`.

   The read must succeed (report mode), and the server returns `WARNING: rls_bypass_not_granted table=sessions purpose=…`. Then trigger the same through each service's own pool, for example a one-off task run with a debug grant, and confirm that service's metric counts the event.
5. Old code on the new schema: run the previous image's app task against the migrated database. Requests succeed. Reports go only to the RDS server log, which is not exported.

## Expected result
- No request fails because of this change: report mode admits everything.
- Every `RlsBypassNotGranted` metric is 0 under normal traffic, and each increments for its canary.

## Rollback
- **Code:** roll back the task definition. Report mode is admit-only, so older code keeps working.
- **Schema:** not needed for a code rollback. To remove the change entirely, a new migration restores the policies' `COALESCE(current_setting('app.bypass_rls', true), '') = 'on'` branch and drops both functions.
- **Terraform:** removing the `rls_bypass_not_granted` metric filters is harmless.
