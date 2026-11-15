# Manual test: rls-refusal-metric (#1048)

Deployment artifact: `infra/terraform/monitoring.tf` adds `aws_cloudwatch_log_metric_filter.rls_bypass_refused` (one per log group in `local.rls_bypass_report_log_groups`) on the existing `RlsBypassNotGranted` metric. Tier-1 (monitoring, no IAM/auth surface). Constraint V1 of the plan: not run against real AWS in this PR; the operator runs it at the next apply. Offline evidence: mocked root `terraform test` 27/27, `terraform validate`, and the A4 unit cells (both sinks' refusal lines matched against the filter pattern read from `monitoring.tf`).

## Pre-conditions
- The database is enforcing (`SELECT public.rls_bypass_enforced()` returns `t`). In report mode there is no refusal and this filter cannot count.
- The release carrying this PR is deployed to every service (app, audit-outbox-worker, retention-gc-worker, audit-anchor-publisher, audit-chain-verify-worker).
- `terraform plan` for `infra/terraform` shows exactly five `aws_cloudwatch_log_metric_filter.rls_bypass_refused["<group>"]` to add, and an in-place update of the `rls-bypass-not-granted` alarm's description; nothing else.

## Steps
1. `terraform apply` the plan above.
2. In each of the five services, run a reach through that service's own pool (a one-off task of its task definition) as in `docs/operations/deployment.md` "Canary on an enforcing database": a bypass whose grant omits `sessions`, then `SELECT id FROM sessions LIMIT 1` (the table must hold a row).
3. Check each group with the filter pattern from that section (both `_logType`s).
4. Repeat step 2 in one group with `SET LOCAL client_min_messages = error` first in the transaction.
5. Watch the `<name_prefix>-rls-bypass-not-granted` alarm.

## Expected result
- Step 3: per group, one `rls.bypass_not_granted` line and one `rls.bypass_refused` line, both naming `table=sessions` and the bypass purpose; no message, hint or query text in either.
- Step 4: only `rls.bypass_refused` appears for that run (the WARNING is suppressed; the refusal is still counted).
- Step 5: the alarm goes to ALARM on `Sum >= 1` within 5 minutes and back to OK afterwards.
- A plain permission fault (a role reading a table it has no grant on) produces neither line.

## Rollback
- Revert `infra/terraform/monitoring.tf` and apply: removes the five refusal filters; the WARNING and unparsed filters keep counting as before.
- The application change needs no rollback for monitoring: without the filter the `rls.bypass_refused` line is simply not counted. Rolling the image back removes the refusal listener; refusals are then counted only through their WARNING, as before this PR.
