# Code Review: security-review-2026-07-followup

Date: 2026-07-23
Review round: 4

## Round 4 — third external re-review (all addressed)

- **High — `COPY . .` ships the whole git-ignored secret class.** Rounds 1-3 closed `.env`
  only; a real builder still carried `.passwd-sso-env.json`, `certificates/*.pem`, and the
  1.45 GB `infra/terraform/.terraform`. Fixed by mirroring `.gitignore`'s secret/artifact
  entries into `.dockerignore` recursively (keys/certs, CLI vault mapping, Terraform
  state/tfvars/.terraform, local DBs), keeping `!**/*.tfvars.example`. Guard expanded to the
  full class incl. ancestor-directory matches; self-test → 12 cases. **Verified against a real
  `docker build --target builder`: all 4 leaked paths absent, 0 secrets at any depth.** This
  finally closes the defect CLASS (git-ignored-secret-in-context), not just the `.env` instance.
- **Low — Terraform README build context.** `docker build ... .` from `infra/terraform` (no
  Dockerfile there) → `docker build -f ../../Dockerfile ../..` (en + ja).
- **Low — k8s `envsubst` comment.** Corrected to Kustomize `images:`/`sed` (envsubst can't
  substitute a literal placeholder). Fail-closed placeholder kept.

## Round 3 — second external re-review (all addressed, see below)

Review round: 3

## Round 3 — second external re-review (all addressed)

- **Med — nested `.env` still in build context (`extension/.env`).** Round-2's
  `.env`/`.env.*` were ROOT-ONLY; Docker does not exclude subdir files with a bare
  `.env`, and the guard only tested root names + `.next/standalone` → it greened while
  `extension/.env` shipped to the builder. Fixed: recursive `**/.env` / `**/.env.*`
  (+ `!**/.env.example`). Guard hardened — static assertion tests nested paths + nested
  placeholders; bundle scan walks a whole extracted image tree
  (`DOCKERIGNORE_SECRETS_IMAGE_ROOT`), excluding node_modules. **Verified against a real
  `docker build --target builder`: 0 secret `.env` at any depth, `extension/.env` absent.**
  Self-test → 9 cases incl. the nested-miss red case (RT7).
- **Med — remaining `:latest`.** Root `terraform.tfvars.example` → version tags. k8s
  worker manifests → `REPLACE_WITH_IMMUTABLE_IMAGE_REF` placeholder (fails fast if not
  substituted at deploy — no runnable mutable tag).
- **Med — `.claude/settings.json` broad `rtk read *`.** Confirmed absent from HEAD AND
  working tree (removed in Round 2's recommit).
- **Med (F3) / Low (liveness)** — accepted as tracked deferrals with full Anti-Deferral
  entries (worst case / likelihood / cost / decision) in the deviation log.

## Round 2 — external re-review (all addressed, see below)

Review round: 2

## Round 2 — external re-review findings (all addressed)

A second external review of the committed branch surfaced findings the first
review round missed — most importantly a High secret-exposure the triangulation
had not covered. All addressed:

- **High (NEW) — `.env` shipped in the container image.** `.dockerignore` excluded
  `.env.local` but not `.env`; `COPY . .` + Next.js `output: "standalone"` tracing
  copied the 12.4 KB `.env` (real dev secrets) into `.next/standalone` → the final
  image. **Verified end-to-end**: a Docker build with the pre-fix ignore produced
  `/app/.env`; after adding `.env` + `.env.*` (keep `!.env.example`), a fresh
  `docker build --target builder` has NO `/app/.env` and no `.env` in standalone.
  Added `scripts/checks/check-dockerignore-secrets.sh` (static assertion always-on
  + opt-in bundle scan), wired into `pre-pr.sh` (→ CI static-checks), with a 6-case
  self-test proving RT7 red-capability. Mutation-verified: pre-fix `.dockerignore`
  fails the guard.
- **Medium — image-pin inconsistency.** `:latest` remained in dev+prod tfvars
  examples, `README.ja.md`, and k8s comments while ECR is IMMUTABLE. Fixed the
  examples/README to version tags and added `validation` blocks on `app_image`/
  `jackson_image` that REJECT `:latest` (verified via `terraform console`:
  `:latest`→false, `:v0.4.71`→true, `@sha256:…`→true, untagged→false).
- **Low — compose ships broad app creds to workers.** `docker-compose.override.yml`
  now blanks `DATABASE_URL` for both workers (empty→unset→scoped URL). Added a
  production hard-requirement to both worker schemas: `NODE_ENV=production` REQUIRES
  the dedicated URL (no DATABASE_URL fallback), with 4 new tests (red-before proven).
- **Low — liveness probe overstated.** Corrected both manifest comments: the
  `--validate-env-only` probe does NOT observe the running worker / DB; heartbeat
  liveness is the tracked follow-up.
- **Low — dev CVE.** `body-parser` override → `^2.3.0` (via shadcn→mcp-sdk→express);
  `npm audit` (dev+prod) now 0 vulnerabilities.
- **Informational — stale security docs.** Updated `owasp-top10-2026-05.md`: passkey
  session callback is now fail-closed; webhook SSRF now pins validated IPs (DNS
  rebinding defeated) — both verified against current code before editing.
- **Medium (F3) — Terraform state secrets.** Reconfirmed as a tracked deferral:
  documentation control shipped (encrypted-backend requirement + secret-injection
  guidance, en+ja); the data-source externalization rework needs a live AWS account
  and remains an Anti-Deferral follow-up (see deviation log). Not claimed as fixed.

## Round 1 (initial triangulated review — see below)

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
