# Plan Review: verify-docs-codebase-sync

Date: 2026-04-28
Review round: 1 (initial drift survey only — full Phase 1 expert review skipped per user instruction; Phase 2 implementation + Phase 3 code review will substitute)

## Methodology

5 parallel general-purpose audit agents surveyed the in-scope docs against the codebase, with the recent ~30 days of merged PRs as the primary "drift inducer" list. Findings classified by severity (Critical = factually wrong / will mislead, Major = significant gap, Minor = cosmetic).

In-scope:
- `README.md`, `README.ja.md`
- `docs/architecture/` (12 files)
- `docs/operations/` (12 files including subdirs)
- `docs/security/` (14 files including subdirs)
- `docs/setup/` (6 files)

Out-of-scope: `docs/archive/`, `docs/plans/`, `docs/extension-store-listing.md`, `docs/forensics.md`, `CLAUDE.md`, `cli/`, `extension/`, top-level `*.md` (except README/README.ja).

## Verified facts (consulted by all batches)

| Claim | Reality | Source |
|---|---|---|
| Operator-tokens UI route | `/[locale]/admin/tenant/operator-tokens/` | `src/app/[locale]/admin/tenant/operator-tokens/page.tsx` |
| FORCE RLS table count | 52 | `grep "FORCE ROW LEVEL SECURITY" prisma/migrations/` |
| Audit action enum entries | 176 | `src/lib/constants/audit/audit.ts` |
| Session absolute timeout MIN/MAX/DEFAULT | 5 / 43200 / 43200 (minutes) | `src/lib/validations/common.ts:163-176` |
| Docker services (base) | 5 (`app`, `db`, `jackson`, `migrate`, `redis`) | `docker-compose.yml` |
| Docker services (dev override adds) | 2 (`audit-outbox-worker`, `mailpit`) | `docker-compose.override.yml` |
| Production worker requirement | `audit-outbox-worker` MUST run; not in base compose | code reality + `package.json:42` (`npm run worker:audit-outbox`) |
| `ADMIN_API_TOKEN` env var | Removed (#408) | absent from `src/lib/env-schema.ts`, `.env.example`; `src/lib/auth/tokens/admin-token.ts:5` |
| Operator token regex | `^op_[A-Za-z0-9_-]{43}$` | `scripts/rotate-master-key.sh:29` |
| Session cache backend | Redis with tombstone propagation (#407) | `src/lib/auth/session/session-cache.ts` |
| Proxy CSRF baseline | Enforced at ingress (`src/lib/proxy/csrf-gate.ts`); 3 KEEP-inline pre-auth exceptions + admin-reset stricter check | #398 (cb6fbecc) |

## Functionality / Operations Findings (consolidated)

### Critical

**C-Ops-1**: `docs/operations/admin-tokens.md:6,20,32-34,95,119,124` — operator-tokens UI URL written as `/dashboard/tenant/operator-tokens`; actual route is `/admin/tenant/operator-tokens`. This is the very first action an operator takes; will fail with 404.

**C-Ops-2**: `docs/operations/deployment.md:121-157` — Admin Operations section documents removed shared `ADMIN_API_TOKEN` env-var workflow plus a non-existent `OPERATOR_ID` env var. Operators following this will get 401 on every admin call (env path was removed in #408).

**C-Ops-3**: `docs/operations/incident-runbook.md:14-19` — Master-key compromise procedure conflates `/api/admin/rotate-master-key` (share-link master key, re-encrypts share blobs) with vault data exposure. Doesn't mention required `op_*` Bearer token, `SHARE_MASTER_KEY_V<N>` + `SHARE_MASTER_KEY_CURRENT_VERSION` setup.

**C-Ops-4**: `docs/operations/redis-ha.md:42` — claims fallback is "in-memory rate limiting"; after #407, missing Redis means tombstone-based session revocation no longer propagates across nodes.

**C-Ops-5**: `docs/operations/incident-runbook.md:88-95` — Redis-down impact framed as "Auth.js falls back to database sessions automatically". Reality: Auth.js already uses DB sessions; Redis is the cache. Without Redis, every validation hits Postgres directly + revocation tombstones don't propagate (revoked-session window widens across nodes).

### Major

**M-Ops-1**: `docs/operations/README.md:8-18` — index missing `admin-tokens.md`, `audit-log-forwarding.md`, `key-provider-setup.md`.

**M-Ops-2**: `docs/operations/deployment.md:74` — describes 4 services; reality is 5 base + audit-outbox-worker (dev override) + mailpit. Production must include the worker.

**M-Ops-3**: `docs/operations/deployment.md:181-208` — Database User Permissions table omits `passwd_outbox_worker` role.

**M-Ops-4**: `docs/operations/deployment.md:168-179` — never mentions `init:env`, `generate:env-example`, `check:env-docs` (#394 env Zod SSOT).

**M-Ops-5**: `docs/operations/deployment.md:144-157` — purge section misses `purge-audit-logs.sh` and the four other `/api/maintenance/*` endpoints.

**M-Ops-6**: `docs/operations/incident-runbook.md:53-65` — breach table missing `service_account_tokens`, `mcp_access_tokens`, `operator_tokens`, `scim_tokens`, `webauthn_credentials`.

**M-Ops-7**: `docs/operations/incident-runbook.md:18` — `/api/admin/rotate-master-key` mis-described as "admin mass vault reset"; no op_* token requirement.

**M-Ops-8**: `docs/operations/audit-log-reference.md:3` — "117 actions" stale; new actions added (count: 176 entries in source).

**M-Ops-9**: `docs/operations/audit-log-reference.md:34-39` — "Special userId Values" model is legacy strings; current is sentinel UUID + ActorType (`ANONYMOUS_ACTOR_ID`).

**M-Ops-10**: `docs/operations/audit-log-reference.md:530-548` — Source Files row points to `logAudit` (renamed/deprecated); should be `logAuditAsync` + `*AuditBase` helper (#374, #389).

**M-Ops-11**: `docs/operations/audit-log-forwarding.md` — no mention of audit outbox pipeline (#366-#370); doesn't reference `/api/maintenance/audit-outbox-metrics` or `audit-outbox-purge-failed`.

**M-Ops-12**: `docs/operations/audit-log-forwarding.md` — no mention of per-tenant audit-delivery-targets (#372).

### Minor

**Mn-Ops-1**: `docs/operations/incident-runbook.md` — no "Audit outbox worker down" runbook section.

**Mn-Ops-2**: `docs/operations/redis-ha.md` — could cite `SESSION_CACHE_TTL_MS`, `TOMBSTONE_TTL_MS` constants.

**Mn-Ops-3**: `docs/operations/deployment.md:5-44` — only AWS ECS guidance; no Self-hosted Docker production sub-section.

**Mn-Ops-4**: `docs/operations/key-provider-setup.md` — no note about V1-pinned session-cache subkey side-effect on rotation (per #407).

## Security Findings (consolidated)

### Critical

**C-Sec-1**: `docs/security/cors-policy.md:21` — `assertOrigin()` listed as route-level defense; misrepresents #398/#406 SSoT design (proxy ingress gate).

**C-Sec-2**: `docs/security/cors-policy.md:46-48` — implementation file paths wrong: `src/lib/cors.ts`, `src/lib/csrf.ts` no longer exist. Current: `src/lib/http/cors.ts`, `src/lib/auth/session/csrf.ts`, `src/lib/proxy/csrf-gate.ts`, `src/lib/proxy/cors-gate.ts`.

### Major

**M-Sec-1**: `docs/security/cors-policy.md:42` — `handleApiAuth()` ref points to `src/proxy.ts`; now in `src/lib/proxy/api-route.ts`.

**M-Sec-2**: `docs/security/cors-policy.md` — no cross-link to CSP `form-action localhost` decision (#403).

**M-Sec-3**: `docs/security/policy-enforcement.md:80` — Session info row claims "30s TTL expiry only"; after #407, Redis-backed with tombstone propagation.

**M-Sec-4**: `docs/security/session-timeout-design.md:73` — Cache TTL note inconsistent with #407.

**M-Sec-5**: `docs/security/threat-model.md` — missing trust-of-headers section (XFF spoofing, Origin fail-open) per #391.

**M-Sec-6**: `docs/security/threat-model.md` — missing tenant IP enforcement on bearer-route coverage per #390.

**M-Sec-7**: `docs/security/threat-model.md:79 / security-review.md:268` — RLS allowlist count contradicts (47 vs 25).

**M-Sec-8**: `docs/security/security-review.md` — multiple stale `src/proxy.ts:64/73/89` and `src/lib/{extension-token,auth-or-token,crypto-client,crypto-aad,vault-context}.ts` paths.

**M-Sec-9**: `docs/security/security-review.md:263-266` — internal contradiction (28 vs 39 tables FORCE RLS).

**M-Sec-10**: `docs/security/considerations/{en,ja}.md:78,137,157,261,429` — stale `src/lib/crypto-*.ts` paths (now `src/lib/crypto/`).

**M-Sec-11**: `docs/security/considerations/en.md:179,386 / vulnerability-triage.md:84-93` — "15-minute" extension TTL hard-coded; now tenant-policy-controlled per #384.

**M-Sec-12**: `docs/security/considerations/en.md:409,412` — `vault-context.tsx:143/280` paths stale (`src/lib/vault/`).

**M-Sec-13**: `docs/security/audit-preparation-checklist.md` — no mention of operator tokens, audit chain, audit outbox durability, ActorType enum, AUDIT_LOG_PURGE.

**M-Sec-14**: `docs/security/README.md` — index missing `policy-enforcement.md`, `vulnerability-triage.md`.

### Minor

**Mn-Sec-1**: `docs/security/policy-enforcement.md:18-19` — file refs missing path prefix.

**Mn-Sec-2**: `docs/security/threat-model.md:6` — Last updated date stale (2026-04-04).

**Mn-Sec-3**: `docs/security/cryptography-whitepaper.md:7` — date stale (2026-04-09).

**Mn-Sec-4**: `docs/security/key-retention-policy.md` — no note about op_* token requirement.

## Architecture Findings (consolidated)

### Critical

**C-Arch-1**: `docs/architecture/README.md:10` — `e2e-guidelines.md` description ambiguous between Playwright E2E tests and E2E encryption.

**C-Arch-2**: `docs/architecture/extension-token-bridge.md:214-215` — paths `src/lib/extension-token.ts`, `src/lib/constants/extension.ts` no longer exist (now under `src/lib/auth/tokens/`, `src/lib/constants/integrations/`).

**C-Arch-3**: `docs/architecture/feature-comparison.md:94` + `production-readiness.md:107` + `feature-gap-analysis.md:29,564,581` — RLS table count "39" (some "28"); reality 52.

**C-Arch-4**: `docs/architecture/feature-gap-analysis.md:100` — audit action count "62"; reality 176 entries.

**C-Arch-5**: `docs/architecture/production-readiness.md` — missing 5 major recent deliveries: durable audit outbox (#366-#370), op_* tokens (#408), Redis session cache (#407), env Zod SSOT (#394), proxy ingress CSRF gate (#398).

### Major

**M-Arch-1**: `docs/architecture/extension-token-bridge.md:81` — legacy `POST /api/extension/token` not marked DEPRECATED.

**M-Arch-2**: `docs/architecture/form-architecture-mapping.md:23-89` — ~30 file path entries stale post-#392/#393.

**M-Arch-3**: `docs/architecture/entry-field-checklist.md:58-59,68-74,121-123,188,290` — paths stale.

**M-Arch-4**: `docs/architecture/webauthn-registration-flow.md:59-63` — paths stale (now `src/lib/auth/webauthn/`).

**M-Arch-5**: `docs/architecture/machine-identity.md:373` — example uses `credentials:read` (not in scope set); should be `credentials:use`.

### Minor

**Mn-Arch-1**: `docs/architecture/machine-identity.md:128-152` — no nginx reverse-proxy example.

**Mn-Arch-2**: `docs/architecture/extension-token-bridge.md:12` — references unmerged feature branch.

**Mn-Arch-3**: `docs/architecture/extension-token-bridge.md:205` — vague historical reference.

**Mn-Arch-4**: `docs/architecture/feature-gap-analysis.md:284` — CLI command list incomplete.

**Mn-Arch-5**: `docs/architecture/production-readiness.md:1` — Last-updated stamp stale.

**Mn-Arch-6**: `docs/architecture/extension-passkey-provider.md:163` — imprecise wording about MAIN-world origin.

**Mn-Arch-7**: `docs/architecture/feature-comparison.md:88` — "Webhook not yet" stale.

## README Findings (consolidated)

### Critical

**C-RM-1**: `README.md:252` — `ADMIN_API_TOKEN` listed as server env var; removed in #408.

**C-RM-2**: `README.md:308` — claims "8-hour timeout"; reality 30 days default.

**C-RM-3**: `README.ja.md:101` — claims delegated decryption is "future"; ships.

**C-RM-4**: `README.ja.md:298` — same 8-hour stale claim as EN.

### Major

**M-RM-1**: README.md missing `worker:audit-outbox`, `test:integration`, audit-outbox-worker in architecture diagram + Docker services list.

**M-RM-2**: `README.md:60` + `README.ja.md:55` — Architecture diagram has no audit-outbox-worker.

**M-RM-3**: `README.md:76` + `README.ja.md:75` — "39 tables FORCE RLS" stale; reality 52.

**M-RM-4**: `README.md:259` — `KEY_PROVIDER` row lists `aws-sm`; not in env-schema enum (only `env`, `azure-kv`, `gcp-sm`).

**M-RM-5**: `README.ja.md` — env table missing 8 vars present in EN.

**M-RM-6**: `README.ja.md` — scripts table missing `init:env`, `generate:env-example`, `check:env-docs`, `worker:audit-outbox`, `version:bump`.

**M-RM-7**: `README.ja.md` — no Documentation link to `machine-identity.md`.

### Minor

**Mn-RM-1**: README missing admin-script invocation example.

**Mn-RM-2**: `README.md:155` — Prerequisites doesn't allow Magic Link / Passkey-only.

## Setup Findings (consolidated)

### Critical (Docker)

**C-Set-D1**: `docs/setup/docker/en.md:19` — Tech Stack row says "3 containers"; should reflect 5 base + dev-override worker/mailpit.

**C-Set-D2**: `docs/setup/docker/en.md:23-46,30-32` — Architecture diagram omits Redis + audit-outbox-worker.

**C-Set-D3**: `docs/setup/docker/en.md:110,116,308` — "Redis is optional"; required in production by Zod schema.

**C-Set-D4**: `docs/setup/docker/en.md:229-234` — "Three containers will start" + tells operators NOT to use override.yml in production. But the worker is only in override.yml; production must run it separately.

**C-Set-D5**: `docs/setup/docker/en.md` — env table missing `JACKSON_API_KEY` (required by Compose) and `PASSWD_OUTBOX_WORKER_PASSWORD` (initdb).

**C-Set-D6**: `docs/setup/docker/en.md` — no Database role separation section (passwd_app / passwd_user / passwd_outbox_worker).

### Critical (AWS, Azure, GCP, Vercel — recurring)

**C-Set-A1**: `docs/setup/aws/en.md:6,10-31` — architecture omits audit-outbox-worker.

**C-Set-A2**: `docs/setup/aws/en.md:42-55` — secrets list missing `OUTBOX_WORKER_DATABASE_URL`, `PASSWD_OUTBOX_WORKER_PASSWORD`, `JACKSON_API_KEY`.

**C-Set-A3**: `docs/setup/aws/en.md` — no per-operator op_* admin token model (#408).

**C-Set-Az1-3**: same three issues for `docs/setup/azure/en.md`.

**C-Set-G1-2**: same for `docs/setup/gcp/en.md`.

**C-Set-V1**: `docs/setup/vercel/en.md:24-44` — no audit-outbox-worker hosting guidance (Vercel can't host long-running workers).

**C-Set-V2**: `docs/setup/vercel/en.md` — no Jackson hosting guidance.

**C-Set-V3**: `docs/setup/vercel/en.md` — no `JACKSON_API_KEY` / op_* admin tokens.

**C-Set-V4**: `docs/setup/vercel/en.md:33` — Redis "recommended"; should be "required".

### Major

**M-Set-D1**: `docs/setup/docker/en.md:362` — stale Prisma 7 dotenv ordering note.

**M-Set-D2**: `docs/setup/docker/en.md:343-355` — npm Scripts table missing many commands.

**M-Set-D3**: `docs/setup/docker/en.md:364-401` — Directory Structure block stale (post-reorg).

**M-Set-A1**: `docs/setup/aws/en.md:96` — `REDIS_URL` not flagged required.

**M-Set-Az1-2**: same Redis-required issue + missing Jackson hosting subsection for Azure.

**M-Set-G1-2**: same for GCP.

**M-Set-V1**: `docs/setup/vercel/en.md:24` — no `init:env` workflow note.

### Minor

**Mn-Set-1**: `docs/setup/README.md:7` — index description fine; minor wording.

**Mn-Set-2**: `docs/setup/aws/en.md:106` — `JACKSON_DB_URL` example schema detail.

## Quality Warnings

None — all findings include file:line citation and codebase reality with src/path:line evidence.

## Resolution path

Findings will be applied in 5 batches (Phase 2):
- Batch A: README files
- Batch B: docs/architecture/
- Batch C: docs/operations/
- Batch D: docs/security/
- Batch E: docs/setup/

Each batch produces one commit. Phase 3 runs 3-expert code review on the assembled diff.

## Recurring Issue Check

Skipped per agreed-lightweight workflow (initial drift survey is itself the substitute for plan-review expert pass).
