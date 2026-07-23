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

### Round 7 — sixth external re-review additions
- **Bundle-scan fail-open (Low, but security-critical shape)**: a gate that greens on its own
  internal error is worse than no gate. Fixed all three fail-open paths — node-derivation crash,
  empty signature set, find error — to exit 1 with a "failing CLOSED" message. The static node
  check was already fail-closed (runs under `set -e` as a simple command).
- **bash 3.2 portability**: `mapfile` → `while IFS= read -r` heredoc loop.
- **Class-semantics single-sourcing**: chose to KEEP the extGlobs/dirClasses derivation with its
  exact-basename fallback (which guarantees any new MUST_EXCLUDE class is still searched) and rely
  on the contract test as the mechanical static/bundle-parity proof, rather than a more complex
  single declarative table. Documented the guarantee in the guard header.

### Round 5 — fourth external re-review additions
- **High: `.dockerignore` secret class was still incomplete.** Round 4 transcribed visible
  `.gitignore` entries but not systematically — `e2e/.auth-state.json` (Playwright session
  token), `postgres_data/`, `prisma/*.db-journal`, `saml/` were missing. Fixed by
  enumerating every `.gitignore` entry from a `grep`ed listing (then hand-classifying each as
  secret/data vs build-noise) and adding the gaps. Added a
  cross-check that every `.gitignore` secret class has a representative path excluded by
  `.dockerignore` (result: ALL COVERED; both `*.example` placeholders included).
- **Low: static / bundle drift.** Refactored the guard so both checks derive from ONE shared
  `MUST_EXCLUDE` representative-path list (bash array → exported to the node static check and
  used to shape the bundle `find`). No more "static covers X, bundle silently doesn't."
- **Doc: fixed the duplicated Round 3 heading** and softened the premature "closes the defect
  class" wording (kept surfacing new members across rounds).
- **Guard representative-path gotcha**: the saml class's representative path must be a NON-cert
  file (`saml/metadata.xml`), else `**/*.cert` covers it and the "drop `**/saml`" red test
  can't go red — a representative path must be uniquely-covered by its own pattern.

### Round 4 — third external re-review additions
- **High: `COPY . .` ships the WHOLE git-ignored secret class, not just `.env`.** Rounds 1-3
  closed `.env` (root then nested) but the real class is every secret/artifact `.gitignore`
  excludes. A real builder still carried `/app/.passwd-sso-env.json`, `certificates/*.pem`,
  and the 1.45 GB `infra/terraform/.terraform`. Fixed by mirroring `.gitignore`'s
  secret/artifact entries into `.dockerignore` recursively (keys/certs, CLI vault mapping,
  Terraform state/tfvars/.terraform, local DBs, review/auth artifacts) with `!**/*.tfvars.example`
  kept. Guard expanded: static `mustExclude` covers all classes incl. ancestor-dir matches
  (`**/.terraform` excludes its subtree — the guard's glob translator now matches a path when
  any ancestor matches); bundle scan finds keys/certs/tfstate/.terraform too. Self-test → 12
  cases. **Verified against a real `docker build --target builder`: all 4 previously-leaked
  paths absent, 0 git-ignored secrets/artifacts at any depth.**
- **Low: Terraform README docker build context.** en+ja READMEs ran `docker build ... .` from
  `infra/terraform`, which has no Dockerfile. Fixed to `docker build -f ../../Dockerfile ../..`
  (repo-root context). This also makes the .dockerignore hardening the operative control for
  the now-correct build path.
- **Low: k8s `envsubst` comment.** `envsubst` only substitutes `$VAR`/`${VAR}`, not the literal
  `REPLACE_WITH_IMMUTABLE_IMAGE_REF` placeholder. Corrected the comment to Kustomize `images:`
  or `sed` (kept the fail-closed placeholder).

### Round 3 — second external re-review additions
- **Med: nested `.env` in build context** (`extension/.env`). Round-2's `.env`/`.env.*`
  patterns were ROOT-ONLY; Docker does not exclude subdirectory files with a bare
  `.env`. Fixed with recursive `**/.env` / `**/.env.*` (+ `!**/.env.example` to keep
  nested placeholders). Strengthened the guard: static assertion now tests nested paths
  (`extension/.env`, `a/b/c/.env`) and nested placeholders; bundle scan now walks an
  ENTIRE extracted image/builder tree (`DOCKERIGNORE_SECRETS_IMAGE_ROOT`), not just
  `.next/standalone`, excluding `node_modules`. Verified against a real
  `docker build --target builder`: 0 secret `.env` at any depth, `extension/.env` absent.
  Self-test grew to 9 cases incl. the nested-miss red case.
- **Med: remaining `:latest`**. Root `terraform.tfvars.example` → version tags. k8s worker
  manifests → an unresolved `REPLACE_WITH_IMMUTABLE_IMAGE_REF` placeholder (NOT a runnable
  `:latest`) so a manifest applied without deploy-time substitution fails fast instead of
  pulling a mutable image.
- **`.claude/settings.json`**: the broad `Bash(rtk read *)` permission is absent from both
  HEAD and the working tree (removed in Round 2's recommit; confirmed clean).

### Round 2 — external re-review additions
- **High `.env`-in-image**: not in the original plan scope (the triangulation focused
  on the 9 reported findings; this leak was found by the re-review). Fixed
  `.dockerignore` + added a mutation-verified guard with self-test. Verified against
  a real `docker build`.
- **NODE_ENV=production dedicated-URL requirement**: added a SECOND refine per worker
  (the first stays at path `DATABASE_URL` for the "nothing configured" case; the new
  one pins path to the dedicated URL for the prod-fallback case). Two refines are
  required because a Zod `.refine()` path is static and the two failure modes need
  distinct diagnostic paths.
- **body-parser override**: chose the override path (not shadcn removal) per the
  established project decision — dev-only Low, shadcn is a CLI devDep. `2.2.2 → 2.3.0`.
- **liveness probe**: corrected comment + documented limitation rather than
  implementing heartbeat liveness (needs worker-code change; tracked follow-up).

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

### Worker liveness heartbeat deferred to follow-up (Low)
- **What**: the liveness probe re-parses env + re-execs the binary (`--validate-env-only`).
  It is strictly better than a tautological `process.exit(0)` (catches a broken image /
  unparseable env) but does NOT observe the running worker — a hung main loop, stalled queue,
  or DB outage will not fail it. Comments now state this limitation accurately.
- **Worst case**: a wedged worker keeps passing liveness; audit_outbox / retention GC stalls
  go unnoticed until an external signal (queue-age alert) fires.
- **Likelihood**: Low — restart-on-crash still works; env-parse failures still restart; the
  gap is only the "process alive but not making progress" mode.
- **Cost to fix**: Medium — the worker must write a heartbeat/last-success timestamp that the
  probe reads (worker-code change + a probe script), plus a queue-oldest-PENDING-age alert.
- **Decision**: ship the corrected probe + accurate comments now; heartbeat liveness is a
  tracked follow-up. Accepted known operational risk.

## Verification environment constraints (realized)

- k8s manifests: no live cluster / kubeconform / kubectl available. Validated by Node `yaml`
  parse + structural assertion (env keys, securityContext, probe commands). No live rollout.
- Terraform: `terraform fmt -check` passed on ecr.tf / secrets.tf / backend.tf. No `apply`
  (no AWS account); changes are value/comment-level (MUTABLE→IMMUTABLE, tagPrefixList, docs).
- gitleaks: not preinstalled; installed the CI-pinned v8.30.1 (checksum-verified; arm64 binary
  for this host, x64 in CI — same ruleset) and ran the exact CI scan command against a clean
  `git archive` tree. Result: no leaks found.
