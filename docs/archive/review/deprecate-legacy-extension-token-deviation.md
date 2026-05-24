# Coding Deviation Log: deprecate-legacy-extension-token

## D-01 — `checkIpRateLimit` module location

**Plan reference**: C4 §Add mock blocks, specified:
```ts
vi.mock("@/lib/security/rate-limit-audit", () => ({
  checkIpRateLimit: mockCheckIpRateLimit,
  checkRateLimitOrFail: mockCheckRateLimit,
}));
```

**Reality**: `checkIpRateLimit` lives in `@/lib/security/ip-rate-limit`, NOT `@/lib/security/rate-limit-audit`. Verified via grep + actual import in [src/app/api/extension/token/exchange/route.ts:37](../../../src/app/api/extension/token/exchange/route.ts#L37) (`import { checkIpRateLimit } from "@/lib/security/ip-rate-limit"`).

**Applied implementation**: split the mock into two blocks — `vi.mock("@/lib/security/ip-rate-limit", ...)` for `checkIpRateLimit`, `vi.mock("@/lib/security/rate-limit-audit", ...)` for `checkRateLimitOrFail`. Functionally correct; the plan's single-block specification was a docs error.

**Severity**: None (plan accuracy fix).

## D-02 — T12 MAX_ACTIVE rotation test port

**Plan reference**: §6 TODOs T12 — required action before merge: Phase 2 reviewer must port the MAX_ACTIVE rotation test from the legacy route.test.ts to `exchange/route.test.ts` if absent there.

**Applied**: Phase 2 backend sub-agent verified absence in `exchange/route.test.ts` and ported the test (covers the `issueExtensionToken` rotation branch which remains live via the bridge flow). Adds ~23 lines to `exchange/route.test.ts`.

**Severity**: None (mandatory pre-merge action completed).

## D-03 — Migration application method

**Plan reference**: §file matrix #5 — "PostgreSQL forbids ALTER TYPE … ADD VALUE inside a transaction; Prisma generates this migration as a single non-transactional statement."

**Reality**: `npm run db:migrate` (Prisma migrate dev) detected drift in the local dev DB and required manual intervention. The backend sub-agent applied the migration via `npx prisma db execute` + `npx prisma migrate resolve --applied`, then `npx prisma generate` to refresh the client.

**Severity**: None (operational; the migration file content is correct — `ALTER TYPE … ADD VALUE IF NOT EXISTS` — and will apply cleanly in CI / fresh environments via `prisma migrate deploy`).

**Defensive addition**: the migration uses `IF NOT EXISTS` (defensive against re-application), an improvement over the spec.

## D-04 — Additional CliTokenCard locator cleanup

**Plan reference**: file matrix #19 — "Remove `gotoCliToken()` method (lines 28-29)."

**Applied**: frontend sub-agent also removed the unused `cliTokenCard` Locator property (lines 53-57 of the original file) since it was dead code with no callers in any E2E spec (grep-confirmed). Strictly additive to the plan's cleanup objective; no behavioural change.

**Severity**: None (additive cleanup).

## Pre-existing test failures NOT introduced by this PR

6 tests fail in `src/app/api/admin/rotate-master-key/[rotationId]/execute/route.test.ts` — verified pre-existing on `main` (independent of this PR). Last touched on main by commit `d9496e60 security: OWASP batch 3 tail (C21 / A02-8 / A07-4 / A06-2 / A04-4 / A04-7)`. Out of scope for this PR; tracked separately for the OWASP batch follow-up.

**Anti-Deferral check**: out of scope (different feature — master key rotation). Cost-to-fix: unknown (requires understanding the OWASP batch 3 changes); the rotate-master-key tests touch a completely separate code path with no overlap to the extension token deprecation. Filing a separate issue / TODO is appropriate.
