# Code Review: container-log-rotation-caps

Date: 2026-08-25
Review round: 1 (standalone Phase 3 — no Phase 1/2 plan artifacts)
Branch: `fix/container-log-rotation-caps`

## Changes from Previous Round

Initial review. Base commit `0b4bfb910` — container log caps across five compose
files plus a `jackson_user` upgrade note in `docs/operations/deployment.md`,
written after a pre-v0.4.57 Postgres volume on the dev host left Jackson in a
27-hour per-second retry loop that wrote 4.5 GB of unrotated json-file logs.

## Findings and disposition

Three experts, 18 findings, 3 perspective convergences. Every Critical/Major is
fixed in `review(1)`; the two open items are recorded below with reasons.

| ID | Severity | Finding | Disposition |
|----|----------|---------|-------------|
| F1 | Critical | Verification `psql -h 127.0.0.1` runs inside the `db` container, where the postgres image's `host all all 127.0.0.1/32 trust` line precedes the scram rule — the command returns the documented output with a deliberately wrong password | Fixed — all four checks now use `-h db`, the bridge path Jackson itself takes |
| S1 | Major | `CREATE ROLE ... PASSWORD :'jackson_password'` reaches the server log verbatim under the stock `log_min_error_statement=error` on any statement failure, and unconditionally under `log_statement=ddl` — into a log this diff makes persistent | Fixed — attributes converge with no `PASSWORD` clause; the password is set with `\password`, which computes the SCRAM verifier client-side |
| S2 / F2 | Major (2 experts) | Repair was create-only (`\if :should_create`), so the "role exists, password or LOGIN out of sync" branch — which `01-create-jackson-db.sql`'s NOLOGIN `\else` branch actually produces — was a no-op; the doc posed both hypotheses and answered one | Fixed — `IF NOT EXISTS` create plus an unconditional `ALTER ROLE`, matching `bootstrap-rds-roles.mjs:201-206`, plus a `RAISE EXCEPTION` refusing to hand database ownership to a role still carrying elevated attributes |
| T2 | Major | Only stated expected output was a denial that a partially-executed run also produces; allow path had no assertion, no pre-count, no ready signal | Fixed — pre-count `N`, an ownership assertion over tables+sequences (not one table), a data-preservation check against `N`, a relabelled deny check, and a post-restart health/log check |
| F3 / S3 | Major (2 experts) | The `20m x 5` rationale was false in both directions: `auditLogger` is gated on `AUDIT_LOG_FORWARD`, which only the overlay that moves `app` off json-file sets, and the two compose workers emit `deadLetterLogger`, not the audit line | Fixed — comment rewritten against what is actually on each stream, naming the one sole-record path (`tenant_not_found`, `src/lib/audit/audit.ts:259-264`) |
| F4 | Major | "Ship those lines off-host with docker-compose.logging.yml" — the overlay defines no worker services, and `fluent-bit.conf`'s `Regex _logType ^(audit\|app)$` drops `audit-dead-letter`, the record `audit-logger.ts:94` designates for external alerting | Claim withdrawn, filter unchanged. The compose comment now states that `fluent-bit.conf` drops `audit-dead-letter` rather than offering the overlay as a way to retain those records. Widening the filter was tried and abandoned — see "Withdrawn" below. The finding itself stands open: there is still no off-host path for a dead-letter record |
| F5 / S4 / T1 | Major (3 experts) | Nothing enforced the cap; the next service added to any overlay silently reverts to unbounded | Fixed — `scripts/checks/check-compose-log-caps.mjs` + RT7 self-test, wired into `scripts/pre-pr.sh` |
| T4 / F8 | Major (2 experts) | CI `env` paths-filter enumerated 4 of the 5 compose files `check-env-docs.ts` globs, so `docker-compose.workers.yml` changes never triggered `env-drift-check` | Fixed — replaced the enumeration with `docker-compose*.yml`, the same pattern the gate scans by |
| T6 | Minor | New section dropped the source procedure's DESTRUCTIVE label and maintenance-window precondition; `ALTER TABLE ... OWNER TO` takes `ACCESS EXCLUSIVE` against a live writer | Fixed — procedure now stops Jackson first and says why |
| F6 | Minor | "a health check that has no timeout hangs instead of failing" is untrue of this stack (`timeout: 10s`) | Fixed — restated with the signals this stack produces; the hang applies to an external probe without a timeout |
| T5 | Minor | Doc SQL was a third twin of the initdb script and had dropped its `\if :{?jackson_password}` guard | Fixed by S1's restructure — the password no longer passes through SQL, and the shell step refuses by name when the variable is unset |
| Seed 1 | — | Ollama: `logging: *default-logging` added to `app` in `docker-compose.logging.yml` | Rejected — the anchor is on `fluent-bit` (line 53); the seed read the hunk header offset. `docker compose config` confirms `app` keeps fluentd |
| Seed 2 | — | Ollama: ownership loop misses functions/extensions | Rejected — measured: 0 functions, 0 non-plpgsql extensions, 0 materialized views in the live `jackson` database; `plpgsql` is pinned to the bootstrap superuser and cannot be reassigned |

### Verified by execution, not by reading

- F1's three axes on the live stack: wrong password over `127.0.0.1` → `1`
  (vacuous); wrong password over `-h db` → `password authentication failed`;
  correct password over `-h db` → row count; `-d passwd_sso` → `permission
  denied for database`.
- S1's replacement: a throwaway `tmp_pwprobe` role took its password through
  `\password` fed on stdin, stored a `SCRAM-SHA-256` verifier, authenticated
  over `-h db`, and left zero cleartext occurrences in the container log. Role
  dropped afterwards.
- The new gate's red side: an uncapped service, a broken alias
  (`PARSE_FAILED`, not a green "0 uncapped"), and an empty directory
  (`NO_COMPOSE_FILES`) each exit non-zero.

## Open items (not fixed, with reasons)

### F7 [Minor] — `mailpit` is the only override service without `networks: internal`

Raised in round 1 as an open product decision. It was fixed, then re-opened
twice — joining `internal` exposed mailpit's unauthenticated UI and REST API to
every other dev container, and the version it was subsequently pinned to carried
a WebSocket origin-check CVE. All of that was withdrawn along with the rest of
the work below, so the config is back to what `main` had: mailpit on the implicit
default network, unpinned.

The original question is still unanswered and still latent: if magic-link email
from the *containerized* app is a supported dev path, mailpit needs
`networks: [internal]` or a dedicated one; if it is only ever reached from the
host through the published `127.0.0.1:1025`, the current config is correct and a
comment saying so is the whole fix. Nothing in the repo sets `SMTP_HOST=mailpit`,
so today it is the second.

### Pre-existing failure on `main` — fixed on a separate branch

`src/__tests__/checks/crypto-auth-deps-manifest.test.ts` failed with
`unregistered imports in extension: vitest`. Reproduced on pristine `main`
(`0d4daaf29`) in a separate worktree, with none of this branch's changes
applied. Root cause: the scan's walker excluded `*.test.ts` by filename but not
the `__tests__` directory, so the shared mock #786 added was read as shipped
code.

Fixed on `fix/crypto-manifest-scan-excludes-test-helpers` rather than here —
bundling an unrelated scanner fix into a log-rotation PR hides it. That branch
must merge first, or this one's CI stays red for a reason it did not cause.

## Scope, and what was withdrawn

This branch carries the container log caps, the gate that keeps them on, the CI
paths-filter fix, and the `jackson_user` upgrade runbook. Nothing else.

Rounds 2, 3 and 4 produced roughly 40 further findings and **none** were against
those files. Every one landed on material added later, all of it downstream of a
single decision: round 1's F4 said the compose comment claimed the logging
overlay could retain dead-letter records when its filter drops them, and the fix
chosen was to widen the filter rather than withdraw the claim. That one line
opened the question of what those records contain, which pulled in the pino
serializer chain, error summarisation, the app logger's redaction paths, and —
through the same overlay — mailpit's network and image pin.

Four review rounds later that work had not converged: each round found holes in
the previous round's fix, and each fix added machinery that produced the next
round's findings. It was discarded rather than continued, because none of it was
needed for the problem this branch exists to solve. Recoverable from reflog at
`51135b1c6` if it is ever wanted.

Two unrelated fixes went with it and may be worth re-landing on their own:
`scripts/pre-pr.sh` deletes failing steps' logs at EXIT and anchors its failure
context below vitest's shuffle-seed line, so a flaky run is irreproducible by the
time anyone looks; and `extension/vitest.config.ts` inherits a 5s test timeout
against the root suite's 10s while sharing an unthrottled pre-pr batch with it.

The lesson worth keeping: when a review finds a comment claiming more than the
code does, withdrawing the claim and widening the implementation are not
equivalent options. The first is bounded.

## Recurring Issue Check

Rules fired and resolved: R2 (accepted — Compose anchors cannot cross files;
mitigated by the new gate), R3/R42 (member set derived by rendering all six
documented compose invocations — 23 service blocks across five files, 15
distinct names, all covered), R14 (S2's
elevated-attribute refusal), R16/R33 (T4's CI filter), R29 (F1/F3/F6 — every
doc claim re-verified by execution), R41/R49 (F3/F4 — claims narrowed to what
the implementation does), R50 (F1/T2 — verification that could not fail), RT7
(F5 — gate authored and red-proven), RT8/RT10 (T2 — deny-side-only assertion),
RT9 (T5), R31 (T6).

Not fired: RS1-RS3, RS5, RS6, R36, R53, RT1, RT3-RT6, RT11.

## Environment Verification Report

No Phase 1 constraints were declared (standalone Phase 3). All verification ran
`verified-local` against the running dev stack and throwaway containers; the
commands are recorded inline above and in the finding bodies.
