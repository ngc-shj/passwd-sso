# Coding Deviation Log: anchor-workers-compose-k8s

Ollama unavailable; recorded directly.

## D1 — Worker role-password binding derived from `bootstrap-rds-roles.mjs` `ROLES`
Plan: derive the worker → `PASSWD_*` mapping if possible, else hand-list with a pin.
Done: derived from the smoke-map user plus `ROLES` exported by
`scripts/bootstrap-rds-roles.mjs` (its `main()` runs only when executed directly).
`withheld-env.ts` therefore imports that module (and `pg` transitively).

## D2 — Worker schema tests spawn the worker with `--validate-env-only`
The outbox/retention-gc schemas are module-private; tests run
`tsx <worker> --validate-env-only` from an empty temp cwd, as existing worker env
tests do, instead of importing the schema.

## D3 — S3-requires-region is a block in the publisher's existing `superRefine`
Same behaviour as a separate `.refine`, after the enabled early-return.

## D4 — ECS literals read from HCL syntax, not evaluated values
`AUDIT_ANCHOR_DESTINATION_S3_PREFIX` evaluates to the literal `"audit-anchors"`
through the anchor-prefix module, but the plan places it in the ConfigMap (a
deployment-specific value). The parity test treats only values written as quoted
strings in the container definition as ECS literals (today:
`AUDIT_ANCHOR_PUBLISHER_ENABLED=true`).

## D5 — I1.4 skips the two isolated services
I1.1 already reports their `env_file`; evaluating I1.4 on them would turn one
I1.1 red case into a 24-entry drift list.

## D6 — k8s model admits `envFrom`, `volumes`, `readinessProbe`
Needed for the I2.3 red cases and the existing retention-gc manifest; I2.2 flags
`envFrom` on the ECS-mapped workers.

## D7 — Secret/ConfigMap key names chosen
Plan named the objects, not the keys: Secret `audit-anchor-publisher`
(`database-url`, `signing-key`, `tag-secret`), `passwd-sso-deployment`
(`deployment-id`), `audit-chain-verify-worker-db` (`database-url`), ConfigMap
`audit-anchor-publisher` (`s3-bucket`, `s3-prefix`, `aws-region`).

## D8 — C7 `:?` floor
Iterating only the `:?` variables present in the files would stop testing a
variable once weakened to `:-`. The check adds a floor (the ECS publisher's
non-URL secrets plus each smoke-map worker's role-password variable); without it
the weakened-`DEPLOYMENT_ID` red case returned 0.

## D9 — Latent `set -e` bug in `check-gate-selftest-coverage.sh` (side-fix)
An `ls` with no match ended the member-set group early, so later extensions were
never listed; the existing ".mjs check with a sibling test" case passed vacuously.
Each `ls` is now `|| true`. Real tree unaffected.

## D10 — `derivePublisherOnlyEnv()` exported from `withheld-env.ts`
C7 needs part (c) of W alone; `deriveWithheldEnv` now composes it (no behaviour
change).

## D11 — C7 "loads .env" detected by a canary key
A service counts as `.env`-loading when the stub's canary key appears in its
rendered environment, which covers every `env_file` spelling without parsing it.

## D12 — CONTRIBUTING.md stale line numbers corrected (side-fix)
The entrypoint list also carried stale `Dockerfile:` / override line numbers.

## Carried items
- R35 manual-test plan: `anchor-workers-compose-k8s-manual-test.md`. A real `up` of the
  two services ran in an isolated compose project (own volume, stub env), so SC2 is
  resolved without touching the shared dev DB; the cluster apply (SC1/E1) remains unrun.

## D13 — Helpers live in `scripts/checks/lib/`, not `scripts/lib/`
The plan placed `hcl-subset.ts` and `withheld-env.ts` in `scripts/lib/`, which
`check-bypass-rls`'s soundness pass treats as production code (it then refused
`withheld-env.ts` importing the non-production `env-allowlist.ts` and
`bootstrap-rds-roles.mjs`, and `hcl-subset.ts`'s function tables). They are CI-gate
libraries, which `NON_PRODUCTION` already declares as `scripts/checks/`; moved
there rather than widening the declaration.

## D14 — Existing tests updated for the intended behaviour changes
`src/lib/env.test.ts` "rejects empty MIGRATION_DATABASE_URL" now asserts the blank
reads as unset (a withheld key, C6). `scripts/__tests__/audit-anchor-publisher-env.test.mjs`
TASK_ENV gains `AWS_REGION` — the ECS task gives it, and the publisher now requires
it with an S3 bucket.

## D15 — /simplify applied (6 proposals)
Single derivation of W part (c) shared by the parity test and render check;
`isDatabaseUrlKey`/`SHARED_PUBLISHER_NAME`/`ecsContainerDefinitions` exported from
`withheld-env.ts`; smoke-map test reuses `readSmokeMap`; render-check sentinel
substitution and role-URL drift deduplicated. No behaviour change.

## Verification baseline
Full `npx vitest run`: 6 failures, all in `scripts/__tests__/backup-db.test.mjs`
Group B (no `pg_restore` on this host; compose fallback from a worktree finds no
`db` service) — pre-existing environment limitation, untouched by this change.
`npx next build`: pass.

## D16 — Phase 2 self-R-check fixes
- R42 (security): both gates now judge every W value in any field of any service
  against one `withheldHolders()` table (was: name-only for W keys, substring only
  for publisher-only and role-password sentinels).
- R49 (security): compose header and deployment.md state what is enforced; app
  secrets the workers already shared (AUTH_SECRET, REDIS_PASSWORD,
  SHARE_MASTER_KEY_*) are named as not covered.
- RT7 (testing): deny cases for `roleUrlDrift` at both call sites and for the
  verify worker loading `.env`.
- R3 (functionality): setup.ts gains the publisher `restart` hint.
- R32 (functionality): real boot of both services in an isolated compose project
  (manual-test.md "Status in this PR").
