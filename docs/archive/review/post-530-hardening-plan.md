# Plan: post-530-hardening

Branch: `fix/post-530-hardening`
Worktree: `passwd-sso-ord`

## Project context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL 16 + RLS + Docker Compose + Sentry).
- Test infrastructure: unit (vitest) + real-DB integration (`npm run test:integration`, role-separation/RLS smoke) + CI (`scripts/pre-pr.sh` 32 gates incl. `check:env-docs`).
- Verification environment constraints:
  - **VE1**: HA Sentinel live behavior (C1) is config-render verifiable only (`docker compose -f docker-compose.yml -f docker-compose.ha.yml config`); live failover is operator manual-test.
  - **VE2**: C3's `REVOKE CONNECT` effect on a FRESH volume is exercised by the CI integration job (initdb + migrate on a clean DB + role-separation smoke); on the shared dev volume it is verified by running `migrate deploy` + reconnecting as `passwd_app` (must still connect) and confirming `jackson_user` cannot connect to `passwd_sso`.

## Objective

Five Low/Info post-`#530` hardening items (NOT the DCR per-IP cap — that is SC7, a schema-change feature deferred to a separate PR-B). No application-logic behavior change; one permission migration (C3); Sentry-scrubber coverage extension (C2); compose + env-tooling tidies (C1/C4); a CodeQL unused-import cleanup (C5).

## Contracts

### C1 — HA app service sets REDIS_PASSWORD explicitly

- File: `docker-compose.ha.yml` (app service `environment:`, currently lines 75-88).
- Root cause: `src/lib/redis.ts:30` reads `process.env.REDIS_PASSWORD` for the Sentinel data-node `password`, but the ha.yml app `environment:` only sets `REDIS_URL` (embedded) + `REDIS_SENTINEL_PASSWORD`; the bare `REDIS_PASSWORD` reaches the app only via `env_file: .env` inheritance. Fail-closed (the `REDIS_URL` `:?` guard already requires it), but the data-node-auth dependency is implicit.
- Signature: add `- REDIS_PASSWORD=${REDIS_PASSWORD:?REDIS_PASSWORD is required}` to the ha.yml app `environment:` list — making the Sentinel data-node password dependency explicit and render-validated, independent of env_file injection.
- Invariants: (app-enforced) the HA app container's `REDIS_PASSWORD` is set explicitly, not only via env_file inheritance.
- Acceptance: `docker compose -f docker-compose.yml -f docker-compose.ha.yml config` renders the app env with `REDIS_PASSWORD`; renders cleanly with the var set. No app-code change.

### C2 — Sentry scrubber covers span.description and event.transaction

- Files: `src/lib/security/sentry-scrub.ts` (`scrubSentryEvent`), `sentry-scrub.test.ts`.
- Root cause: `scrubSentryEvent` applies `redactCapabilityPaths` to `event.message`, `exception.values[].value`, span `data` URL keys, request URL/headers/breadcrumbs — but NOT to the top-level `event.transaction` (transaction name string) nor per-span `span.description` (span name). App Router parameterizes route-pattern transaction names, but an outbound-fetch span description or a manually-named transaction could carry a concrete capability URL (`/s/<token>`).
- Signature: in `scrubSentryEvent`, (a) if `typeof e.transaction === "string"`, set `e.transaction = redactCapabilityPaths(e.transaction)`; (b) in the existing `e.spans` loop, if `typeof span.description === "string"`, set `span.description = redactCapabilityPaths(span.description)`; (c) **(S1) `contexts.trace.description`** — the ROOT span's name lives here (not in `spans[]`), so in the existing `contexts.trace` handling, if `typeof trace.description === "string"`, set `trace.description = redactCapabilityPaths(trace.description)` (`trace.op` is categorical — leave it). Use `redactCapabilityPaths` (path-segment redaction only — preserves the rest of the name), NOT `sanitizeUrl` (which strips query/fragment — wrong for free-text names).
- Invariants: (app-enforced) every Sentry event field that can carry a capability path — including transaction name, per-span `description`, and the root-span `contexts.trace.description` — passes `redactCapabilityPaths`.
- Forbidden patterns: none grep-able; enforced by test.
- Acceptance: new fixtures in the C11 describe — `event.transaction` carrying `/s/<token>` is redacted; a span with `description` carrying `/dashboard/teams/invite/<token>` is redacted; `contexts.trace.description` carrying `/s/<token>` is redacted; each fixture must FAIL against the pre-change scrubber (red-green by reverting the lines). One assert distinguishes `redactCapabilityPaths` from `sanitizeUrl` by including a query/suffix in the name (e.g. `GET /s/<token> (cached)`) and asserting the suffix survives while the token is redacted (T3). vitest green.

### C3 — REVOKE CONNECT on the app database FROM PUBLIC (connection-level Jackson isolation)

- Files: a NEW Prisma migration `prisma/migrations/<ts>_revoke_public_connect_on_app_db/migration.sql` (create via `npx prisma migrate dev --create-only --name revoke_public_connect_on_app_db`, then hand-write the SQL; do NOT let it diff the schema).
- Root cause: `jackson_user` (the dedicated Jackson role from #530) can still CONNECT to `passwd_sso` via the PUBLIC default (it has no table GRANTs, so no data access — but connection-level isolation is one notch tighter). All legitimate app/worker roles already have EXPLICIT `GRANT CONNECT` (verified: `02-create-app-role.sql:27,63,107` for passwd_app/outbox/anchor; migration `20260428170853:10` for dcr_cleanup; `passwd_user` is `POSTGRES_USER` superuser, exempt). So a `REVOKE CONNECT FROM PUBLIC` blocks exactly `jackson_user` and any other non-explicitly-granted role — the desired effect — without breaking the legitimate roles.
- Signature (migration SQL, mirroring the existing `DO $$ … format('… %I …', current_database())` pattern used by the GRANT CONNECT migrations): `DO $$ BEGIN EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database()); END $$;`. Runs as `passwd_user` (superuser/owner) via `migrate deploy`; applies to BOTH fresh installs (migrate runs after initdb) and existing volumes (migrate deploy).
- Invariants: (schema-enforced) only roles with an explicit `GRANT CONNECT` (or superuser) can connect to `passwd_sso`; `jackson_user` cannot.
- Automated verification (T1/T2 — the contract's invariant MUST be machine-asserted, not manual-only; note CI's integration DB has NO `jackson_user` because initdb is not mounted there, so the test must not depend on that role existing): add a db-integration test `src/__tests__/db-integration/revoke-public-connect.integration.test.ts` that, as superuser against the migrated DB:
  1. creates a throwaway no-grant probe role — **idempotent + leak-safe (T5): `DROP ROLE IF EXISTS revoke_probe_role` first, then `CREATE ROLE revoke_probe_role NOLOGIN`, and put the `DROP ROLE` in a `try/finally` so a failed assertion does not leave the role behind on a shared/local DB** — asserts `has_database_privilege('revoke_probe_role', current_database(), 'CONNECT')` is **FALSE** (proves PUBLIC connect is revoked — a role with no explicit grant cannot connect; `NOLOGIN` does not affect the CONNECT-privilege catalog check), then drops it;
  2. asserts `has_database_privilege` for ALL FOUR legit roles (`passwd_app`, `passwd_outbox_worker`, `passwd_anchor_publisher`, `passwd_dcr_cleanup_worker`) is **TRUE** (the explicit grants survive the REVOKE) — closes T2 structurally without depending on the suite actually connecting as each;
  3. (RT4 both-branches) the false (probe) and true (legit) assertions both run, so a no-op migration or an over-broad REVOKE is caught.
  This runs in the CI integration job (which applies `migrate deploy` to `passwd_test`) and locally. The probe-role mechanism is CI-safe (does not require `jackson_user`).
- Acceptance: `npm run db:migrate` applies cleanly on the dev DB; the new privilege-assertion test passes (probe role FALSE, 4 legit roles TRUE); the full integration suite + RLS role-separation smoke stay green; on the dev volume (where `jackson_user` exists) a manual `psql` connect as `jackson_user` to `passwd_sso` is additionally confirmed refused. CI integration job is the authoritative fresh-DB proof.
- Risk note: connection-permission migration — the privilege-assertion test is the structural guard that no legit role relies on PUBLIC connect; the 4 worker/app roles are explicitly granted (verified), the migrate/superuser role is exempt.

### C4 — .env.example renders REDIS_PASSWORD symmetrically with PASSWD_JACKSON_PASSWORD

- Files: `scripts/env-descriptions.ts` (the `REDIS_PASSWORD` sidecar entry, ~:593-603), `scripts/generate-env-example.ts` (the Zod-path comment-out logic, ~:204), regenerate `.env.example`.
- Root cause: both vars are REQUIRED for any docker-compose deployment (compose `:?` guards), but `.env.example` renders `PASSWD_JACKSON_PASSWORD=` uncommented (allowlist `requiredForConsumer: true`) while `REDIS_PASSWORD` renders `# REDIS_PASSWORD=` commented (Zod-optional path: `emitUncommented = hasZodDefault || isAlwaysRequired`, both false). Onboarding friction — the commented form reads as "optional".
- Signature: add an opt-in flag to the Zod sidecar (e.g. `requiredForCompose: true`) on the `REDIS_PASSWORD` `env-descriptions.ts` entry, and extend `generate-env-example.ts`'s `emitUncommented` to `hasZodDefault || isAlwaysRequired || sidecar.requiredForCompose`. Then `REDIS_PASSWORD` renders uncommented (`REDIS_PASSWORD=`), symmetric with `PASSWD_JACKSON_PASSWORD`, keeping its explanatory NOTE comment. Regenerate `.env.example` via `npm run generate:env-example`.
- Invariants: (app-enforced) compose-required secrets render uncommented in `.env.example`.
- Acceptance: `.env.example` shows `REDIS_PASSWORD=` uncommented (with its NOTE comment retained); `npm run check:env-docs` green (no drift); the sidecar flag is typed and documented. No change to the app's Zod-optional status of `REDIS_PASSWORD` (it remains optional at the schema level; only the example rendering changes). (T4) `scripts/__tests__/generate-env-example.test.mjs` gains an assertion mirroring the existing `requiredForConsumer` precedent (`expect(content).toMatch(/^JACKSON_API_KEY=/m)`): `expect(content).toMatch(/^REDIS_PASSWORD=/m)` AND `expect(content).not.toMatch(/^# ?REDIS_PASSWORD=/m)` AND the NOTE comment is retained — this pins the uncommented rendering so a future generator refactor cannot silently revert it (check:env-docs alone does not catch comment-vs-uncomment).
- Alternative considered (rejected): commenting out `PASSWD_JACKSON_PASSWORD` instead — wrong direction (both are required; uncommenting REDIS_PASSWORD makes the requirement visible).

### C5 — Remove unused `afterEach` import (CodeQL alert 210)

- File: `src/lib/redis.test.ts:1`.
- Root cause: #530 converted this file to `vi.stubEnv` and removed the manual `afterEach` env cleanup, leaving `afterEach` imported but unused → CodeQL `js/unused-local-variable` (note) alert 210 on main.
- Signature: drop `afterEach` from `import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";` → `import { describe, it, expect, vi, beforeEach } from "vitest";`.
- Acceptance: `npm run lint` clean; vitest for redis.test.ts green; the CodeQL alert closes on the next scan.

## Go/No-Go Gate

| ID | Subject                                                  | Status |
|----|----------------------------------------------------------|--------|
| C1 | HA app explicit REDIS_PASSWORD env                       | locked |
| C2 | Sentry scrub span.description + event.transaction        | locked |
| C3 | REVOKE CONNECT on app DB FROM PUBLIC (migration)         | locked |
| C4 | .env.example REDIS_PASSWORD symmetric rendering          | locked |
| C5 | Remove unused afterEach import (CodeQL 210)              | locked |

## Testing strategy

- Unit: C2 (2 red-able scrubber fixtures), C5 (lint). C1/C3/C4 are not vitest-testable (compose/SQL-permission/generator) — covered by render check / migration apply + integration + check:env-docs.
- db-integration (`npm run test:integration`, real Postgres): C3 — run the migration on the dev DB, confirm the full integration suite + RLS role-separation smoke stay green (they connect as explicitly-granted roles), and manually confirm `jackson_user` connect is refused. CI integration job is the authoritative fresh-DB proof.
- Gates: `npx vitest run`, `npx next build`, `npm run lint`, `npm run check:env-docs`, `docker compose -f docker-compose.yml -f docker-compose.ha.yml config`, `scripts/pre-pr.sh`, `npm run test:integration`.
- R35: C3 adds a Prisma migration (deployment-relevant); a `*-manual-test.md` is NOT required because the migration is a single REVOKE with no data change and its verification (passwd_app reconnect / jackson_user refusal / smoke green) is captured in the C3 acceptance and run locally + in CI. (If a reviewer deems the permission change Tier-1, a short manual-test note will be added.)

## Considerations & constraints

- C3 is the only item with a migration; it is a permission REVOKE, not a table/column change — no `prisma migrate dev` schema diff (use `--create-only` + hand-written SQL).
- C4 changes only the example RENDERING, not the app's Zod-optional treatment of `REDIS_PASSWORD`.
- SC1: DCR per-IP/per-window unclaimed cap (the #530 review's item 4, = SC7) is OUT of scope — it needs persisting the registrant IP (schema change) and its own triangulate cycle (PR-B).
- SC2: `check:env-docs` does not regenerate-and-byte-compare `.env.example` (a forgotten `generate:env-example` after a sidecar change would pass the drift check) — pre-existing tooling gap, not introduced here; recorded as `TODO(post-530-hardening): env-docs regenerate-compare`. C4's T4 test partially mitigates by pinning the REDIS_PASSWORD rendering.

## User operation scenarios

1. HA operator brings up the stack → app container has `REDIS_PASSWORD` explicitly, Sentinel data-node auth wired without relying on env_file ordering.
2. A Sentry trace for an outbound fetch to `/s/<token>` → transaction/span names are redacted, not just the request URL.
3. A new dev clones and `cat .env.example` → `REDIS_PASSWORD=` reads as required (uncommented), like `PASSWD_JACKSON_PASSWORD=`.
4. `jackson_user` credential leak → cannot even connect to `passwd_sso` (connection refused), not just table-denied.
