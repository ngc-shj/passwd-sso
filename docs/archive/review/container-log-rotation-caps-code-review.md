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
| F4 | Major | "Ship those lines off-host with docker-compose.logging.yml" — the overlay defines no worker services, and `fluent-bit.conf`'s `Regex _logType ^(audit\|app)$` drops `audit-dead-letter`, the record `audit-logger.ts:94` designates for external alerting | Claim withdrawn here: the compose comment now states the filter drops those records rather than offering the overlay as a way to retain them. Widening the filter is a change to what is forwarded off-host, so it went to the audit branch with the rest of that work (see "Scope" below) |
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

### F7 [Minor] — `mailpit` is the only override service without `networks: internal` — moved out of this branch

Raised in round 1 as an open product decision. The user chose to add it, so
Raised in round 1, fixed, then re-opened twice by later rounds — first because
joining `internal` exposed mailpit's unauthenticated API to every dev container,
then because the version it was pinned to carried a WebSocket-origin CVE. That
belongs with the audit/forwarding work, not with a log-rotation change; it moved
there. Round 2 (SEC-R2-4) flagged the trade — mailpit's UI and REST API are
unauthenticated, so anything on `internal` can read captured mail — which is
recorded in the compose comment rather than closed with `MP_UI_AUTH`, that being
a change to how developers reach the UI.

## Open items (not fixed, with reasons)

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

## Scope

This branch carries the container log caps, the gate that keeps them on, the CI
paths-filter fix, and the `jackson_user` upgrade runbook. Rounds 2 and 3
produced 40 further findings, and **none** were against those — every one landed
on material added later: the dead-letter/fluent-bit forwarding work, the mailpit
network and pin, and `scripts/pre-pr.sh`'s failure-log handling. That material
is on a separate branch with its own review history, because it has not
converged and this has: no finding since round 2 has touched the files in this
diff.

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
