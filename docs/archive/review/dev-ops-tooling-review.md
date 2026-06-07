# Plan Review: dev-ops-tooling

Date: 2026-06-07
Review round: 1 (single round — outcome collapsed scope; see Resolution)

## Changes from Previous Round
Initial review of the plan covering `dev.sh`, systemd units, and a `scripts/`
reorganization.

## Functionality Findings
- **F1 [Major]** — C4 grep gate omitted `CLAUDE.md`, `README.md`, `README.ja.md`,
  `CONTRIBUTING.md`, `messages/` (e.g. `messages/{en,ja}/OperatorToken.json:36`
  embeds `scripts/purge-history.sh` in a user-visible `usageHint`).
- **F2 [Major]** — `CONTRIBUTING.md:17-27` "Root-of-`scripts/` fixed" explicitly
  pins (with reasons) every file the reorg would move. The reorg contradicts a
  documented, must-respect policy.
- **F3 [Major]** — C3b reference list missed `scim:smoke`, `generate:icons`,
  `generate:audit-anchor-signing-key`, `generate:audit-anchor-tag-secret` in
  `package.json`.
- **F4 [Major]** — `scripts/__tests__/*` build paths via `resolve(ROOT,"scripts",...)`
  (not ES imports); C3a/C3b reference lists didn't cover them.
- **F5 [Major]** — `scripts/check-env-docs.ts` `SCRIPT_DIR` uses `"../.."` (repo
  root from `scripts/`); moving to `scripts/env/` shifts it to `"../../.."`, plus
  five hardcoded `resolve(root,"scripts/env-*.ts")` strings need rewriting.
- **F6 [Major]** — systemd `Restart=on-failure` is ineffective with a plain
  foreground `docker compose up`; needs `--abort-on-container-exit`.
- **F7 [Minor]** — `dev.sh` self-referential help strings hardcode `scripts/dev.sh`
  (moot once the file stays at `scripts/dev.sh`).
- **F8 [Minor]** — `ExecStop` races with SIGTERM; add `KillMode=mixed` /
  `TimeoutStopSec`.

## Security Findings
- **S1 [Critical, escalate:true]** — `CODEOWNERS:35` `/scripts/env-allowlist.ts`
  (SEC-4 allowlist governance gate) would be silently dropped on move to
  `scripts/env/`; no `/scripts/env/**` rule exists. Ungated changes to the
  env-validation-bypass allowlist.
- **S2 [Major]** — `CODEOWNERS:5-10` per-path rules for the six admin refactor
  tools become dead on move; policy comment says "stay at scripts/ root".
- **S3 [Major]** — systemd `.env` is the sole secrets carrier with no
  `EnvironmentFile=`; plan/README didn't mandate `0600 root:root`. World-readable
  `.env` on a multi-user host leaks all secrets.
- **S4 [Minor]** — `docker-compose.override.yml` `minioadmin/minioadmin` dev
  default lacks a documented gitleaks allowlist note (dev-only, not in prod base
  stack).
- **S5 [Minor]** — `ci.yml:228 check-state-mutation-centralization.sh` covered by
  the `.github/workflows/*` surface but not named explicitly in C3a.

## Testing Findings
- **T1-T3 [Major]** — eight `scripts/__tests__/*` subprocess `resolve()` paths
  (set-*-password, check-state-mutation, worker-env, env-tool tests) break on
  move; per-batch checklists named only the one ES import in `init-env.test.mjs`.
- **T4 [Major]** — no test exercises `npm run check:env-docs` without `--root`,
  so the `SCRIPT_DIR` depth break (F5) is invisible to vitest.
- **T5 [Minor]** — boot-smoke flag is `--validate-env-only` not `--help`;
  `audit-chain-verify-worker` lacks the flag and a `package.json` script.
- **T6 [Minor]** — `ci.yml` `paths-filter` env entries would go stale (silent
  CI-trigger gap), not just the `run:` commands.
- **T7 [Minor]** — `check-licenses.mjs:65-66` says `license-allowlist.json` stays
  at `scripts/`; moving it breaks `resolve(__dirname,"..","license-allowlist.json")`
  and C4's literal grep would not catch it.

## Adjacent Findings
- S4 noted minio is absent from the production base compose (override-only).

## Resolution Status

### Scope decision — `scripts/` reorganization (C3/C3a/C3b/C3c/C4) — Dropped
- **Anti-Deferral check**: "out of scope (different feature)" — superseded by an
  explicit user scope decision after the policy conflict was surfaced.
- **Justification**: F2 + S1 + S2 establish that the top-level `scripts/` layout
  is an intentional, documented Directory Policy (`CONTRIBUTING.md` §"Root-of-
  `scripts/` fixed", per-path `CODEOWNERS` gates, prior "PR 2" check-*
  consolidation). The move map conflicted with that policy on nearly every entry
  and would have dropped the SEC-4 CODEOWNERS gate (S1, Critical). Overturning a
  load-bearing policy is its own decision, not a side effect of a tidy-up PR.
- **Effect on findings**: F1, F3, F4, F5, F7, S1, S2, S5, T1-T7 are resolved by
  elimination (the moves that would trigger them are not performed). Tracked here
  so they are auditable if a future reorg PR revisits the move map.
- **Orchestrator sign-off**: confirmed — user chose "drop the reorg"; the only
  retained scripts/ change is adding `dev.sh` to the `CONTRIBUTING.md`
  operational pin list (keeps the policy in sync with the new file).

### Retained findings — folded into C2 (systemd) / C1 (dev.sh)
- **F6 — Fixed**: `ExecStart=... up --abort-on-container-exit` in
  `infra/systemd/passwd-sso.service`.
- **F8 — Fixed**: `KillMode=mixed` + `TimeoutStopSec=90` added.
- **S3 — Fixed**: `infra/systemd/README.md` mandates
  `install -m 0600 -o root -g root .env`; plan C2 invariant updated.
- **R32 / R35 — Fixed**: `docs/archive/review/dev-ops-tooling-manual-test.md`
  adds the operator boot + crash-recovery (A2 exercises F6) + secret-mode (A4)
  test plan; README links it.
- **F7 — Moot**: `dev.sh` stays at `scripts/dev.sh`, so its self-referential
  help strings are already correct.
- **S4 — Skipped (Minor)**: dev-only default credential in an override file that
  the systemd unit never loads (prod base stack has no minio). Worst case: CI
  secret-scan noise; Likelihood: low (low-entropy literal, current ruleset does
  not flag); Cost to fix: low but orthogonal to this PR's intent. Tracked as a
  pre-existing dev-hygiene item, not introduced here.

## Recurring Issue Check
### Functionality expert
- R1 (reimplementation): N/A — `dev.sh` is a thin wrapper over the same compose
  pair, with unique subcommands.
- R3 (incomplete propagation): was the central reorg risk; eliminated by dropping C3.
- R15 (hardcoded env-specific values): clean — systemd unit uses a documented
  `WorkingDirectory` placeholder, secrets via compose `.env`.
- R32 (long-running artifact boot test): addressed via manual-test A1/A2.
- R35 (deployment artifact manual-test): addressed via `dev-ops-tooling-manual-test.md`.

### Security expert
- R15: no finding. R18 (allowlist sync): S1/S2 — resolved by not moving the gated
  files. R31 (destructive ops): clean — `dev.sh` forbids `down -v`. R33 (CI
  security-gate path drift): resolved by dropping the moves. R35: present (manual
  test). RS4 (personal data in artifacts): clean — no personal emails/handles in
  any new doc.

### Testing expert
- R7 (path breakage in tests): eliminated (no moves). R16 (dev/CI RLS parity):
  N/A (rls files not moved). R19 (mock/fixture alignment): clean. R32 (boot smoke
  + ready signal): manual-test A1/A2; static `systemd-analyze verify` is the CI-
  side gate. RT1 (mock-reality divergence): N/A.
