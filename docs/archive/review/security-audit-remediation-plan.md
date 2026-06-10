# Plan: security-audit-remediation

Branch: `fix/security-audit-remediation`
Worktree: `passwd-sso-ord`

## Project context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL 16 + Redis, Docker Compose deployment)
- Test infrastructure: unit + integration + E2E + CI/CD (vitest, real-DB integration suite, Playwright E2E, GitHub Actions; `scripts/pre-pr.sh` aggregate gate)
- Verification environment constraints:
  - **VE1**: SAML login E2E via Jackson requires a real IdP — not reproducible locally. Jackson verification is limited to container boot + DB connectivity as the dedicated role (`docker compose logs jackson`).
  - **VE2**: HA overlay (`docker-compose.ha.yml`, Redis Sentinel) is not part of the default dev bring-up. Verification is config-review + optional local `docker compose -f docker-compose.yml -f docker-compose.ha.yml config` rendering check; live Sentinel failover testing is out of local scope.
  - **VE3**: `ps`-visibility of script secrets requires a second shell during script execution — manual-test step, not automatable in vitest.

## Objective

Remediate the short-term + mid-term findings from the 2026-06-10 whole-codebase security audit (6 Medium, 7 Low) in a single PR, without changing the E2EE design or any cryptographic format. Long-term design items are explicitly out of scope (see Scope contract).

## Requirements

Functional: no user-visible behavior change except (a) locked-out users get the same lockout response from `/api/vault/unlock/data` as from `/api/vault/unlock`, (b) ownership-mismatch on 9 handlers returns 404 instead of 403, (c) magic-link tokens expire after 15 minutes instead of 24 hours, (d) OAuth consent rejects claiming a DCR client name owned by another user.

Non-functional: fresh `docker compose up` must succeed with the new required env vars; existing dev volumes must have a documented upgrade path; `npm run check:env-docs` must stay green; all token validation changes must not add a second DB roundtrip where an `include` on the existing query suffices.

## Technical approach

No Prisma schema changes, no migrations (C6 is deliberately designed without a new column — see C6 rationale). Changes fall into three groups: Compose/infra hardening (C1–C3), auth/route hardening (C4–C9, C13), operational hygiene (C10–C12). New env vars (`PASSWD_JACKSON_PASSWORD`, `REDIS_PASSWORD`) follow the existing "External / Build-time" operator-var pattern (like `PASSWD_OUTBOX_WORKER_PASSWORD`): NOT in the Zod schema's required app section, prompted by `npm run init:env`, listed in `.env.example`, wired through compose. Exception: `REDIS_PASSWORD` also gets an optional Zod field because the app needs it for Sentinel-mode data-node auth (C2).

## Contracts

### C1 — Jackson connects with a dedicated non-superuser DB role

- Files: `infra/postgres/initdb/01-create-jackson-db.sql`, `docker-compose.yml` (jackson service `DB_URL`, db service env passthrough), `scripts/env-allowlist.ts` (new `PASSWD_JACKSON_PASSWORD` entry: includeInExample/secret/requiredForConsumer, consumers = docker-compose.yml + initdb script — follow the `PASSWD_OUTBOX_WORKER_PASSWORD` precedent at `env-allowlist.ts:141`), `.env.example` via `npm run generate:env-example` (generated artifact — never hand-edited; `init:env` prompts are driven by the same allowlist entry), upgrade note in the manual-test artifact.
- Signature (SQL, initdb): extend `01-create-jackson-db.sql` to `CREATE ROLE jackson_user LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'jackson_password';` (password via `\getenv` from `PASSWD_JACKSON_PASSWORD`, same pattern as `02-create-app-role.sql`) and `CREATE DATABASE jackson OWNER jackson_user;`.
- Compose: `DB_URL: postgresql://jackson_user:${PASSWD_JACKSON_PASSWORD:?PASSWD_JACKSON_PASSWORD is required}@db:5432/jackson`; `db` service gets `PASSWD_JACKSON_PASSWORD` in `environment`.
- Invariants:
  - (app-enforced) Jackson never connects as `passwd_user`. Schema-enforced equivalent (REVOKE LOGIN on passwd_user from jackson's network) is not expressible in compose; app-enforced is the available form.
  - (schema-enforced) `jackson_user` is `NOSUPERUSER NOBYPASSRLS` and owns only the `jackson` database — cannot read `passwd_sso` tables.
- Forbidden patterns:
  - pattern: `passwd_user:.*@db:5432/jackson` — reason: superuser connection string for Jackson must not survive anywhere.
- Acceptance: fresh `docker compose up` boots Jackson healthy (its healthcheck passes); `psql` as `jackson_user` cannot `\c passwd_sso` table data; `npm run check:env-docs` green.
- Existing-volume upgrade path (manual-test artifact, full Pre-conditions/Steps/Expected/Rollback section — initdb scripts do not run on existing volumes): `REASSIGN OWNED BY passwd_user` is NOT usable — `passwd_user` is the bootstrap superuser (`POSTGRES_USER`, `docker-compose.yml:39`) and PostgreSQL refuses to reassign bootstrap-superuser-owned objects. Documented path for dev volumes: `CREATE ROLE jackson_user LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '...'` then either (a) drop & recreate the jackson DB with `OWNER jackson_user` (Jackson recreates its schema on boot; SAML connection configs must be re-imported — acceptable for dev), or (b) for data preservation, an `ALTER TABLE ... OWNER TO jackson_user` DO-loop inside the jackson DB plus `ALTER DATABASE jackson OWNER TO jackson_user`. The manual-test artifact carries both, marked destructive/operator-only where applicable.

### C2 — Redis requires authentication

- Files: `docker-compose.yml` (redis command + **redis healthcheck** + app `REDIS_URL`), `docker-compose.ha.yml` (**master override command**, replicas ×2, replica healthchecks, sentinel entrypoint, app `REDIS_URL`), `infra/redis/sentinel.conf` (unchanged template OR removed in favor of entrypoint-generated config — decided below), `src/lib/env-schema.ts`, `scripts/env-descriptions.ts` (sidecar entry for the new Zod key), `scripts/env-allowlist.ts` (compose-consumer entry for `REDIS_PASSWORD`), `src/lib/redis.ts` (+ new `src/lib/redis.test.ts`), `.env.example` via `npm run generate:env-example`.
- Signatures:
  - base compose redis: `command: ["redis-server", "--appendonly", "yes", "--requirepass", "${REDIS_PASSWORD:?REDIS_PASSWORD is required}"]`; app env `REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379`.
  - base compose redis healthcheck (currently `["CMD", "redis-cli", "ping"]` at `docker-compose.yml:115` — breaks or goes vacuous under requirepass): the redis service gets `environment: REDISCLI_AUTH: ${REDIS_PASSWORD}` (redis-cli's documented env-var auth — avoids `-a` argv exposure on every probe) and the healthcheck becomes `test: ["CMD-SHELL", "redis-cli ping | grep PONG"]` (grep keeps it fail-closed independent of redis-cli exit-code behavior on NOAUTH).
  - HA overlay — **master**: `docker-compose.ha.yml:25-26` overrides (replaces, not merges) the base command, so the override itself must carry `--requirepass ${REDIS_PASSWORD}` AND `--masterauth ${REDIS_PASSWORD}` (masterauth needed for post-failover rejoin as replica). **Replicas ×2**: same two flags added to their commands; their healthchecks + `REDISCLI_AUTH` env updated like the base. **Sentinel**: the current entrypoint (`cp /etc/sentinel-template.conf /tmp/sentinel.conf && redis-sentinel /tmp/sentinel.conf`, `ha.yml:7-11`) copies a static `:ro` template — `${REDIS_PASSWORD}` written into the template would stay literal. Mechanism — runtime-env expansion, NOT compose render-time interpolation (render-time would bake the real password into the long-lived `/bin/sh` cmdline, world-readable via host `/proc/<pid>/cmdline`; env-var passing is strictly better — `/proc/<pid>/environ` is owner/root-only — and matches this compose file's existing secret practice, e.g. the db service's `PASSWD_*_PASSWORD` envs): sentinel services get `environment: REDIS_PASSWORD: ${REDIS_PASSWORD}` and the entrypoint shell string becomes `cp /etc/sentinel-template.conf /tmp/sentinel.conf && chmod 600 /tmp/sentinel.conf && echo "sentinel auth-pass mymaster $$REDIS_PASSWORD" >> /tmp/sentinel.conf && exec redis-sentinel /tmp/sentinel.conf` — `$$` escapes compose so the container shell expands from env at runtime; `chmod 600` (NOT umask — umask only affects newly created files, the `cp`'d conf inherits 644, and on container restart the leftover conf keeps its old mode regardless of umask) keeps the password-bearing conf non-world-readable including across restarts; `exec` removes the lingering `sh` process. `infra/redis/sentinel.conf` itself stays untouched. Manual-test step: `docker compose exec <sentinel> sh -c 'ls -l /tmp/sentinel.conf && grep auth-pass /tmp/sentinel.conf'` expects mode 600 + real value.
  - `env-schema.ts`: `REDIS_PASSWORD: z.string().optional()` (used by Sentinel-mode client; non-Sentinel embeds in URL) + `scripts/env-descriptions.ts` sidecar entry.
  - `src/lib/redis.ts` `getRedis()`: Sentinel branch passes `password: env.REDIS_PASSWORD` (data-node auth) in addition to the existing `sentinelPassword`.
  - Password charset: `REDIS_PASSWORD` is embedded in `REDIS_URL` and parsed by `new Redis(url)` — `init:env` must generate a URL-safe (hex) value, and the allowlist/description entry documents "URL-safe characters only" for operators setting it manually.
- Invariants: (app-enforced) no compose file — base OR HA overlay, after override merging — starts a Redis node without `--requirepass`; Sentinel client authenticates to data nodes; every replica/old-master can re-auth to a new master (`--masterauth` everywhere).
- Forbidden patterns:
  - pattern: `redis://redis:6379` (without `:<password>@`) — reason: unauthenticated Redis URL.
  - pattern: `"redis-server"` command array lacking `--requirepass` in any compose file — reason: override replacement reintroduces unauthenticated nodes.
- Acceptance: `docker compose up` → app `/api/health/ready` returns 200 (Redis ping OK, healthcheck green); `redis-cli -h 127.0.0.1 ping` without auth returns `NOAUTH`; `docker compose -f docker-compose.yml -f docker-compose.ha.yml config` renders (a) `--requirepass` on master AND both replicas, (b) the sentinel entrypoint containing the literal `$REDIS_PASSWORD` (runtime expansion) WITH the env wiring present — the real-value-in-`/tmp/sentinel.conf` check is a manual-test step (`docker compose exec <sentinel> grep auth-pass /tmp/sentinel.conf`, VE2). New `src/lib/redis.test.ts` mocks `ioredis` (default import; factory returns `{ default: vi.fn() }` with `on`/`connect` stubs) and asserts the Sentinel branch passes `password` and the non-Sentinel branch does not — each test case resets the `globalForRedis.redisClient` singleton (or uses `vi.resetModules()` + dynamic import) so the second case doesn't vacuously hit the cache. vitest suite green. Both `REDIS_URL` sites (`docker-compose.yml:23`, `docker-compose.ha.yml:68`) updated — the only two in the repo; workers do not set `REDIS_URL`.
- Consumer-flow walkthrough (env shape): Consumer `getRedis()` (`src/lib/redis.ts`) reads `{ REDIS_URL, REDIS_SENTINEL*, REDIS_PASSWORD }` and uses `REDIS_PASSWORD` only in the Sentinel branch; consumer `docker-compose.yml app service` reads `REDIS_URL` with embedded password. No other consumer reads Redis config (workers reuse `getRedis()`).

### C3 — Dev/logging port bindings restricted to loopback

- Files: `docker-compose.override.yml` (db 5432, jackson 5225, redis 6379, mailpit 1025/8025, minio 9000/9001), `docker-compose.logging.yml` (fluent-bit 24224 tcp+udp).
- Signature: every `ports:` entry becomes `"127.0.0.1:<host>:<container>"` form.
- Invariants: (app-enforced) no dev/logging compose file publishes a port on 0.0.0.0.
- Forbidden patterns:
  - pattern: `^\s+- "(?!127\.0\.0\.1:)[0-9]+:[0-9]+(/udp)?"$` in `docker-compose.override.yml` / `docker-compose.logging.yml` — reason: all-interface binding on dev-only services.
- Acceptance: `docker compose config` renders `127.0.0.1` host IPs; dev flows (Prisma Studio via localhost:5432, mailpit UI :8025) still work. Note: `app` `"3000:3000"` in the base compose is the intentionally published service port and stays as-is; `docker-compose.ha.yml` publishes no redis/sentinel ports (verified).

### C4 — `/api/vault/unlock/data` enforces account lockout

- Files: `src/app/api/vault/unlock/data/route.ts` (+ `route.test.ts`), `src/lib/vault/vault-context.tsx`, `src/lib/vault/vault-context.test.tsx` (coverage EXISTS — `unlockWithStoredPrf` describe at :353-559 pins the exact `!dataRes.ok → return false` branch this contract changes; the update is unconditional, not "if covered").
- Client implementation shape: the three call sites share one extracted helper (parse non-OK unlock-data envelope → throw `VaultUnlockError(ACCOUNT_LOCKED, lockedUntil)` when applicable) — the helper is unit-tested once, and ALL THREE call sites get an ACCOUNT_LOCKED wiring test. This is possible without any WebAuthn mock because in every flow the throw fires on the `!dataRes.ok` branch BEFORE any passkey ceremony: `unlock()` — fetchApi-mocked, same shape as the existing `notifyUnlockFailure` tests; `unlockWithPasskey()` — fetch-mocked locked envelope on VAULT_UNLOCK_DATA; `startPasskeyAuthentication` (`vault-context.tsx:545`) is never reached, so the file's no-webauthn-mock convention is not violated; `unlockWithStoredPrf()` — wiring test additionally follows the file's per-exit-path zeroization convention (the new throw path asserts `prfOutput` is zeroized; zeroization N/A for the passkey flow — the PRF ceremony runs after the data fetch, so no `prfOutput` exists on its throw path). The manual-test locked-out scenario still includes the passkey unlock flow (UI surface).
- Signature: after `checkAuth` succeeds, call `checkLockout(userId)` (`@/lib/auth/policy/account-lockout`); when `locked`, return the same error response that `/api/vault/unlock` returns for the locked state (same status code + error code + `lockedUntil` semantics — mirror `src/app/api/vault/unlock/route.ts:46` handling verbatim, including any audit/log emission that route performs on the locked branch). Do NOT call `recordFailure` (no passphrase attempt occurs on this route).
- Invariants: (app-enforced) every route that returns wrapped vault key material checks lockout first. Sibling check (R34): `/api/vault/unlock` already does; rotate-key/data and recovery flows are reviewed in Phase 3 for the same class.
- Forbidden patterns: none grep-able beyond acceptance tests.
- Test-mock note: `unlock/data/route.test.ts` currently mocks only `@/lib/tenant-rls`; adding `checkLockout` (which itself calls `withBypassRls`) requires adding the same `vi.mock("@/lib/auth/policy/account-lockout", ...)` used by `unlock/route.test.ts:43` — otherwise existing tests TypeError. The "no key-material lookup when locked" assertion runs with `checkLockout` mocked (it performs its own user lookup; unmocked it poisons the assertion).
- Acceptance: new unit test — locked user receives the lockout response and the handler returns before any `prisma.user.findUnique` for key material; unlocked user path unchanged.
- Consumer-flow walkthrough (corrected after enumerating ALL `API_PATH.VAULT_UNLOCK_DATA` fetch sites in `vault-context.tsx` — there are THREE: `unlock()` :390, `unlockWithPasskey()` :518, `unlockWithStoredPrf()` :693): the web client currently swallows non-401 errors from unlock/data as a generic `return false` — the lockout envelope would NOT reach the existing `ACCOUNT_LOCKED` UI branch (`vault-lock-screen.tsx:91`) without a client change. Therefore C4 includes: in all THREE call sites, parse the non-OK envelope and, when `error === ACCOUNT_LOCKED`, throw the same `VaultUnlockError(ACCOUNT_LOCKED, lockedUntil)` the POST path throws (the `vault-lock-screen.tsx:172-182` catch already renders `formatLockedUntil` for it) — preserving the existing lockout UI in manual, passkey, and single-ceremony PRF unlock flows (scenario 3). Consumer extension (`EXTENSION_TOKEN_SCOPE.VAULT_UNLOCK_DATA` callers) and iOS vault-unlock treat non-2xx as unlock failure — no crash, acceptable UX (token holder is the locked user themselves; no cross-principal oracle).

### C5 — Magic-link token TTL 15 min + fail-closed email rate limit

- Files: `src/auth.config.ts`, `src/lib/email/templates/magic-link.ts` (+ `magic-link.test.ts`), `src/auth.config.test.ts`.
- Signatures:
  - Nodemailer provider gains `maxAge: 15 * SEC_PER_MINUTE` (verified against `@auth/core` `send-token.js`: `(provider.maxAge ?? 86400) * 1000` — seconds; import from `@/lib/constants/time`, never a bare number).
  - `magicLinkEmailLimiter` gains `failClosedOnRedisError: true`.
  - Email template propagation (R27 — TTL is a security-policy boundary): `magic-link.ts:9,13,21,25` currently hardcodes "valid for 24 hours" / 「24時間有効」 and `magic-link.test.ts:40` pins that stale text. The validity duration is interpolated from the SAME constant (`15 * SEC_PER_MINUTE`, rendered as minutes) — not re-hardcoded; tests assert via the constant import (RT3).
- Invariants: (app-enforced) outbound-email rate limiter fails closed (Redis outage ⇒ no email sent, silently — consistent with the existing enumeration-safe silent drop); (app-enforced) email copy and actual token TTL derive from one constant.
- Forbidden patterns:
  - pattern: `maxAge: 900` or any bare numeric TTL here — reason: time constants must derive from `SEC_PER_*`/`MS_PER_*` base constants.
  - pattern: `24時間有効` / `24 hours` in `magic-link.ts` — reason: stale TTL claim.
- Acceptance: `auth.config.test.ts` asserts provider `maxAge === 15 * SEC_PER_MINUTE`; limiter options include `failClosedOnRedisError: true`; template tests assert the interpolated duration.

### C6 — DCR unclaimed-client cap is self-healing and short-lived

- Files: `src/app/api/mcp/register/route.ts` (incl. the 503 `error_description` at `route.ts:170-172` — "ensure dcr-cleanup-worker is running" becomes misleading once the cap is self-healing; reword to "too many unclaimed registrations"), `src/lib/constants/auth/mcp.ts`, `src/app/api/mcp/register/route.test.ts` (existing `$transaction` mocks gain `deleteMany` or they crash), one new db-integration test, docs propagation: `CLAUDE.md:129` and `docs/architecture/machine-identity.md:173,186` ("24h" → "1 h").
- Rationale: the global cap (100) shared across all tenants is exhaustible from a handful of IPs over hours, and recovery depends on the `dcr-cleanup-worker` running. A per-IP cap would require persisting the registrant IP (schema change) — rejected for this PR. Instead: make the cap self-healing and shrink the exposure window.
- Signatures:
  - Inside the existing registration transaction, BEFORE the `count`: `await tx.mcpClient.deleteMany({ where: { isDcr: true, tenantId: null, dcrExpiresAt: { lt: new Date() } } })` (lazy cleanup — removes the hard dependency on the cleanup worker for cap recovery).
  - `MCP_DCR_UNCLAIMED_EXPIRY_SEC`: `SEC_PER_DAY` → `SEC_PER_HOUR` (claim/consent happens within minutes in every supported flow; 1 h is generous).
- Invariants: (app-enforced) an expired unclaimed client can never block a new registration. (app-enforced) cap check and insert remain in one transaction (existing TOCTOU posture preserved).
- Forbidden patterns:
  - pattern: `MCP_DCR_UNCLAIMED_EXPIRY_SEC = SEC_PER_DAY` — reason: 24 h exposure window is the finding.
- Acceptance: unit tests assert (1) `deleteMany` is called with `{ isDcr: true, tenantId: null, dcrExpiresAt: { lt: <Date> } }` and (2) BEFORE `count` (`mock.invocationCallOrder`) — a mocked count-value test alone is vacuous (RT5). One db-integration test covers the write-read essence: seed 100 expired unclaimed rows → register returns 201 and expired rows are gone; seed 100 fresh rows → 503 (infra precedent: `src/__tests__/db-integration/dcr-cleanup-worker-sweep.integration.test.ts`). Residual risk documented: a sustained ≥100-fresh-rows/h multi-IP attacker can still exhaust the cap for up to 1 h — recorded as accepted residual with the per-IP-cap schema change tracked in SC7.
- Note: `dcr-cleanup-worker` remains in place (it also handles claimed-client hygiene); this contract only removes the cap's dependency on it.

### C7 — Consent claims may delete only the requester's own DCR client

- File: `src/app/api/mcp/authorize/consent/route.ts` (+ tests).
- Signature: the pre-claim `findFirst` where-clause becomes `{ tenantId: userTenantId, name: clientName, isDcr: true, createdById: session.user.id }`. Additionally, a second `findFirst` WITHOUT `createdById` detects a foreign-owned name collision (the `@@unique([tenantId, name])` constraint would make the claim fail at write time): when found and not owned by the requester, the consent request is rejected with the existing consent-error path (no deletion, no claim).
- Invariants: (schema-enforced) `@@unique([tenantId, name])` still backstops races — a concurrent foreign claim surfaces as a unique violation, which the route must map to the same consent error, not a 500.
- Forbidden patterns:
  - pattern: `where: { tenantId: userTenantId, name: clientName, isDcr: true }` (exact old clause) — reason: ownerless delete is the finding.
- Acceptance: unit tests — (a) user B consenting with a client name matching user A's active DCR client does NOT delete A's client and receives the consent error; (b) user A re-registering their own client name still replaces their own row (regression guard for the Claude Code re-registration flow); (c) unique-violation race path maps to consent error.
- Consumer-flow walkthrough: Consumer = MCP client (Claude Code) reads the OAuth error redirect/page from the consent error path; it already handles consent denial. Consumer = consent UI reads the error message key — reuse an existing consent error message (no new i18n key unless none fits; if a new key is needed, both `messages/en.json` and `messages/ja.json` gain it, user-domain wording per project i18n rules).

### C8 — Ownership-mismatch responses unified to 404 (existence-oracle removal)

- Files (9 handlers, 6 route files + 6 test files):
  - `src/app/api/passwords/[id]/restore/route.ts` (POST)
  - `src/app/api/passwords/[id]/history/route.ts` (GET)
  - `src/app/api/passwords/[id]/history/[historyId]/restore/route.ts` (POST)
  - `src/app/api/passwords/[id]/attachments/[attachmentId]/route.ts` (GET, DELETE)
  - `src/app/api/folders/[id]/route.ts` (PUT, DELETE)
  - `src/app/api/tags/[id]/route.ts` (PUT, DELETE)
- Signature: replace the ownership-mismatch `return forbidden()` with `return notFound()` plus the same `// A01-4` rationale comment used at `src/app/api/passwords/[id]/route.ts:48-52`. Existence-check `notFound()` branches are untouched.
- Invariants: (app-enforced) personal-resource handlers never reveal existence of another user's resource via status-code differences. `forbidden()` remains correct for role/permission denials elsewhere — only owner-mismatch sites change.
- Forbidden patterns:
  - pattern: `forbidden()` adjacent to `userId !== userId`-style ownership comparison in the 6 files — reason: the oracle. (Verified per-file in review; not a blind file-wide ban.)
- Acceptance: the 6 test files' 403 assertions flip to 404 (listed: `restore/route.test.ts:48,58`, `history/route.test.ts:55,61`, `history/[historyId]/restore/route.test.ts:86,95`, `attachments/[attachmentId]/route.test.ts:117,123,225,231`, `folders/[id]/route.test.ts:92,103,228,237`, `tags/[id]/route.test.ts:51,57,185,191`) AND the corresponding `it("returns 403 ...")` titles are renamed to 404 (test names must not lie); full vitest green.
- Scope-exclusion record (reviewed): `vault/admin-reset/route.ts:86-88` (targetUserId mismatch) and `tenant/breakglass/[id]/route.ts:53-55` (requester/role check) keep `forbidden()`. Rationale: both IDs are unguessable CUIDs delivered only to their principals (reset record / grant), the 403 carries operational meaning in admin flows, and the breakglass check is a role denial, not an ownership oracle. Worst case: existence confirmation of a reset/grant whose ID the attacker already holds; likelihood low; revisited in Phase 3 review.
- Consumer-flow walkthrough: Consumers are the dashboard fetch helpers which branch on `res.ok` and show a generic failure toast — none branch on 403-vs-404 for these endpoints (cross-user IDs are unreachable from the UI). E2E tests do not assert 403 on these routes.

### C9 — Session-cookie extraction parses by exact cookie name

- File: `src/lib/proxy/auth-gate.ts:32-43` (+ `auth-gate.test.ts`).
- Signature: `extractSessionToken(cookie: string): string` — split the header on `;`, trim each segment, match the part before the first `=` exactly against `ALL_KNOWN_SESSION_COOKIE_NAMES` (preserving the existing name-priority order), return the raw value after the first `=`. Behavior otherwise identical (first match wins, `""` when absent).
- Invariants: (app-enforced) a cookie named `evil-authjs.session-token` (or any suffix-colliding name) never matches.
- Forbidden patterns:
  - pattern: `cookie.indexOf(prefix)` in `auth-gate.ts` — reason: substring match is the bug.
- Acceptance: new test cases — suffix-collision cookie ignored; legitimate cookie after a colliding one still found; leading-whitespace segment handled; existing tests green.

### C10 — Secrets never appear in process argv in operational scripts

- Files: `scripts/set-outbox-worker-password.sh`, `scripts/set-dcr-cleanup-worker-password.sh`, `scripts/set-audit-anchor-publisher-password.sh`, `scripts/purge-history.sh`, `scripts/purge-audit-logs.sh`, `scripts/rotate-master-key.sh`, `scripts/__tests__/set-outbox-worker-password.test.mjs`, `scripts/__tests__/set-dcr-cleanup-worker-password.test.mjs`, **new** `scripts/__tests__/set-audit-anchor-publisher-password.test.mjs` (the third sibling currently has NO test; it gets the same harness as the other two so the quoted-heredoc regression class is guarded on all three).
- Signatures:
  - psql trio: drop `-v "new_password=..."` from argv; feed the `ALTER ROLE` statement via stdin with SQL-safe quoting done in shell: `escaped=${new_password//\'/\'\'}` (single-quote doubling; correct under `standard_conforming_strings=on`), then an **unquoted-delimiter heredoc** (`<<EOF`, NOT `<<'EOF'` — a quoted delimiter would suppress `$escaped` interpolation and set a literal-`$escaped` password) piping `ALTER ROLE <role> WITH PASSWORD '<escaped>';` to `psql "$MIGRATION_DATABASE_URL" -f -`. Connection URL stays in argv (unchanged scope).
  - curl trio: move the `Authorization` header out of argv via `curl --config -` reading `header = "Authorization: Bearer <token>"` from stdin (heredoc), keeping all other options as-is.
- Invariants: (app-enforced) `ps -ef` during script execution never shows `new_password=` or `Authorization: Bearer`.
- Forbidden patterns:
  - pattern: `-v "new_password=` — reason: psql argv leak.
  - pattern: `-H "Authorization: Bearer ${ADMIN_API_TOKEN}"` — reason: curl argv leak.
- Test impact (existing tests pin the OLD argv format): `set-outbox-worker-password.test.mjs:8,46` and `set-dcr-cleanup-worker-password.test.mjs:66-69,122` assert `-v new_password=<value>` IS in psql argv via the DRY_RUN `--print-args-file` mechanism. These flip to assert the inverse (argv contains NO `new_password=`) plus the DRY_RUN path additionally captures the generated stdin SQL so tests assert the real password value (with quote-doubling) lands in the SQL — guarding against the quoted-heredoc regression above.
- Acceptance: `bash -n` passes on all six; updated script tests green; manual-test step (VE3) verifies `ps` output during a live run against the dev stack; scripts' existing behavior (exit codes, output) otherwise unchanged.

### C11 — Sentry transaction events pass through the scrubber

- Files: `sentry.server.config.ts`, `sentry.client.config.ts`, `src/lib/security/sentry-scrub.ts` (+ `sentry-scrub.test.ts`).
- Signature: add `beforeSendTransaction(event) { return scrubSentryEvent(...) }` with the same cast pattern as the existing `beforeSend` in both files. **Wiring alone is insufficient**: `scrubSentryEvent` currently processes only `extra`/`contexts`/`breadcrumbs`/`request.data`/`exception` — transaction-specific shapes are untouched. Extend it with: (a) `spans[]` — each span's `data` object passes through the existing key-based `scrubObject`; (b) a URL-sanitizing helper that strips query strings AND fragments (query-carried tokens, e.g. magic-link callback `?token=`; fragment-carried tokens, e.g. admin-vault-reset `#token=` — browser-side `request.url` derives from `window.location.href` and can include the fragment, which query-only stripping misses) AND redacts capability path segments from a CONSTANT LIST of token-carrying route patterns — all verified in this repo: `/s/<token>` (share/send), `/dashboard/teams/invite/<token>` (raw 256-bit invite token in path), `/dashboard/emergency-access/invite/<token>` (DB stores only the hash — the path IS the capability). Pattern shape per entry: `/\/s\/[^/?#]+/` → `/s/[redacted]` etc.; the list is a single exported constant so future token routes extend one place. Applied to `request.url`, `request.query_string`, string values under `url`-named keys (`url`, `http.url`) in span data, and client-side navigation breadcrumb `from`/`to` values. (Next.js SDK parameterizes transaction NAMES to route patterns — that does not sanitize the concrete URLs in `request.url`/span attributes, so name parameterization is not a substitute.)
- Invariants: (app-enforced) every Sentry event type that can carry URLs/headers passes `scrubSentryEvent`, and the scrubber handles the shapes those event types actually carry, including path-carried capability tokens.
- Forbidden patterns: none beyond review (config files are not grep-gateable for absence).
- Acceptance: both files set `beforeSendTransaction`; `npx next build` green; `sentry-scrub.test.ts` gains transaction-shaped fixtures asserting (a) sensitive keys in `spans[].data` are redacted, (b) an `http.url` value carrying `/s/<token>` in the PATH is redacted, (c) a query-carried token is stripped, (d) an invite-path token is redacted — fixture uses the LOCALE-PREFIXED real URL form (`/ja/dashboard/teams/invite/<token>`) so an accidentally anchored pattern fails the test, (e) a fragment-carried `#token=` is stripped — each fixture must FAIL against the pre-change scrubber (red-green verifiable by stashing `sentry-scrub.ts` and re-running the suite; no decorative tests).

### C12 — HIBP upstream fetch gets a timeout

- File: `src/app/api/watchtower/hibp/route.ts` (+ test).
- Signature: `const FETCH_TIMEOUT_MS = 10 * MS_PER_SECOND;` (import from `@/lib/constants/time`) and `signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)` on the fetch; abort/timeout error maps to the route's existing upstream-failure response (mirror how `webhook-dispatcher.ts:143` treats `AbortSignal.timeout`, and how this route already handles non-OK upstream).
- Invariants: (app-enforced) no outbound fetch in route handlers without a timeout. Sibling check (R34): other route-handler outbound fetches reviewed in Phase 3.
- Forbidden patterns:
  - pattern: `AbortSignal.timeout(10_000)`-style bare numerics in NEW code — reason: time-constant rule.
- Acceptance: unit test — fetch rejecting with a `TimeoutError`-shaped abort produces the upstream-failure response, not an unhandled 500.

### C13 — User-bound bearer tokens reject deactivated users

- Files: `src/lib/mcp/oauth-server.ts` (`validateMcpToken`), `src/lib/auth/tokens/api-key.ts` (`validateApiKey`), `src/lib/auth/tokens/extension-token.ts` (`validateExtensionToken`) — the extension-token gap is the R3 propagation of the audit finding; all three are user-bound. SA tokens are exempt (non-human; `serviceAccount.isActive` already checked).
- Signature — the membership predicate is **always tenant-scoped to the token's own tenant** (all three token models carry a non-null `tenantId`: `ApiKey.tenantId`, `ExtensionToken.tenantId`, `McpAccessToken.tenantId`; `TenantMember` has `@@unique([tenantId, userId])`): the check is `tenantMember.findUnique({ where: { tenantId_userId: { tenantId: token.tenantId, userId: token.userId } } })` and rejects unless the row exists with `deactivatedAt: null`. Do NOT reuse the tenant-UNscoped `getTenantMembership(userId)` — a multi-tenant user deactivated in tenant A but active in tenant B would otherwise keep using their tenant-A token (cross-tenant revocation bypass). Logic is **fail-closed**: "no active membership row found ⇒ invalid", never "reject only if a deactivated row is found".
  - Per-validator notes (verified against schema): the three lookups use `select`, not `include` (Prisma cannot mix them) — `McpAccessToken` has no `user` relation at all, so MCP necessarily performs the membership check as a second query; ApiKey/ExtensionToken may either extend the lookup with a navigable relation or use the same second query — implementer's choice, the predicate above is the contract.
  - **MCP SA-bound skip**: `McpAccessToken.userId` is nullable; tokens with `userId: null` + `serviceAccountId` set are legitimate SA-bound tokens (JIT/SA consent flow). The membership check is SKIPPED for `userId === null`; existing checks (`revokedAt`/`expiresAt`/`mcpClient.isActive`) still apply.
- Error mapping: MCP → existing `{ ok: false, error: "invalid_token" }`; ApiKey → `API_KEY_INVALID`; extension → the validator's existing invalid result. No new error codes (avoid creating a deactivation oracle distinct from invalid-token).
- Invariants: (app-enforced) a user deactivated from a tenant cannot authenticate with any user-bound bearer token issued for THAT tenant, with zero revocation-lag beyond the in-flight request; SA-bound MCP tokens are unaffected.
- Forbidden patterns: none grep-able; enforced by tests.
- Test impact: existing fixtures in `api-key.test.ts`, `extension-token.test.ts`, `oauth-server.test.ts` mock the token lookups WITHOUT membership data — under fail-closed logic every existing valid-token test would start failing; those fixtures (and the new membership-query mocks) must be updated in the same change.
- Acceptance: per-validator unit tests — (a) deactivated-in-token-tenant ⇒ invalid; (b) deactivated in token tenant but ACTIVE in another tenant ⇒ still invalid (cross-tenant bypass regression guard); (c) active user ⇒ valid; MCP additionally (d) `userId: null` SA-bound token ⇒ valid; extension additionally covers the `IOS_APP` clientKind path. One db-integration test exercises the real query shape end-to-end: deactivate membership → token validation fails (mock-reality divergence guard).
- Consumer-flow walkthrough: Consumers `checkAuth`/`authOrToken` read `{ ok, ... }` discriminated results from each validator and already handle the invalid variants; no shape change, only an additional path producing an existing variant.

## Go/No-Go Gate

| ID  | Subject                                              | Status  |
|-----|------------------------------------------------------|---------|
| C1  | Jackson dedicated non-superuser DB role              | locked |
| C2  | Redis requirepass + Sentinel data-node auth          | locked |
| C3  | Dev/logging ports bound to loopback                  | locked |
| C4  | unlock/data lockout enforcement                      | locked |
| C5  | Magic-link maxAge 15 min + fail-closed limiter       | locked |
| C6  | DCR cap lazy cleanup + 1 h unclaimed TTL             | locked |
| C7  | Consent DCR delete restricted to own client          | locked |
| C8  | 403→404 unification on 9 ownership handlers          | locked |
| C9  | Exact-name session-cookie parsing                    | locked |
| C10 | No secrets in script argv                            | locked |
| C11 | Sentry beforeSendTransaction scrub                   | locked |
| C12 | HIBP fetch timeout                                   | locked |
| C13 | Deactivated-user rejection in user-bound validators  | locked |

## Testing strategy

- Unit (vitest, co-located `route.test.ts`/module tests, `vi.hoisted` + `vi.mock` per existing convention): new/updated tests per C2 (redis.test.ts), C4, C5 (incl. template tests), C6, C7, C8 (assertion + title flips), C9, C10 (script tests), C11 (scrub fixture), C12, C13.
- db-integration (`npm run test:integration`, requires Postgres + `SHARE_MASTER_KEY`): C6 lazy-cleanup write-read test; C13 real-query-shape deactivation test. The `ci-integration.yml` job triggers on `src/lib/auth/**`, `src/lib/mcp/**`, `src/lib/redis.ts`, `src/app/api/**` — all hit by this PR, so these MUST run locally before push (`pre-pr.sh` skips them when Postgres is unreachable — do not rely on that skip).
- Build/lint gates: `npx vitest run`, `npx next build`, `npm run lint`, `npm run check:env-docs` (C1/C2 add env vars), `npm run test:integration` (local, real Postgres), `scripts/pre-pr.sh`.
- Compose: `docker compose config` render check for C1–C3 incl. HA overlay merge result (C2 acceptance); live `docker compose up` boot check (app ready + jackson healthy + redis NOAUTH from host) recorded in the manual-test artifact.
- Manual test plan (R35 Tier-2 — compose + auth-flow surface): `./docs/archive/review/security-audit-remediation-manual-test.md` with Pre-conditions / Steps / Expected / Rollback / Adversarial scenarios. Contents (two-filter rule applied): existing-volume Jackson role migration (C1 — the one path automation cannot reach; destructive steps marked operator-only), fresh `docker compose up` boot + jackson healthy + redis NOAUTH probe, HA `config` render check (sentinel auth-pass real value), dev-flow reachability after C3 (Prisma Studio :5432, mailpit :8025), locked-out unlock **UI message display in a real session** (the unit test covers the API response; the manual step covers only the UI surface), foreign-name consent claim via a second user, `ps` secret check during script runs (VE3). Pure API-level scenarios already covered by unit tests are excluded.

## Considerations & constraints

- No schema migration in this PR (C6 explicitly designed around it). Therefore `npm run db:migrate` dev-DB check is N/A.
- Lockout response shape for C4 must mirror `/api/vault/unlock` exactly — divergent shapes would force client changes (out of scope).
- `REDIS_PASSWORD` introduction must not break CI vitest (tests don't hit real Redis; integration suite reads env — verify `vitest.integration.config.ts` env wiring during Phase 2).
- Existing-volume operators: C1/C2 are breaking for running dev stacks until `.env` gains the two new vars and (C1) the role is created on the existing volume — upgrade note is part of the manual-test artifact and PR body.

### Scope contract

- SC1: Passphrase-verifier migration to Argon2id (audit Medium, crypto) — separate design PR; tracked as `TODO(security-audit-remediation): SC1` in the code-review log.
- SC2: ECDH public-key fingerprint out-of-band verification UI (audit Medium, crypto) — separate feature PR.
- SC3: Share-link token delivery via URL fragment (audit Low) — separate design PR.
- SC4: Wiring web unlock to server-returned KDF params (`deriveWrappingKeyWithParams`) + `change-passphrase` kdfParams (audit Low) — separate crypto PR.
- SC5: Email normalization / citext migration for SAML-path case sensitivity (audit Low/Info) — separate migration PR.
- SC6: `/api/auth/*` proxy-layer rate-limit/IP-restriction documentation (audit Medium, ops-doc) — docs PR.
- SC7: Per-IP DCR unclaimed cap (requires persisting registrant IP — schema change); C6 reduces but does not eliminate the exhaustion window.
- SC8: `app` service compose healthcheck (audit Info).
- SC9: Audit-log export/import client-claimed metadata hardening (audit Info).

## User operation scenarios

1. Dev onboarding: clone → `npm run init:env` (now also prompts `PASSWD_JACKSON_PASSWORD`, `REDIS_PASSWORD`) → `npm run docker:up` → app healthy, Jackson healthy, Redis authenticated.
2. Existing dev upgrade: pull → `init:env` NOTE or manual `.env` additions → role-creation one-liner on existing volume → `docker:up`.
3. Locked-out user: 5 failed unlocks → both `/api/vault/unlock` AND `/api/vault/unlock/data` return the lockout response until expiry; UI shows the existing lockout message.
4. Claude Code MCP onboarding: DCR register → consent → claim; re-registration replaces own client; a teammate cannot claim-delete it; a stale unclaimed registration disappears after 1 h without the cleanup worker.
5. Operator rotates worker DB password on a shared host: a second shell running `ps -ef | grep -E 'psql|curl'` during the script shows no password/token.

## Implementation Checklist

Derived from the locked contracts (file inventory verified in plan-review rounds 1-6):

- Batch A (infra/env): `infra/postgres/initdb/01-create-jackson-db.sql`, `docker-compose.yml` (jackson DB_URL, db env, redis command/healthcheck/env, app REDIS_URL), `docker-compose.ha.yml` (master/replicas commands+healthchecks+env, sentinel entrypoint+env, app REDIS_URL), `docker-compose.override.yml` + `docker-compose.logging.yml` (loopback ports), `scripts/env-allowlist.ts` (PASSWD_JACKSON_PASSWORD, REDIS_PASSWORD), `scripts/env-descriptions.ts` (REDIS_PASSWORD), `src/lib/env-schema.ts` (REDIS_PASSWORD), `src/lib/redis.ts` + new `src/lib/redis.test.ts`, regenerate `.env.example`, init:env hex generation for the two new vars.
- Batch B (vault/auth): `src/app/api/vault/unlock/data/route.ts` + `route.test.ts` (lockout + account-lockout mock), `src/lib/vault/vault-context.tsx` (shared envelope helper + 3 call sites) + `vault-context.test.tsx` (helper test + 3 wiring tests + prfOutput zeroization), `src/auth.config.ts` (maxAge, failClosed) + `auth.config.test.ts`, `src/lib/email/templates/magic-link.ts` + test (constant-interpolated duration).
- Batch C (MCP): `src/app/api/mcp/register/route.ts` (lazy deleteMany + 503 message) + `route.test.ts` (tx mock deleteMany, arg/order asserts), `src/lib/constants/auth/mcp.ts` (TTL 1h), `src/app/api/mcp/authorize/consent/route.ts` (createdById + foreign-collision reject + P2002 mapping) + tests, new db-integration test (DCR cap), `CLAUDE.md:129`, `docs/architecture/machine-identity.md:173,186`.
- Batch D (routes/proxy): 9 forbidden()→notFound() flips in 6 route files + 18 assertion/title flips in 6 test files (C8), `src/lib/proxy/auth-gate.ts` exact-name parse + `auth-gate.test.ts` cases (C9).
- Batch E1 (scripts): 6 scripts (psql stdin heredoc unquoted + curl --config -) + 2 updated test files + 1 new test file (anchor-publisher).
- Batch E2 (sentry/hibp): `sentry.server.config.ts`, `sentry.client.config.ts`, `src/lib/security/sentry-scrub.ts` (spans + URL sanitizer with constant route-pattern list) + `sentry-scrub.test.ts` (5 fixtures, pre-change-fail), `src/app/api/watchtower/hibp/route.ts` (AbortSignal.timeout from MS_PER_SECOND) + test.
- Batch E3 (tokens): `src/lib/mcp/oauth-server.ts`, `src/lib/auth/tokens/api-key.ts`, `src/lib/auth/tokens/extension-token.ts` (tenant-scoped findUnique tenantId_userId, fail-closed, MCP null-userId skip) + 3 fixture-updated test files + new db-integration test.
- Shared-utility reuse (mandatory): `createRateLimiter`/`RateLimiterOptions.failClosedOnRedisError`, `checkLockout` (`@/lib/auth/policy/account-lockout`), `notFound()`/`forbidden()` (`@/lib/http/api-response`), `MS_PER_*`/`SEC_PER_*` (`@/lib/constants/time`), `scrubObject`/`scrubSentryEvent`, `errorResponse(API_ERROR.UPSTREAM_ERROR)`, `VaultUnlockError`, Prisma `tenantId_userId` composite key.
- CI gate parity: pre-pr.sh covers lint/build/unit + repo gates (bypass-rls, crypto-domains, env-docs, migration-drift, team-auth-rls, licenses); known gaps = DB+Redis integration job (mitigated: local `npm run test:integration` mandated by Testing strategy) and Extension job (N/A — no extension/ changes in this PR).
- R35 gate: `security-audit-remediation-manual-test.md` must exist before Phase 2 completion (Tier-2: compose + auth surface).
