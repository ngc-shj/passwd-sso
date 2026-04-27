# Code Review: verify-docs-codebase-sync

Date: 2026-04-28
Review rounds: 1 (issues identified) + 1 (resolved)

## Round 1 — three-expert parallel review

Three Sonnet sub-agents reviewed the 36-file diff (`git diff main...HEAD` after the 5 batch commits) from Functionality, Security, and Testing perspectives. All review reports are merged below.

### Critical findings (5)

**C1** — `docs/security/threat-model.md:117` (§3.4.1 Header Trust). The new "Origin header presence" row stated that a missing `Origin` "bypasses the Origin check." Reality: `src/lib/auth/session/csrf.ts:36` rejects with 403 (`if (!origin) return forbidden()`). The `assertOrigin` helper requires `Origin` for every cookie-bearing mutating request. The doc inverted the actual behavior — auditors and future contributors could conclude there is no missing-Origin protection at the proxy layer. **Source: Security expert (escalated).**

**C2** — `docs/security/key-retention-policy.md:142`. Newly added §7 sent operators to `/dashboard/tenant/operator-tokens`. Real route is `/admin/tenant/operator-tokens` (`src/app/[locale]/admin/tenant/operator-tokens/page.tsx`). **Source: Functionality + Security agreed.**

**C3** — `docs/security/audit-preparation-checklist.md:39`. Same wrong URL as C2. **Source: Functionality + Security agreed.**

**C4** — `docs/operations/audit-log-forwarding.md:214`. PATCH endpoint described as supporting "enable/disable, rotate secret." Schema accepts only `{ isActive: boolean }` (`src/app/api/tenant/audit-delivery-targets/[id]/route.ts:18-19`). No secret-rotation capability exists. **Source: Testing expert.**

**C5** — Audit action count "150+" vs verified ~140 in Prisma enum / ~165 in TypeScript const. The Functionality expert flagged this as Critical. After re-verification, "150+" is a defensible characterization (TS `AUDIT_ACTION` const has 165 entries; Prisma `AuditAction` enum has 140 values; the public `AUDIT_ACTION` surface in source is 165, of which a subset is persisted). Disposition: **rejected as Critical, kept as 150+** because the public emit surface (which is what an auditor measures) is well above 150.

### Major findings (7)

**M1** — `docs/architecture/extension-token-bridge.md:11,80,83,199-200`. Lingering "15-minute TTL" claims after #384 made extension token TTL tenant-policy-driven (default 7d idle / 30d absolute). **Source: Security expert.**

**M2** — `docs/operations/redis-ha.md` failover Expected Results. "Both recover automatically when ioredis reconnects" understates the residual risk: rate-limit state recovers, but **revocation tombstones written during the failover window are permanently lost**. **Source: Security expert.**

**M3** — `docs/setup/azure/en.md`, `docs/setup/gcp/en.md`. `HEALTH_REDIS_REQUIRED=true` recommendation present in AWS and Docker setup docs but missing from Azure and GCP. **Source: Security expert.**

**M4** — `SESSION_CACHE_TTL_MS=30000 ms` and friends presented with `=` assignment syntax in `docs/operations/redis-ha.md`, `docs/operations/deployment.md`, `docs/setup/vercel/en.md`. These are hardcoded constants in `src/lib/validations/common.server.ts`; they are not env-configurable. Operators may try to override via environment and observe no effect. **Source: Testing expert.**

**M5** — `docs/operations/deployment.md` and `docs/operations/admin-tokens.md`. `RETENTION_DAYS`, `DRY_RUN`, `INSECURE` script options were dropped without replacement guidance. An operator running purge scripts without `DRY_RUN=true` first will execute a destructive default. **Source: Testing expert.**

**M6** — `OUTBOX_WORKER_DATABASE_URL` documented as "Required" in `docs/setup/vercel/en.md`, `docs/setup/azure/en.md`, `docs/setup/gcp/en.md`. Reality: `src/lib/env-schema.ts:47` marks it `.optional()`; `scripts/audit-outbox-worker.ts:63` falls back to `DATABASE_URL`. The least-privilege `passwd_outbox_worker` role is preferred but not strictly required. **Source: Testing expert.**

**M7** — `withBypassRls` allowlist count cited as 76 in `docs/security/security-review.md` and `docs/security/threat-model.md`. Verified count from `scripts/checks/check-bypass-rls.mjs`: **77 entries** (`grep -c '"src/'`). **Source: Security expert.**

### Minor findings (8)

- `docs/architecture/extension-token-bridge.md:81` — DEPRECATED row already correctly applied; cosmetic only.
- `docs/operations/incident-runbook.md` — `REVOKE_SHARES=true` mentioned only in prose, not in the example `bash` block.
- `docs/setup/vercel/en.md:38` — `SHARE_MASTER_KEY` (V0) syntax used; could use the new `SHARE_MASTER_KEY_V<N>` versioned style.
- `docs/setup/docker/en.md:308` — line-number citation `src/lib/env-schema.ts:366-370` is a maintenance liability (will silently drift as the schema grows).
- `docs/security/session-timeout-design.md` — "in-process team-policy cache" wording could be clarified.
- `docs/operations/incident-runbook.md` — `audit-outbox-purge-failed` body example uses different fields than the one in `admin-tokens.md`; both are valid (different optional combinations).
- `docs/architecture/extension-token-bridge.md:205` — slightly vague "the postMessage column" phrasing.
- `docs/architecture/feature-gap-analysis.md:284` — CLI command list could be cross-checked against `cli/src/`.

### Recurring Issue Check (R1-R30)

Marked **not-applicable** for this docs-only diff. No source code, type signature, SQL, or test changes are present.

## Round 2 — fixes applied

All 5 Critical findings (C1-C4 fixed; C5 dispositioned as rejected) and all 7 Major findings (M1-M7) addressed. Minor findings deferred — see deviation log.

### Resolution summary

| Finding | Severity | Action | Modified file |
|---|---|---|---|
| C1 | Critical | Rewrote §3.4.1 Origin row to reflect `assertOrigin` rejecting missing Origin (403); restated residual risk; listed three pre-auth KEEP-inline exceptions | `docs/security/threat-model.md:117` |
| C2 | Critical | `/dashboard/tenant/operator-tokens` → `/admin/tenant/operator-tokens` | `docs/security/key-retention-policy.md:142` |
| C3 | Critical | Same URL fix; also clarified worker file path (entry vs implementation) | `docs/security/audit-preparation-checklist.md:39,41` |
| C4 | Critical | Removed "rotate secret"; clarified PATCH accepts only `isActive` | `docs/operations/audit-log-forwarding.md:214` |
| C5 | Critical | Dispositioned as rejected — 150+ matches the actual TS surface (165 entries) | (no change) |
| M1 | Major | Replaced 15-minute TTL claims with tenant-policy-driven framing | `docs/architecture/extension-token-bridge.md:11,82-85,201-202` |
| M2 | Major | Documented permanent tombstone loss during Sentinel failover window | `docs/operations/redis-ha.md:104` |
| M3 | Major | Added `HEALTH_REDIS_REQUIRED=true` recommendation | `docs/setup/azure/en.md:22`, `docs/setup/gcp/en.md:22` |
| M4 | Major | Re-framed TTL constants as hardcoded (not env-var configurable) | `docs/operations/redis-ha.md:44` |
| M5 | Major | Added Script options table; promoted `DRY_RUN=true` as the recommended preview | `docs/operations/admin-tokens.md:31-50` |
| M6 | Major | Changed "Required" → "Recommended" with fallback explanation | `docs/setup/vercel/en.md:81`, `docs/setup/azure/en.md:45`, `docs/setup/gcp/en.md:44` |
| M7 | Major | 76 → 77 (verified via `grep -c '"src/' scripts/checks/check-bypass-rls.mjs`) | `docs/security/security-review.md:261,294`, `docs/security/threat-model.md:79,81` |

### Deferred minor findings

Skipped in this PR; flagged for follow-up:
- `docs/setup/vercel/en.md` — switch `SHARE_MASTER_KEY` example to versioned `SHARE_MASTER_KEY_V1` form for consistency with deployment.md / incident-runbook.md.
- `docs/setup/docker/en.md` — drop the `src/lib/env-schema.ts:366-370` line-number citation (maintenance liability).
- `docs/operations/incident-runbook.md` — add `REVOKE_SHARES=true` to the example bash block.
- `docs/architecture/extension-token-bridge.md:205` — minor "postMessage column" rephrase.

## Out-of-scope follow-ups (separate PR)

These were identified during the audit but are outside the agreed scope (`README + docs/{architecture,operations,security,setup}/`):

1. `CLAUDE.md` references `/dashboard/tenant/operator-tokens` (wrong; should be `/admin/...`) in the admin scripts section.
2. `scripts/purge-history.sh`, `scripts/purge-audit-logs.sh`, `scripts/rotate-master-key.sh` header comments reference the same wrong URL.

Both are docs-style fixes living in different files. A short follow-up PR is recommended.

## Lint verification

`npm run lint` — passed (exit 0) before and after round 2 fixes.

## Build verification

Skipped intentionally — this is a documentation-only diff. No `*.ts` / `*.tsx` files changed; `npx next build` would not detect any markdown issue. Lint covers the only relevant code-touching surface (TypeScript), and lint passed.
