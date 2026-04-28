# Code Review: dcr-cleanup-to-worker

Date: 2026-04-28
Review round: 1 (Phase 3 code review)

## Inputs reviewed

- Branch: `fix/dcr-cleanup-to-worker` @ `71b5bebe`
- Plan: `dcr-cleanup-to-worker-plan.md` (final v4)
- Deviation log: `dcr-cleanup-to-worker-deviation.md`
- Diff: `git diff main...HEAD` (36 files / +2909 lines)

## Functionality Findings

**No findings.** Implementation faithful to the plan; 3 documented deviations are reasonable trade-offs:
- `enqueueAuditInWorkerTx` inlined in worker (avoids `@/lib/prisma` singleton load)
- `_emitFn` injection point for tx-rollback test (works around inlined-function mock infeasibility)
- Sweep boundary row uses `now() + 10s` (cleaner than capturing exact-now timestamp)

All 12 verification items confirmed (audit emission shape, worker pool isolation, rate-limit/auth ordering, i18n, allowlist, dead code, R3 propagation, loop error log shape, R12 group placement, etc.).

## Security Findings

### S1 [Minor]: Default privileges do not REVOKE `REFERENCES`

Migration omits `ALTER DEFAULT PRIVILEGES ... REVOKE REFERENCES ON TABLES FROM passwd_dcr_cleanup_worker`. Outbox-worker pattern includes this defense-in-depth.

### S2 [Minor, pre-existing pattern]: k8s manifest lacks `securityContext`

No `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`. Pre-existing in `audit-outbox-worker.yaml`.

### S3 [Minor, plan deviation]: Liveness/startup probes are tautological

`["node", "-e", "process.exit(0)"]` only proves the binary runs. Plan §"k8s manifest" intent was `--validate-env-only`.

### S4 [Minor, pre-existing pattern]: `image: passwd-sso:latest` mutable tag

### S5-A, S6-A, S7-A [Adjacent, pre-existing]: token-validity oracle, audit forgery, URL refine

All inherited from existing pipeline; not widened by this PR.

## Testing Findings

### T1 [Major]: CI integration job will fail — `passwd_dcr_cleanup_worker` role has no password set

`.github/workflows/ci-integration.yml` bootstrap step does not `ALTER ROLE passwd_dcr_cleanup_worker WITH LOGIN PASSWORD ...`. Local-only green is meaningless for a critical-path test.

### T2 [Minor]: ci-integration.yml `paths:` filter does not include worker source paths

Future PRs touching only `src/workers/**` would not trigger ci-integration.

### T3-T10 [Minor]: Test-quality refinements (defense-in-depth)

AbortSignal test does not exercise abort-during-sleep path; missing role attribute assertion (NOSUPERUSER, NOBYPASSRLS); missing UPDATE/DELETE-on-audit_outbox negative assertions; boundary-row precision; cleanup pattern relies on module-scope `seededClientIds`; bootstrap script tests miss password-with-shell-metacharacters case; env-validation case 2 looser than 4/5; worker test uses `as any` on TxClient.

### T11-A [Adjacent → Functionality]: Worker omits `app.bypass_purpose` and `app.tenant_id` GUCs

Functionally OK because `app.bypass_rls=on` short-circuits the FK check — flagged for parity with audit-outbox-worker.

## Resolution Status

### T1 [Major] CI integration role password — RESOLVED
- Action: Added `ALTER ROLE passwd_dcr_cleanup_worker WITH LOGIN PASSWORD 'passwd_dcr_pass';` to ci-integration.yml bootstrap step.
- Modified file: `.github/workflows/ci-integration.yml:104-108`

### T2 [Minor] ci-integration paths filter — RESOLVED
- Action: Added `src/workers/**` and `src/__tests__/db-integration/**` to `paths:` filter.
- Modified file: `.github/workflows/ci-integration.yml:10-19`

### S1 [Minor] REFERENCES revoke — RESOLVED
- Action: Created new migration `20260428190000_revoke_references_from_dcr_cleanup_worker` (separate from the prior migration to preserve checksum). Added equivalent block to `infra/postgres/initdb/02-create-app-role.sql`.
- Modified files: `prisma/migrations/20260428190000_*/migration.sql`, `infra/postgres/initdb/02-create-app-role.sql`

### S3 [Minor] Liveness probe — RESOLVED
- Action: Changed `livenessProbe.exec.command` and `startupProbe.exec.command` to `tsx scripts/dcr-cleanup-worker.ts --validate-env-only` (mirrors readinessProbe and plan intent).
- Modified file: `infra/k8s/dcr-cleanup-worker.yaml:43-58`

### S2 [Minor] k8s securityContext — Out of scope
- **Anti-Deferral check**: out of scope (different feature)
- **Justification**: Pre-existing pattern in `audit-outbox-worker.yaml` (no securityContext there either). Adding to one but not the other creates inconsistency that future maintainers would unify in a separate hardening PR. Tracked as TODO for a future k8s-hardening PR covering both worker manifests + the app deployment.
- **Orchestrator sign-off**: confirmed (different feature exception applies; the gap exists across multiple files in the repo).

### S4 [Minor] `:latest` image tag — Out of scope
- **Anti-Deferral check**: pre-existing in unchanged file (the new dcr-cleanup-worker.yaml mirrors the existing audit-outbox-worker.yaml).
- **Justification**: Pre-existing pattern; both manifests are example templates that operators substitute when deploying. Documented expectation. Tracked as a TODO for k8s-hardening PR.
- **Orchestrator sign-off**: confirmed.

### T3 [Minor] AbortSignal test — Skipped
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: a regression in the AbortError catch path lets the loop hang on shutdown; k8s would SIGKILL after `terminationGracePeriodSeconds`
  - Likelihood: low — `setTimeoutPromise` AbortSignal handling is a Node.js stdlib contract
  - Cost to fix: ~30 minutes (rewrite test with `vi.advanceTimersByTimeAsync`)
- **Orchestrator sign-off**: tracked as a TODO; not a blocker.

### T4-T10 [Minor] Test-quality refinements — Skipped
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: a regression bypasses one of these defense-in-depth checks
  - Likelihood: low — covered by existing positive assertions and integration tests
  - Cost to fix: ~30-60 minutes total
- **Orchestrator sign-off**: tracked as TODO. Current tests cover the contract; refinements are incremental.

### T11-A [Adjacent / Functionality] GUC parity — Skipped
- **Anti-Deferral check**: acceptable risk
- **Justification**: Functionally correct (verified by audit-outbox-worker behavior pattern); cosmetic divergence only.
- **Orchestrator sign-off**: tracked as TODO for follow-up.

## Recurring Issue Check

### Functionality expert
- R1-R30: see Functionality Findings — all RESOLVED (no issues found).

### Security expert
- R1-R30 + RS1-3: see Security Findings — S1, S3 RESOLVED; S2, S4, S5-A, S6-A, S7-A out of scope / inherited.

### Testing expert
- R1-R30 + RT1-3: see Testing Findings — T1, T2 RESOLVED; T3-T10 deferred (acceptable risk).
