# Deviation Log: 2026-07 Triangulated Security Review Follow-up

Date: 2026-07-23
Plan: security-review-2026-07-followup-plan.md

## Deviations from plan

### F2 — empty-string DATABASE_URL normalized to "unset" (not rejected)
Plan initially said "an empty string is still rejected." During implementation this
conflicted with the existing test harness (`spawnWorker` always injects `DATABASE_URL: ""`)
AND the production intent: a least-privilege deployment sets only the dedicated URL and may
leave `DATABASE_URL=""`. Changed to normalize empty/whitespace → `undefined` via a
`.transform()`, making the `.refine()` the single arbiter of the at-least-one-URL rule. The
refine still emits `path: ["DATABASE_URL"]`, so existing negative tests keep their assertion.
Rationale: matches real deployment behavior; avoids rejecting a valid least-privilege config.

### F7 — added targeted false-positive allowlists (not just path narrowing)
Plan said "narrow the docs allowlist to the two sample-asset files." Doing only that surfaced
6 pre-existing false positives in design/review docs (base64 example decoding to "this is a
secret password", a PKCS#8 type-name, a curl example) that the blanket `^docs/` had masked —
verified via a pinned gitleaks 8.30.1 scan. Added three documented, narrowly-scoped regex
allowlists for those exact strings rather than re-broadening to all of docs/. Net result: the
full docs tree is now scanned (real accidental secret under docs/ IS caught) with zero CI noise.

### Implementation-checklist items intentionally not in the diff
- **`cli/src/__tests__/unit/env.test.ts`** (checklist listed shell+dotenv injection tests):
  omitted deliberately. `env.test.ts` fully mocks `loadSecretsConfig`, so an injection test
  there passes vacuously (green with or without the fix). The real regression lives in
  `secrets-config.test.ts` at the choke point — where both `env` and `run` funnel through — so
  the shell-vs-dotenv distinction is moot. The plan body already noted this; recording here so
  the checklist line isn't read as a missing test.
- **`infra/terraform/backend.tf`** (checklist listed "encrypted remote backend as documented
  default"): backend.tf already documents the encrypted S3 backend (`encrypt = true`,
  versioning, lock table). F3 routes operators to it via README + `secrets.tf` warnings rather
  than editing backend.tf itself. No code change was needed; the file is a documented no-op.

### Phase 3 review fixes (Round 1)
- **Testing Major (RT8)**: the "does not echo payload" test passed vacuously (pre-fix loader
  never throws → empty message → non-containment trivially true). Added `toBeDefined()` +
  `length > 0` guards; red-before now proven on a scratchpad copy.
- **Testing Minor**: added a positive boundary test that a 128-char key is ACCEPTED (guards an
  off-by-one regression to `>= 128`). Changed the reject test to a clean 129-char key.
- **Security Minor**: scoped the F7 false-positive regex allowlist to `paths=['''^docs/''']`
  so the 3 example-string regexes cannot suppress matches elsewhere in the tree.

## Anti-Deferral entries

### F3 — Terraform secret-value externalization deferred to follow-up
- **What**: The preferred hardening (create secret CONTAINERS in Terraform, inject VALUES
  out-of-band so they never enter state) was NOT implemented. This PR ships the operative
  control — documented requirement to use the encrypted S3 remote backend + tfvars/state
  secret warnings in `secrets.tf` and README — but the data-source rework is deferred.
- **Worst case**: an operator runs a real deployment on local state despite the warnings; DB /
  OAuth / master-key values sit in plaintext `terraform.tfstate` on a laptop or CI artifact.
- **Likelihood**: Low — the README and `secrets.tf` now carry explicit MUST-use-remote-backend
  warnings; the repo has no committed state (gitignored). Requires an operator to ignore the docs.
- **Cost to fix**: Medium — restructure `aws_secretsmanager_secret_version` to omit
  `secret_string` and document a `put-secret-value` CI step; needs a deploy-pipeline change and
  testing against a real AWS account (out of scope for this environment).
- **Decision**: ship the documentation control now; file the externalization rework as a
  tracked infra follow-up. The Medium is mitigated (encrypted backend documented as required),
  not fully closed.

## Verification environment constraints (realized)

- k8s manifests: no live cluster / kubeconform / kubectl available. Validated by Node `yaml`
  parse + structural assertion (env keys, securityContext, probe commands). No live rollout.
- Terraform: `terraform fmt -check` passed on ecr.tf / secrets.tf / backend.tf. No `apply`
  (no AWS account); changes are value/comment-level (MUTABLE→IMMUTABLE, tagPrefixList, docs).
- gitleaks: not preinstalled; installed the CI-pinned v8.30.1 (checksum-verified; arm64 binary
  for this host, x64 in CI — same ruleset) and ran the exact CI scan command against a clean
  `git archive` tree. Result: no leaks found.
