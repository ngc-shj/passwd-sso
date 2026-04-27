# Plan: verify-docs-codebase-sync

Date: 2026-04-28
Branch: `docs/verify-docs-codebase-sync`

## Project context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL 16 + Auth.js v5) — SSO / password manager
- Test infrastructure: unit + integration + CI/CD (vitest + integration vitest config + GitHub Actions)
- Documentation infrastructure: Markdown only — no doc build / link-check tool

## Objective

Bring `README.md`, `README.ja.md`, and `docs/{architecture,operations,security,setup}/` into agreement with the current codebase state. Out of scope: `docs/archive/`, `docs/plans/`, `docs/extension-store-listing.md`, `docs/forensics.md`, `CLAUDE.md`, `cli/`, `extension/` README files. Script header comments in `scripts/*.sh` flagged as cross-doc bug — fix only inasmuch as docs reference them; otherwise out of scope.

## Requirements

### Functional
- Every command-line example referenced in scope docs must execute against the current codebase (no removed scripts, no removed env vars, no removed routes).
- Every URL referenced must resolve to a real page (not `/dashboard/tenant/operator-tokens` when the page is at `/admin/tenant/operator-tokens`).
- Every source-file path referenced must exist after the `#392/#393` `src/lib` reorg.
- Numeric metric claims (RLS table count, audit action count, env var count, session timeout, extension token TTL) must match current source.
- Architectural narrative (CSRF gate location, session cache backend, audit pipeline, admin-token model) must match implementation.

### Non-functional
- Bilingual parity: where `*.ja.md` mirrors `*.md`, fixes must apply to both.
- Cross-doc consistency: same fact (e.g., RLS table count) must read consistently across all in-scope docs.
- No invented features: do not document behavior that is not implemented.

## Technical approach

Split fixes by directory with one Sonnet sub-agent per batch (5 batches, parallel where possible). Each batch consumes the per-area findings list and produces a single commit per batch. After all batches, run a final cross-doc consistency sweep, then a build + lint verification.

## Implementation steps

### Step 1 — Save findings + plan + branch
- [x] Save plan to `docs/archive/review/verify-docs-codebase-sync-plan.md`
- [x] Save raw expert findings to `docs/archive/review/verify-docs-codebase-sync-review.md`
- [x] Branch created: `docs/verify-docs-codebase-sync`

### Step 2 — Batch A: README.md + README.ja.md

Fix list (Critical):
1. **README.md:252** — remove `ADMIN_API_TOKEN` row from server env table; add a separate "Admin / maintenance scripts" section pointing to `docs/operations/admin-tokens.md`. Note operators mint per-operator `op_*` tokens at `/admin/tenant/operator-tokens` (the URL path documented in CLAUDE.md `/dashboard/...` is itself wrong — verify the actual page route).
2. **README.md:308 / README.ja.md:298** — replace "8-hour timeout" with tenant/team-policy-driven absolute timeout (default 30 days, configurable down to 5 min) per `SESSION_ABSOLUTE_TIMEOUT_MAX = 43200` in `src/lib/validations/common.ts`.
3. **README.ja.md:101** — remove "Delegated Decryption は将来対応"; mirror EN README's current-feature framing per `src/app/api/vault/delegation/`.

Fix list (Major):
4. **Both READMEs** — add `worker:audit-outbox` and `test:integration` to scripts table; add a brief Audit-outbox-worker note to architecture diagram + Docker services list (six containers: app/db/jackson/redis/migrate/audit-outbox-worker).
5. **README.md:76 / README.ja.md:75** — bump "39 tables" → "50+ tables" for FORCE RLS (verify exact count from migrations).
6. **README.md:259** — drop `aws-sm` from `KEY_PROVIDER` row unless code supports it (verify against `src/lib/env-schema.ts`).
7. **README.ja.md** — sync env table with EN (add `MIGRATION_DATABASE_URL`, `OUTBOX_WORKER_DATABASE_URL`, `PASSWD_OUTBOX_WORKER_PASSWORD`, `OUTBOX_BATCH_SIZE`, `NEXT_DEV_ALLOWED_ORIGINS`, `KEY_PROVIDER`, `SM_CACHE_TTL_MS`).
8. **README.ja.md** — sync scripts table with EN (`init:env`, `generate:env-example`, `check:env-docs`, `worker:audit-outbox`, `version:bump`).

Fix list (Minor):
9. **README.md:155** — broaden Prerequisites to allow Magic Link / Passkey-only setups.
10. **Both READMEs** — add admin-script invocation example block (`ADMIN_API_TOKEN=op_... scripts/purge-history.sh`) linking `docs/operations/admin-tokens.md`.
11. **README.ja.md** — add `Machine Identity & MCP Gateway` doc link.

### Step 3 — Batch B: docs/architecture/

Fix list (Critical):
1. **README.md:10** — clarify `e2e-guidelines.md` covers Playwright E2E tests (not E2E encryption); add description distinguishing the two.
2. **extension-token-bridge.md:214-215** — update paths: `src/lib/auth/tokens/extension-token.ts`, `src/lib/constants/integrations/extension.ts`.
3. **feature-comparison.md:94 / production-readiness.md:107 / feature-gap-analysis.md:29,564,581** — update RLS table count to current value (verify from `prisma/migrations/`).
4. **feature-gap-analysis.md:100** — update audit action count from 62 to current value (count from `src/lib/constants/audit/audit.ts`).
5. **production-readiness.md** — add 2026-04 update appendix covering durable audit outbox (#366-#370), per-operator `op_*` tokens (#408), Redis-backed session cache (#407), env Zod SSOT (#394), proxy ingress CSRF gate (#398). Update `Last updated` date. Update env var count claim.

Fix list (Major):
6. **extension-token-bridge.md:81** — mark legacy `POST /api/extension/token` as DEPRECATED with link.
7. **form-architecture-mapping.md:23-89** — refresh ~30 file path entries to match `src/components/passwords/personal/`, `src/components/team/forms/`, etc.
8. **entry-field-checklist.md:58-59,68-74,121-123,188,290** — refresh paths: `src/lib/vault/personal-entry-payload.ts`, `src/lib/team/team-entry-payload.ts`, `src/components/passwords/personal/...`.
9. **webauthn-registration-flow.md:59-63** — update paths to `src/lib/auth/webauthn/`.
10. **machine-identity.md:373** — replace `credentials:read` example with `credentials:use` (or `credentials:list, credentials:use`).

Fix list (Minor):
11. **machine-identity.md:128-152** — add nginx reverse-proxy example for `/.well-known/oauth-authorization-server`.
12. **extension-token-bridge.md:12** — replace branch ref with PR #364.
13. **feature-gap-analysis.md:284** — extend CLI command list (env, run, agent, api-key, ssh-key).
14. **feature-comparison.md:88** — change "Webhook not yet" to acknowledge webhooks ship.

### Step 4 — Batch C: docs/operations/

Fix list (Critical):
1. **admin-tokens.md (lines 6, 20, 32-34, 95, 119, 124)** — replace all `/dashboard/tenant/operator-tokens` URLs with the actual route (verify; expected `/admin/tenant/operator-tokens`).
2. **deployment.md:121-157** — rewrite Admin Operations section: drop `ADMIN_API_TOKEN` env-var setup; drop fictitious `OPERATOR_ID` env var; point to `admin-tokens.md`; show `ADMIN_API_TOKEN=op_... scripts/...`.
3. **incident-runbook.md:14-19** — rewrite master-key compromise procedure: clarify `/api/admin/rotate-master-key` re-encrypts share blobs (not vault data), requires `op_*` Bearer token, requires `SHARE_MASTER_KEY_V<N>` + `SHARE_MASTER_KEY_CURRENT_VERSION` setup.
4. **redis-ha.md:42** — replace "falls back to in-memory rate limiting" framing with current Redis-backed-session-cache reality (#407): tombstone propagation across nodes requires Redis.
5. **incident-runbook.md:88-95** — rewrite Redis-down impact: session validation falls back to direct DB lookups (higher Postgres load); revocation tombstones don't propagate; rate limiting also degrades.

Fix list (Major):
6. **README.md:8-18** — add index entries for `admin-tokens.md`, `audit-log-forwarding.md`, `key-provider-setup.md`.
7. **deployment.md:74** — list six services (`app`, `db`, `jackson`, `redis`, `migrate`, `audit-outbox-worker`); document `audit-outbox-worker` requirement.
8. **deployment.md:181-208** — add third row for `passwd_outbox_worker` DB role; reference `OUTBOX_WORKER_DATABASE_URL` and `scripts/set-outbox-worker-password.sh`.
9. **deployment.md** — add Environment Configuration sub-section pointing to `npm run init:env` and `check:env-docs`.
10. **deployment.md:144-157** — collapse the purge-history block to a one-paragraph pointer to `admin-tokens.md`.
11. **incident-runbook.md:53-65** — extend breach-table with `service_account_tokens`, `mcp_access_tokens`, `operator_tokens`, `scim_tokens`, `webauthn_credentials`.
12. **audit-log-reference.md:3,34-39,530-548** — drop stale "117 actions" count or use a script-emitted figure; rewrite Special userId Values around `(sentinel UUID + ActorType)` (`ANONYMOUS_ACTOR_ID = 00000000-0000-4000-8000-000000000000`); add ActorType section listing five values; update Source Files to point to `logAuditAsync` and `*AuditBase` helper.
13. **audit-log-forwarding.md** — add Audit pipeline section (route handler → audit_outbox in-tx → worker → audit_logs); reference health/purge endpoints.
14. **audit-log-forwarding.md** — add Per-tenant delivery targets section pointing to `/api/tenant/audit-delivery-targets`.

Fix list (Minor):
15. **incident-runbook.md** — add "Audit outbox worker down" runbook section.
16. **deployment.md:5-44** — add brief Self-hosted Docker production sub-section.
17. **redis-ha.md** — cite `SESSION_CACHE_TTL_MS`, `TOMBSTONE_TTL_MS`, `NEGATIVE_CACHE_TTL_MS` constants.
18. **deployment.md:71-74** — clarify Compose file usage (override.yml is dev only).
19. **key-provider-setup.md** — note V1-pinned session-cache subkey side-effect on rotation.

### Step 5 — Batch D: docs/security/

Fix list (Critical):
1. **cors-policy.md:21** — rewrite Defense Layers row to reflect proxy ingress CSRF gate (`src/lib/proxy/csrf-gate.ts`); list KEEP-inline `assertOrigin` exceptions (`passkey/options`, `passkey/options/email`, `passkey/verify`) plus stricter `admin-reset` post-baseline check.
2. **cors-policy.md:46-48** — replace stale paths: `src/lib/http/cors.ts`, `src/lib/auth/session/csrf.ts`, `src/lib/proxy/csrf-gate.ts`, `src/lib/proxy/cors-gate.ts`.

Fix list (Major):
3. **cors-policy.md:42** — update `handleApiAuth()` reference to `src/lib/proxy/api-route.ts`.
4. **cors-policy.md** — cross-link CSP `form-action localhost` (#403) to threat-model.md.
5. **policy-enforcement.md:80** — rewrite Session info row for Redis cache + tombstone (#407); reference `src/lib/auth/session/session-cache.ts`.
6. **session-timeout-design.md:73** — clarify session validity is Redis-cached; tombstones short-circuit propagation.
7. **threat-model.md** — add Header Trust sub-section (XFF spoofing #391, Origin fail-open #391, IP-bound rate-limit derivation).
8. **threat-model.md** — add tenant IP enforcement on bearer-route coverage (#390); reference `checkAccessRestrictionWithAudit` in `src/lib/proxy/api-route.ts`.
9. **threat-model.md:79 / security-review.md:268** — reconcile RLS allowlist count (47 vs 25); verify against `scripts/checks/check-bypass-rls.mjs`.
10. **security-review.md** (multiple lines) — bulk-refresh stale `src/proxy.ts:64/73/89`, `src/lib/{extension-token,auth-or-token,crypto-client,crypto-aad,vault-context}.ts` paths.
11. **security-review.md:263-266** — reconcile internal contradiction (28 vs 39 tables); use current count.
12. **considerations/en.md:78,137,157,261,429 + ja.md mirrors** — refresh `src/lib/crypto-*.ts` paths to `src/lib/crypto/`.
13. **considerations/en.md:179,386 / vulnerability-triage.md:84-93** — replace "15-minute" extension TTL with tenant-policy `extensionTokenIdleTimeoutMinutes`/`extensionTokenAbsoluteTimeoutMinutes` (default 7d / 30d).
14. **considerations/en.md:409,412** — refresh `vault-context.tsx` paths to `src/lib/vault/`.
15. **audit-preparation-checklist.md** — add operator (`op_*`) tokens, audit chain, audit outbox durability, ActorType enum, AUDIT_LOG_PURGE bullets.
16. **README.md (security index)** — add `policy-enforcement.md`, `vulnerability-triage.md` rows.

Fix list (Minor):
17. **policy-enforcement.md:18-19** — add path prefix to file refs.
18. **threat-model.md:6** — bump Last updated date.
19. **cryptography-whitepaper.md:7** — bump date.
20. **key-retention-policy.md** — add note about op_* token requirement.

### Step 6 — Batch E: docs/setup/

Fix list (Critical):
1. **docker/en.md:19** — update Tech Stack row from "3 containers" to six services.
2. **docker/en.md:23-46** — add Redis + audit-outbox-worker to architecture diagram.
3. **docker/en.md:110,116,308** — change Redis from "optional" to "required in production" per Zod schema enforcement (`src/lib/env-schema.ts:366-370`); reference #407.
4. **docker/en.md:229-234** — fix Production Deployment section: list five mandatory production services (app/db/jackson/redis/audit-outbox-worker); explain how to run worker outside `docker-compose.override.yml`.
5. **docker/en.md** — add `JACKSON_API_KEY` and `PASSWD_OUTBOX_WORKER_PASSWORD` to env table; reference `scripts/set-outbox-worker-password.sh`.
6. **docker/en.md** — add Database role separation section (passwd_app / passwd_user / passwd_outbox_worker).
7-9. **aws/en.md:6,10-31,42-55,96** — add audit-outbox-worker (separate ECS service or sidecar); add `OUTBOX_WORKER_DATABASE_URL`, `PASSWD_OUTBOX_WORKER_PASSWORD`, `JACKSON_API_KEY` (note Jackson env name `JACKSON_API_KEYS`); add Admin/maintenance scripts section for op_* tokens; mark `REDIS_URL` required for production.
10-11. **azure/en.md:14-22** — add audit-outbox-worker (Container Apps job/sidecar), missing secrets, op_* admin tokens, Redis required.
12-13. **gcp/en.md:14-21** — add audit-outbox-worker (Cloud Run job / GKE / GCE), missing secrets, op_* admin tokens, Redis required.
14-17. **vercel/en.md:24-44** — add audit-outbox-worker hosting guidance (Vercel cannot host it; suggest Fly/Railway/Render); add Jackson hosting guidance; add `JACKSON_API_KEY` and op_* admin tokens; change "Redis (recommended)" → "Redis (required)" with Upstash suggestion.

Fix list (Major):
18. **docker/en.md:362** — fix Prisma 7 dotenv ordering note (verify against `prisma.config.ts`).
19. **docker/en.md:343-355** — refresh npm Scripts table (add `init:env`, `worker:audit-outbox`, etc.).
20. **docker/en.md:364-401** — shrink stale Directory Structure block or link to CLAUDE.md.
21. **azure/en.md** — add Jackson deployment subsection.
22. **gcp/en.md** — add Jackson deployment subsection.
23. **vercel/en.md:24** — note `init:env` workflow.
24. **aws/en.md:96** — mark `REDIS_URL` as required; document `JACKSON_API_KEYS` env name.

### Step 7 — Verification

- Run `npm run check:env-docs` (env doc drift checker)
- Spot-check ~5 randomly-quoted file paths via `Read`/`grep` to verify they resolve
- Run `npx next build` (sanity — no markdown impact expected)
- Manually verify cross-doc consistency for: RLS table count, audit action count, env var count, six Docker services, Redis-required statement, op_* admin token model

### Step 8 — Phase 3: code review

Three Sonnet sub-agents (functionality, security, testing). For docs-only PR:
- Functionality reviews accuracy of factual claims, source/path correctness, completeness of fixes
- Security reviews accuracy of CSRF/CORS/auth/crypto descriptions; absence of misleading guidance
- Testing reviews whether any test/CI/operational guidance is internally consistent

## Testing strategy

- Manual spot-check of ~5 quoted file paths and ~3 quoted commands per batch
- `npm run check:env-docs` to catch env-table drift between `.env.example` and Zod SSoT (verify the doc env tables are not in scope of this checker — currently it only checks `.env.example`, so README env tables are still manually-maintained)
- Build sanity (`npx next build`) — no expected markdown impact, but catches accidental broken JSX import in any reference docs

## Considerations & constraints

- **Docs-only repo state**: Lint/test/build aren't strictly required for `*.md` changes, but project policy mandates them. We will run them.
- **No automated link-check**: This audit relies on `grep` / `Read` verification per finding. Future improvement: add a markdown link-checker to CI (out of scope here).
- **CLAUDE.md drift**: CLAUDE.md itself contains the wrong `/dashboard/tenant/operator-tokens` URL. Fixing CLAUDE.md is out of agreed scope; we will note this in the deviation log so a follow-up PR addresses it.
- **Script header comment drift**: `scripts/purge-history.sh`, `purge-audit-logs.sh`, `rotate-master-key.sh` headers also have wrong URL. Out of scope; flagged for follow-up.
- **Bilingual parity**: All EN doc fixes that have JA mirrors must propagate to JA (`README.ja.md`, `considerations/ja.md`, `backup-recovery/ja.md`).
- **Minor findings**: Will be applied if straightforward; otherwise deferred with reason in deviation log.
- **No CSRF/security policy regressions**: Doc fixes for cors-policy.md must accurately describe the proxy ingress gate without overcorrecting in a way that suggests routes can skip checks they shouldn't.

## User operation scenarios

1. **Operator on-boards admin-token-protected scripts**: reads `docs/operations/admin-tokens.md`, navigates to UI URL → URL must work. Critical.
2. **DevOps deploys to AWS first time**: reads `docs/setup/aws/en.md`, expects to know all required services + secrets. Without audit-outbox-worker guidance, audit logs silently fail in production.
3. **Security auditor reads `docs/security/cors-policy.md`**: must understand where CSRF/Origin is enforced. Wrong description → audit findings against the project.
4. **New contributor reads `docs/architecture/form-architecture-mapping.md`**: clicks file paths → broken paths → must guess actual locations from `find` / IDE search.
5. **Operator hits Redis outage**: reads `docs/operations/incident-runbook.md` → understated impact section underestimates session-revocation widow → operator under-prioritizes incident.

## Recurring Issue Check (deferred to Phase 1-4 expert review)

Skipped per user instruction to proceed directly to Phase 2 / 3 (lightweight workflow agreed).
