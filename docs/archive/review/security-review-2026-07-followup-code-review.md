# Code Review: security-review-2026-07-followup

Date: 2026-07-23
Review round: 1 (+ inline tightening applied)

## Changes from Previous Round
Initial triangulated review of the branch diff (F1–F7). Three expert sub-agents
(functionality, security, testing) reviewed the staged diff independently.

## Functionality Findings
- **Sound.** F2 Zod `.extend().refine()` construction verified empirically against Zod 4.4.3
  (empty→undefined transform, `path:["DATABASE_URL"]` pinning, fail-closed guard narrows
  `string|undefined`→`string` for `createWorker` — not merely dead code, it is load-bearing for
  compilation). F4 ecr.tf tagPrefixList + README `node -p` path resolution confirmed. k8s probe
  path `dist/audit-outbox-worker.js --validate-env-only` matches the esbuild output naming and
  the flag exists. UID/GID 1001 matches Dockerfile.
- **[Minor]** Two checklist items intentionally absent from diff (env.test.ts vacuous-mock,
  backend.tf documented no-op) — now recorded in the deviation log.

## Security Findings
- **No Critical/Major.** F1 regex `^[A-Za-z_][A-Za-z0-9_]*$` blocks all shell metacharacters at
  the emit sink; verified no bypass (incl. trailing-newline — JS `$` sans `m` matches only
  end-of-input). No config field (entry/field/value) reaches shell unvalidated. F30/S22 no-echo
  upheld on all error paths. F2 is behavior-preserving (R43 — no boundary widening). F5
  securityContext complete. F7 path regex is single-segment anchored (no traversal); re-exposes
  the rest of docs/ to scanning (the security win).
- **[Minor, fixed]** F7 false-positive regexes lacked a `paths` scope → suppressed repo-wide.
  Scoped to `paths=['''^docs/''']`.

## Testing Findings
- **[Major, fixed]** RT8 — the "does not echo payload" test passed vacuously (pre-fix loader
  never throws → empty message → non-containment trivially true). Added `toBeDefined()` +
  `length>0` guards. Red-before now proven on a scratchpad copy (was green pre-fix, now red).
- **[Minor, fixed]** Added a positive 128-char boundary test (accepts exactly 128) to guard an
  off-by-one regression to `>= 128`; reject test now uses a clean 129-char key.
- **Sound.** F2 least-privilege positive test genuinely exercises the empty→undefined
  normalization and is red-before/green-after. dotenv-leak suppression (explicit `""` for the
  dedicated URL) is correct and necessary (R16). Fail-closed guard is unreachable given the
  refine — acceptable untested defense-in-depth (also load-bearing for the type).
- **R42/CI-guard**: not warranted — single choke point, single validation member, single call
  site; 6 regression tests cover its removal. A CI manifest-guard would be over-engineering.

## Environment Verification Report
Per Phase 1 `Verification environment constraints`:
- k8s manifests: `blocked-deferred` (no live cluster) → validated by Node `yaml` parse +
  structural assertion. Linked to Phase 1 constraint + deviation log.
- Terraform: `verified-local` — `terraform fmt -check` passed on ecr.tf/secrets.tf/backend.tf.
- gitleaks: `verified-local` — pinned v8.30.1 (checksum-verified) scan of clean `git archive`
  tree → no leaks found.
- CLI + app tests + build: `verified-local` (see Resolution Status).

## Resolution Status
### Testing Major — vacuous no-echo test
- Action: added throw + non-empty-message guards; proved red-before on scratchpad copy.
- Modified file: cli/src/__tests__/unit/secrets-config.test.ts

### Testing Minor — missing 128-char accept boundary
- Action: added positive boundary test; reject test uses 129-char key.
- Modified file: cli/src/__tests__/unit/secrets-config.test.ts

### Security Minor — repo-wide regex allowlist
- Action: scoped the 3 F7 example regexes to `paths=['''^docs/''']`; re-verified no leaks.
- Modified file: .gitleaks.toml

### Verification
- CLI: 340 passed. Worker-env + env-schema: 67 passed. Lint: 0 errors. next build: success.
- gitleaks (pinned 8.30.1): no leaks found. terraform fmt: clean.
