# Plan: dev-ops-tooling

> **Revision (post Phase-1 review)**: The `scripts/` reorganization (contracts
> C3/C3a/C3b/C3c) is **dropped**. Phase-1 review surfaced that the top-level
> `scripts/` layout is governed by an intentional, documented Directory Policy
> (`CONTRIBUTING.md` §"Root-of-`scripts/` fixed" + per-path `CODEOWNERS` gates;
> the check-* consolidation already happened in a prior "PR 2"). The proposed
> move map conflicted with that policy on nearly every entry and would have
> dropped the SEC-4 `env-allowlist.ts` CODEOWNERS gate (review finding S1,
> Critical). Net value did not justify overturning a load-bearing policy in
> this PR. **Final scope: C1 (`dev.sh`) + C2 (systemd) only.** C3 and its
> review findings (F1–F5, S1–S2, T1–T7) are resolved by elimination. The
> systemd findings F6/F8/S3/R32/R35 are folded into C2 below.

## Project context

- **Type**: `mixed` — CLI/shell tooling (`scripts/`) + deployment artifacts (systemd, Docker Compose) + a file-move refactor across a Next.js web app.
- **Test infrastructure**: `unit + integration + E2E + CI/CD`. `scripts/__tests__/` holds vitest specs that import the very scripts being moved; `pre-pr.sh` and `.github/workflows/*` invoke many scripts by path.
- **Verification environment constraints**:
  - VC1 — systemd units cannot be `systemctl start`-verified in this dev environment (no systemd-managed Docker host here). Verification is limited to `systemd-analyze verify` (static unit-file lint) + manual-test instructions for the operator. Classified `blocked-deferred` for the live-boot path; `verifiable-local` for static lint.
  - VC2 — `dev.sh` end-to-end (`init`→`start`) requires a working Docker daemon + the full secret set in `.env`; the no-arg/`help` path and `bash -n`/shellcheck are `verifiable-local`, the Docker-touching subcommands are `blocked-deferred` (operator runs them).
  - VC3 — the production image build (`docker build`) that would prove the worker-path move in the Dockerfile is heavy; classified `verifiable-CI` (CI builds the image) with a local `grep`-level path-consistency check as the cheap gate.

## Objective

Three cohesive deliverables for self-host / local-dev operability, plus a structural tidy of `scripts/`:

1. **`dev.sh`** — a local-dev Docker Compose helper (`start`/`stop`/`restart`/`logs`/`init`/…). *(already drafted; this plan locks its surface)*
2. **systemd units** — run the production Docker Compose stack (`docker-compose.yml`) as a managed service on a self-hosted VM.
3. **`scripts/` reorganization** — move the ~30 scattered top-level scripts into purpose-named subdirectories, updating every **live** reference (package.json, CI, `pre-pr.sh`, deploy artifacts, live docs, test imports). Archived review docs are left untouched as historical record.

## Requirements

### Functional
- `dev.sh` wraps the same compose-file pair as `npm run docker:up` (base + override) and adds first-run bootstrap.
- systemd unit(s) start/stop the **base** `docker-compose.yml` stack (NOT the dev override — no host port exposure in prod) and restart on failure.
- After reorg, every `npm run` script, CI job, `pre-pr.sh` check, worker container command, and live doc command that references a moved script resolves to the new path.

### Non-functional
- No behavior change to any moved script (pure relocation + import-path rewrite).
- `pre-pr.sh` and `vitest` stay green. `next build` is **out of scope** to gate on (no app/`src` code changes — per the project rule that build cannot catch script-only issues); it remains runnable but is not a required gate for this PR.
- Deployment-artifact changes (systemd, Dockerfile worker path, compose `command`) carry a manual-test artifact (R35 Tier-1).

## Technical approach

- **systemd**: a `Type=oneshot`/`RemainAfterExit` style unit is wrong for a long-lived stack; use `docker compose up` with `Restart=on-failure` is also wrong (compose `up` without `-d` blocks; with `-d` it exits). Correct pattern: a single service that runs `docker compose up` in the **foreground** (no `-d`) so systemd tracks it, with `ExecStop=docker compose down`. Place under `infra/systemd/`.
- **scripts move**: use `git mv` per file (preserves history), then rewrite relative imports for the env cluster, then sweep references. Workers use `@/` alias imports → no intra-script import rewrite needed, only path references in build/deploy/docs.
- **Risk tiering** — implement and commit in three independently-verifiable batches, low→high blast radius (see Contracts C3a/C3b/C3c).

## Contracts

### C1 — `scripts/ops/dev.sh` command surface *(locked; already implemented)*
- **Signature**: `dev.sh <init|start|stop|restart|logs|status|build|migrate|seed|shell> [args]`, plus `help`/`-h`/`--help`/`""`.
- **Invariants** (app-enforced):
  - Resolves repo root via `BASH_SOURCE` and `cd`s there → runnable from any CWD.
  - Uses exactly `docker compose -f docker-compose.yml -f docker-compose.override.yml` (same pair as `npm run docker:up`).
  - `init` is idempotent: skips `.env` generation if `.env` exists, skips `npm install` if `node_modules` exists.
  - `migrate` runs the profile-gated one-shot via `--profile migrate run --rm migrate`.
  - Every Docker-touching command guards on `.env` presence (`require_env`) except `stop`/`status`/`build`.
- **Forbidden patterns**:
  - `pattern: docker compose down -v` — reason: never destroy named volumes (postgres_data/redis_data) from a dev helper.
  - `pattern: set -x` — reason: no command tracing that could echo secrets.
- **Acceptance**: `bash -n` clean; `dev.sh help` prints the usage block; `shellcheck` clean if installed.
- **Location**: `scripts/dev.sh` — pinned at `scripts/` root alongside `deploy.sh` per `CONTRIBUTING.md` §"Root-of-`scripts/` fixed" → "Other operational" (this PR adds `dev.sh` to that list). The earlier `scripts/ops/dev.sh` idea is void with C3 dropped.

### C2 — systemd unit(s) under `infra/systemd/`
- **Files**:
  - `infra/systemd/passwd-sso.service` — manages the base compose stack.
  - `infra/systemd/README.md` — install/enable instructions + the `EnvironmentFile`/`WorkingDirectory` placeholders the operator must set.
- **`passwd-sso.service` contract**:
  - `[Unit]`: `After=docker.service network-online.target`, `Requires=docker.service`, `Wants=network-online.target`.
  - `[Service]`: `Type=simple`, `WorkingDirectory=/opt/passwd-sso` (documented placeholder), `ExecStartPre=-/usr/bin/docker compose -f docker-compose.yml pull` (best-effort; `-` prefix to not fail boot), `ExecStart=/usr/bin/docker compose -f docker-compose.yml up --abort-on-container-exit`, `ExecStop=/usr/bin/docker compose -f docker-compose.yml down`, `Restart=on-failure`, `RestartSec=10`, `KillMode=mixed`, `TimeoutStopSec=90`.
  - **`--abort-on-container-exit` is mandatory** (review F6): foreground `compose up` does NOT exit when a single container dies, so without it `Restart=on-failure` never fires and a crashed `app`/`redis` leaves systemd believing the service is healthy. With the flag, compose exits non-zero on any container exit → restart triggers.
  - `KillMode=mixed` + `TimeoutStopSec=90` (review F8): SIGTERM the compose process, let `ExecStop` do the orderly teardown, bounded stop time.
  - Runs the **base** file only (no `docker-compose.override.yml`) — prod must not expose db/redis/jackson ports.
  - Migrations: documented as a separate operator step (`docker compose --profile migrate run --rm migrate`) in the README, NOT auto-run by the unit (matches the existing one-shot `migrate` profile design).
- **Invariants**:
  - No hardcoded secrets; secrets come from the repo-root `.env` that compose auto-loads (the unit relies on `WorkingDirectory` + compose's native `.env` load, so no `EnvironmentFile=` is strictly required — README states this).
  - **`.env` file mode is the sole secret protection** (review S3): with no `EnvironmentFile=`, the README MUST instruct `install -m 0600 -o root -g root` for `/opt/passwd-sso/.env`. On a multi-user host a world-readable `.env` leaks every secret (DB passwords, `AUTH_SECRET`, `JACKSON_API_KEY`, `SHARE_MASTER_KEY`).
  - `docker compose` invoked with an absolute binary path (systemd has a minimal `PATH`).
- **Forbidden patterns**:
  - `pattern: docker-compose.override.yml` inside `passwd-sso.service` — reason: prod must not load the dev override.
  - `pattern: (?i)password|secret\s*=` literal assignment in the unit — reason: no inline secrets.
- **Acceptance**: `systemd-analyze verify infra/systemd/passwd-sso.service` reports no errors (VC1 static path); README documents enable/start/journalctl and the `0600` `.env` step; `docs/archive/review/dev-ops-tooling-manual-test.md` covers boot + crash-recovery + secret-mode (R35 Tier-1).

### C3 — `scripts/` target layout (move map) — **DROPPED** (see top-of-file Revision)
The move map below is retained for the record only; it is NOT implemented in
this PR. It conflicts with `CONTRIBUTING.md` §"Root-of-`scripts/` fixed" and the
per-path `CODEOWNERS` gates. Any future reorg must first amend that policy as
its own decision.

Target tree (existing subdirs `checks/`, `lib/`, `__tests__/`, `__fixtures__/`, `manual-tests/` retained; `pre-pr.sh` stays at `scripts/pre-pr.sh` as the entry point):

```
scripts/
  workers/      audit-outbox-worker.ts  dcr-cleanup-worker.ts
                audit-chain-verify-worker.ts  audit-anchor-publisher.ts
  env/          init-env.ts  generate-env-example.ts  check-env-docs.ts
                env-allowlist.ts  env-descriptions.ts
  rls/          rls-cross-tenant-{coverage,seed,verify}.sql
                rls-cross-tenant-negative-test.sh  rls-cross-tenant-tables.manifest
                rls-smoke-{seed,verify}.sql  tenant-team-phase2-validate.sql
                tenant-team-phase5-rls.sql
  migrations/   migrate-account-tokens-to-encrypted.ts
                migrate-prf-per-credential-salt.sh  migrate-webhook-secrets-v1-to-v2.ts
  ops/          dev.sh  deploy.sh  bump-version.sh  mcp-reauth.sh  scim-smoke.sh
                purge-audit-logs.sh  purge-history.sh  rotate-master-key.sh
                set-{outbox-worker,dcr-cleanup-worker,audit-anchor-publisher}-password.sh
                generate-{icons,audit-anchor-signing-key,audit-anchor-tag-secret}.sh
  checks/       (existing) + check-blame-ignore-revs.mjs  check-codeowners-drift.mjs
                check-state-mutation-centralization.{sh,ts}  coverage-diff.mjs
                refactor-phase-verify.mjs  move-and-rewrite-imports.mjs
                verify-allowlist-rename-only.mjs  verify-move-only-diff.mjs
                license-allowlist.json
  __tests__/ __fixtures__/ lib/ manual-tests/  (unchanged location)
  pre-pr.sh   (unchanged — entry point)
```

`regenerate-account-token-legacy-fixture.ts` → `scripts/__tests__/` (it regenerates a test fixture).

Implemented as three batches:

#### C3a — checks consolidation (LOW blast radius, CI-only)
- Move the scattered `check-*`/`verify-*`/`coverage-diff`/`refactor-phase-verify`/`move-and-rewrite-imports`/`license-allowlist.json` into `checks/`.
- **Reference surfaces to update**: `pre-pr.sh`, `.github/workflows/*`, `scripts/__tests__/*` import paths, any check that reads `license-allowlist.json` by relative path, cross-references between the moved `.mjs` and `checks/` siblings.
- **Invariant**: no runtime/deploy artifact references these (verified — they are CI/lint only).

#### C3b — rls / migrations / ops grouping (MEDIUM, no import rewrites)
- `git mv` the `.sql`/`.sh`/`.manifest`/`.ts` into `rls/`, `migrations/`, `ops/`.
- **Reference surfaces**: `.github/workflows/*` (rls suite paths, `rls-cross-tenant-tables.manifest`), `pre-pr.sh` (manifest + verify SQL), `package.json` (`migrate:account-tokens`, `bump-version`/`version:bump`), `CLAUDE.md` admin-script command block, live docs under `docs/operations/`, `docs/setup/`.
- `migrate-account-tokens` relative imports: verify none to siblings (uses `@/`).

#### C3c — workers / env (HIGH blast radius)
- `git mv` workers → `workers/`, env cluster → `env/`.
- **env import rewrites** (relative): inside `env/`, `./env-allowlist` and `./env-descriptions` stay valid (same dir); `./lib/*` → `../lib/*` in `init-env.ts` and `generate-env-example.ts`. Update `scripts/__tests__/*` imports (`../init-env.ts` → `../env/init-env.ts`, etc.).
- **worker reference surfaces** (NO import rewrite — `@/` alias): `package.json` (`worker:*`), `Dockerfile`, `docker-compose.override.yml` (`command:`), live docs `docs/setup/{aws,azure,gcp,vercel}/en.md`, `docs/operations/alerts.md`, `docs/security/audit-preparation-checklist.md`.
- **env reference surfaces**: `package.json` (`init:env`, `generate:env-example`, `check:env-docs`), `.github/workflows/*`, `pre-pr.sh`, `CLAUDE.md`.

### C4 — reference-update completeness invariant
- **Invariant (app-enforced via grep gate)**: after each batch, `grep -rn` for the OLD path of every moved file across **live** surfaces (`package.json`, `.github/`, `pre-pr.sh`, `Dockerfile`, `docker-compose*.yml`, `infra/`, `docs/` **excluding `docs/archive/`**, `scripts/` **excluding `scripts/__tests__/fixtures/`**) returns **zero** hits. Archive docs (`docs/archive/**`) and `.next/` cache are explicitly excluded.
- **Forbidden pattern (per batch)**: the moved file's old `scripts/<name>` path appearing in any live surface after the batch commit.

## Testing strategy
- Per batch: run the specific affected gate first (targeted), then the full `pre-pr.sh` before the final commit.
  - C3a: `npx vitest run scripts/__tests__` + the moved checks invoked directly + `bash scripts/pre-pr.sh` (or the relevant check subset).
  - C3b: re-run any `.github/workflows` RLS step locally if a DB is available (else grep-gate + manual note); `npx vitest run`.
  - C3c: `npx vitest run scripts/__tests__`; `npm run worker:audit-outbox -- --help`-style boot smoke for each worker (R32 — confirm the process resolves its new path and loads env; declare ready signal); `grep` Dockerfile/compose path consistency (VC3).
- Full suite gate before PR: `npx vitest run` green + `bash scripts/pre-pr.sh` green.

## Considerations & constraints

### Scope contract
- **SC1** — `docs/archive/review/**` path references to moved scripts are **NOT** rewritten. They are historical records of past plans/reviews; rewriting them falsifies the archive. Owner: permanent policy (this plan).
- **SC2** — Native (non-Docker) systemd units for individual workers (`tsx` processes) are out of scope; the chosen systemd model manages the whole compose stack (per user decision). Owner: future PR if a worker-only host is needed.
- **SC3** — `next build` is not a required gate (no `src/` changes). Owner: project rule "skip build for test/script-only changes".
- **SC4** — `.env`-dependent live runs of `dev.sh`/systemd are operator-side (VC1/VC2); CI/static verification only in this PR.

### Risks
- R-A: a missed live reference after a move → CI/pre-pr/worker-boot failure. Mitigated by C4 grep gate per batch.
- R-B: Dockerfile worker-path drift → broken production image (caught by CI image build, VC3 grep gate locally).
- R-C: systemd unit `PATH`/foreground-vs-detached mistake → service flaps. Mitigated by `systemd-analyze verify` + explicit foreground `up` pattern + README.

## User operation scenarios
1. New developer clones repo → `scripts/ops/dev.sh init` → `dev.sh start` → app on :3000, mailpit on :8025.
2. Operator on a VM → copies `infra/systemd/passwd-sso.service` to `/etc/systemd/system/`, edits `WorkingDirectory`, `systemctl enable --now passwd-sso` → stack runs, `journalctl -u passwd-sso -f` shows logs.
3. CI runs `pre-pr.sh` → all moved-script paths resolve; RLS suite + env-docs drift check + license check pass from their new `checks/`/`rls/`/`env/` homes.

## Go/No-Go Gate
| ID   | Subject                                                        | Status |
|------|---------------------------------------------------------------|--------|
| C1   | `dev.sh` command surface (stays at `scripts/dev.sh`)          | locked  |
| C2   | systemd `passwd-sso.service` + README + manual-test           | locked  |
| C3   | `scripts/` reorganization (move map)                          | dropped |
| C3a  | checks consolidation batch                                    | dropped |
| C3b  | rls/migrations/ops grouping batch                             | dropped |
| C3c  | workers/env batch (+ import rewrites)                         | dropped |
| C4   | reference-update completeness grep gate                       | dropped |
