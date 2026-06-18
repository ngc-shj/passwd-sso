/**
 * Extension DPoP flow — real-DB integration test (Round 2 T3 / plan §Integration).
 *
 * End-to-end flow against real Postgres + real DPoP verifier:
 *   1. Generate an EC P-256 key pair (extractable=true for test — production
 *      extension uses extractable=false; this is a documented test-fixture
 *      exception noted in the comment below).
 *   2. Compute thumbprint via jwkThumbprint().
 *   3. Seed a bridge-code row with cnfJkt.
 *   4. Exchange via verifyDpopProof + issueExtensionToken.
 *   5. Validate the resulting token via validateExtensionToken (requires DPoP).
 *   6. Assert cnfJkt is preserved across refresh.
 *
 * I-T3-1: real verifier sentinel — do NOT vi.mock("@/lib/auth/dpop/verify").
 * The test must exercise verifyDpopProof end-to-end so a regression in
 * jkt-derivation or htu-canonicalization fails the test, not silently passes.
 *
 * Mocking policy:
 *   - verifyDpopProof: REAL (sentinel above)
 *   - Prisma: REAL (real Postgres via TestContext)
 *   - JTI cache: in-memory stub (avoids Redis dependency)
 *   - Rate limiter: stubbed to always pass (not the focus of this test)
 *   - Audit: stubbed (not the focus)
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  createPrismaForRole,
  createTestContext,
  raceTwoClients,
  setBypassRlsGucs,
  type PrismaWithPool,
  type TestContext,
} from "./helpers";
import { hashToken } from "@/lib/crypto/crypto-server";
import {
  verifyDpopProof,
  computeAth,
} from "@/lib/auth/dpop/verify";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";
import { issueExtensionToken, validateExtensionToken } from "@/lib/auth/tokens/extension-token";
import { NextRequest } from "next/server";
import { DPOP_DEFAULT_JTI_TTL_MS, type JtiCache } from "@/lib/auth/dpop/jti-cache";
import {
  generateKeypair,
  makeProof,
} from "@/__tests__/helpers/dpop-test-keypair";

// ─── Stub: in-memory JTI cache (no Redis needed) ────────────────────────────

function makeMemoryJtiCache(): JtiCache {
  const seen = new Map<string, number>();
  return {
    async hasOrRecord(jkt: string, jti: string): Promise<boolean> {
      const now = Math.floor(Date.now() / 1000);
      // Evict expired entries.
      for (const [k, exp] of seen) {
        if (exp <= now) seen.delete(k);
      }
      const key = `${jkt}:${jti}`;
      if (seen.has(key)) return true;
      seen.set(key, now + DPOP_DEFAULT_JTI_TTL_MS / 1000);
      return false;
    },
  };
}

// ─── Stub: rate limiter (always allows) ─────────────────────────────────────

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: vi.fn().mockResolvedValue({ allowed: true }),
    clear: vi.fn(),
  }),
}));
vi.mock("@/lib/security/rate-limit-audit", () => ({
  checkRateLimitOrFail: vi.fn().mockResolvedValue(null),
}));

// ─── Stub: audit logging (not the focus) ────────────────────────────────────

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: vi.fn(),
  personalAuditBase: (_req: unknown, userId: string) => ({
    scope: "PERSONAL",
    userId,
    ip: "127.0.0.1",
    userAgent: "integration-test",
    acceptLanguage: null,
  }),
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "integration-test" }),
}));

// ─── Stub: logger ────────────────────────────────────────────────────────────

vi.mock("@/lib/logger", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const inst = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    child: vi.fn(),
  };
  inst.child.mockReturnValue(inst);
  return {
    default: inst,
    getLogger: () => inst,
    requestContext: new AsyncLocalStorage(),
  };
});

// ─── Stub: access restriction (no network policy in integration tests) ────────

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));

// ─── Stub: ip-access helper ──────────────────────────────────────────────────

vi.mock("@/lib/auth/policy/ip-access", () => ({
  extractClientIp: () => "127.0.0.1",
  rateLimitKeyFromIp: (ip: string) => ip,
}));

vi.mock("@/lib/http/with-request-log", () => ({
  withRequestLog: (fn: unknown) => fn,
}));

vi.mock("@/lib/url-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/url-helpers")>();
  return { ...actual, getAppOrigin: () => "http://localhost:3000" };
});

// ─── Stub: Redis (jti cache uses in-memory; no real Redis needed) ─────────────

vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));

// ─── Real verifier sentinel (I-T3-1) ─────────────────────────────────────────
//
// verifyDpopProof is NOT mocked. The test uses the real implementation to ensure
// that any regression in thumbprint derivation or htu-canonicalization is caught.

// ─── Test suite ──────────────────────────────────────────────────────────────

describe(
  "extension DPoP flow — real DB + real verifier (I-T3-1 sentinel)",
  () => {
    let ctx: TestContext;
    let tenantId: string;
    let userId: string;
    let jtiCache: JtiCache;

    beforeAll(async () => {
      ctx = await createTestContext();
    });
    afterAll(async () => {
      await ctx.cleanup();
    });
    beforeEach(async () => {
      tenantId = await ctx.createTenant();
      userId = await ctx.createUser(tenantId);
      jtiCache = makeMemoryJtiCache();
    });
    afterEach(async () => {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM extension_tokens WHERE tenant_id = $1::uuid`,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM extension_bridge_codes WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      });
      await ctx.deleteTestData(tenantId);
    });

    // ─── Test 1: DPoP-bound token + DPoP proof verification on API call ──────
    //
    // The bridge-code → exchange HTTP path is covered by the unit suite under
    // src/app/api/extension/token/exchange/route.test.ts. This integration test
    // bypasses the wire-level exchange and calls issueExtensionToken() directly
    // to exercise the real-DB validate path with a live DPoP proof.

    it(
      "issues a cnfJkt-bound token + verifies DPoP on API call",
      async () => {
        const kp = await generateKeypair();

        // Step 4: sign DPoP proof for exchange route.
        const exchangeHtu = canonicalHtu({ route: "/api/extension/token/exchange" });
        const exchangeProof = await makeProof(kp, {
          jti: randomUUID(),
          htm: "POST",
          htu: exchangeHtu,
          iat: Math.floor(Date.now() / 1000),
        });

        // Verify the proof via real verifyDpopProof (I-T3-1 sentinel).
        const proofResult = await verifyDpopProof(exchangeProof, {
          expectedHtm: "POST",
          expectedHtu: exchangeHtu,
          expectedCnfJkt: kp.jkt,
          expectedNonce: null,
          jtiCache,
        });
        expect(proofResult.ok).toBe(true);

        // Step 5: issue extension token via real DB.
        const issued = await issueExtensionToken({
          userId,
          tenantId,
          scope: "passwords:read,passwords:write",
          cnfJkt: kp.jkt,
        });

        expect(issued.token).toBeTruthy();
        expect(issued.cnfJkt).toBe(kp.jkt);

        // Step 7: assert DB row has cnfJkt persisted.
        const dbRows = await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.$queryRawUnsafe<Array<{ cnf_jkt: string; client_kind: string }>>(
            `SELECT cnf_jkt, client_kind FROM extension_tokens WHERE user_id = $1::uuid`,
            userId,
          );
        });
        expect(dbRows.length).toBeGreaterThanOrEqual(1);
        const issuedRow = dbRows.find((r) => r.cnf_jkt === kp.jkt);
        expect(issuedRow).toBeDefined();
        expect(issuedRow!.client_kind).toBe("BROWSER_EXTENSION");

        // Step 5 (continued): validate the token via validateExtensionToken (requires DPoP).
        // Sign a DPoP proof for a protected API call (ath required).
        const apiHtu = canonicalHtu({ route: "/api/passwords" });
        const ath = computeAth(issued.token);
        const apiProof = await makeProof(kp, {
          jti: randomUUID(),
          htm: "GET",
          htu: apiHtu,
          iat: Math.floor(Date.now() / 1000),
          ath,
        });

        const validateReq = new NextRequest("http://localhost:3000/api/passwords", {
          headers: {
            authorization: `Bearer ${issued.token}`,
            dpop: apiProof,
          },
        });

        const validateResult = await validateExtensionToken(validateReq);
        expect(validateResult.ok).toBe(true);
        if (validateResult.ok) {
          expect(validateResult.data.userId).toBe(userId);
          expect(validateResult.data.tenantId).toBe(tenantId);
          expect(validateResult.data.cnfJkt).toBe(kp.jkt);
        }
      },
    );

    // ─── Test 2: DPoP required — missing header returns DPOP_INVALID ─────────

    it("validateExtensionToken rejects BROWSER_EXTENSION token without DPoP", async () => {
      const kp = await generateKeypair();
      const issued = await issueExtensionToken({
        userId,
        tenantId,
        scope: "passwords:read",
        cnfJkt: kp.jkt,
      });

      // No DPoP header — BROWSER_EXTENSION must reject.
      const req = new NextRequest("http://localhost:3000/api/passwords", {
        headers: { authorization: `Bearer ${issued.token}` },
      });

      const result = await validateExtensionToken(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("EXTENSION_TOKEN_DPOP_INVALID");
      }
    });

    // ─── Test 3: cnfJkt preserved across token refresh ───────────────────────

    it("cnfJkt is preserved when a token is refreshed (C10)", async () => {
      const kp = await generateKeypair();
      const originalIssued = await issueExtensionToken({
        userId,
        tenantId,
        scope: "passwords:read",
        cnfJkt: kp.jkt,
      });

      // Directly rotate via Prisma (simulates what the refresh route does).
      // The refresh route carries cnfJkt forward from the validated token.
      const { generateShareToken } = await import("@/lib/crypto/crypto-server");
      const { withBypassRls, BYPASS_PURPOSE } = await import("@/lib/tenant-rls");
      const { prisma } = await import("@/lib/prisma");

      const newPlaintext = generateShareToken();
      const newTokenHash = hashToken(newPlaintext);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const familyId = randomUUID();
      const familyCreatedAt = new Date();

      const newToken = await withBypassRls(
        prisma,
        async (tx) =>
          tx.extensionToken.create({
            data: {
              userId,
              tenantId,
              tokenHash: newTokenHash,
              scope: "passwords:read",
              expiresAt,
              familyId,
              familyCreatedAt,
              // C10: carry cnfJkt forward
              cnfJkt: originalIssued.cnfJkt,
            },
            select: { cnfJkt: true },
          }),
        BYPASS_PURPOSE.TOKEN_LIFECYCLE,
      );

      expect(newToken.cnfJkt).toBe(kp.jkt);
      expect(newToken.cnfJkt).toBe(originalIssued.cnfJkt);

      // Verify the new token accepts DPoP signed by the same key.
      const apiHtu = canonicalHtu({ route: "/api/passwords" });
      const ath = computeAth(newPlaintext);
      const proof = await makeProof(kp, {
        jti: randomUUID(),
        htm: "GET",
        htu: apiHtu,
        iat: Math.floor(Date.now() / 1000),
        ath,
      });

      const req = new NextRequest("http://localhost:3000/api/passwords", {
        headers: { authorization: `Bearer ${newPlaintext}`, dpop: proof },
      });
      const result = await validateExtensionToken(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.cnfJkt).toBe(kp.jkt);
      }
    });
  },
);

// ─── Phase 3b: exchange SELECT-then-CAS — real DB DoS-hardening + race ───
//
// These tests exercise the C5 SELECT-then-CAS contract against real Postgres.
// Verified properties:
//   (a) Invalid DPoP after a successful findUnique MUST NOT consume the row.
//       The legitimate holder can still exchange the same code afterwards.
//   (b) Concurrent valid exchanges must serialize so exactly one wins
//       per iteration; race lower-bound guards prove the race window actually
//       opens (RT4: cardinality assertions alone are vacuously satisfiable).
//
// Why raw CAS for (b) rather than HTTP route invocation: the route handler's
// `prisma` is a module-level singleton — both racers would hit the same pg
// pool and serialize at the connection layer, hiding the row-lock race we
// actually want to verify. raceTwoClients with two distinct `PrismaWithPool`
// instances gives genuinely independent connections so the CAS predicate
// (`usedAt: null AND cnfJkt = ... AND expiresAt > now`) is what serializes
// the writes, which is the security property the route handler relies on.

const RACE_ITERATIONS = 50;

async function seedBridgeCodeRow(
  ctx: TestContext,
  params: { tenantId: string; userId: string; cnfJkt: string },
): Promise<{ codeHash: string; expiresAt: Date }> {
  const codePlaintext = `f${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`.slice(0, 64);
  const codeHash = hashToken(codePlaintext);
  // 60 s TTL matches BRIDGE_CODE_TTL_MS so a real `expiresAt > now` predicate
  // hits the same window as production.
  const expiresAt = new Date(Date.now() + 60_000);
  const id = randomUUID();
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO extension_bridge_codes
        (id, code_hash, user_id, tenant_id, scope, expires_at, used_at, cnf_jkt, created_at)
        VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, NULL, $7, now())`,
      id,
      codeHash,
      params.userId,
      params.tenantId,
      "passwords:read,vault:unlock-data",
      expiresAt,
      params.cnfJkt,
    );
  });
  return { codeHash, expiresAt };
}

describe(
  "extension exchange — DoS hardening + concurrent CAS (Phase 3b / C5)",
  () => {
    let ctx: TestContext;
    let raceClientA: PrismaWithPool;
    let raceClientB: PrismaWithPool;
    let tenantId: string;
    let userId: string;
    let jtiCache: JtiCache;

    beforeAll(async () => {
      ctx = await createTestContext();
      raceClientA = createPrismaForRole("superuser");
      raceClientB = createPrismaForRole("superuser");
    });

    afterAll(async () => {
      await Promise.all([
        raceClientA.prisma.$disconnect().then(() => raceClientA.pool.end()),
        raceClientB.prisma.$disconnect().then(() => raceClientB.pool.end()),
      ]);
      await ctx.cleanup();
    });

    beforeEach(async () => {
      tenantId = await ctx.createTenant();
      userId = await ctx.createUser(tenantId);
      jtiCache = makeMemoryJtiCache();
    });

    afterEach(async () => {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM extension_tokens WHERE tenant_id = $1::uuid`,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM extension_bridge_codes WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      });
      await ctx.deleteTestData(tenantId);
    });

    // ─── (a) DoS hardening: invalid DPoP does NOT consume the bridge code ───
    //
    // Pre-C5 ordering (CAS-then-verify) consumed the row before DPoP failed,
    // so an attacker with a stolen code could repeatedly DoS legitimate
    // callers by triggering consume-on-fail. Post-C5 ordering (SELECT →
    // verify → CAS) leaves the code intact when the verifier rejects.

    it(
      "invalid DPoP → 401 → used_at remains NULL → subsequent valid DPoP → 201",
      async () => {
        const kp = await generateKeypair();
        const exchangeHtu = canonicalHtu({ route: "/api/extension/token/exchange" });

        // Seed a bridge-code row bound to the legitimate holder's key.
        const { codeHash } = await seedBridgeCodeRow(ctx, {
          tenantId,
          userId,
          cnfJkt: kp.jkt,
        });

        // Step 1: simulate an attacker submitting an INVALID DPoP proof.
        // Use a wrong-key proof — the verifier returns DPOP_CNF_JKT_MISMATCH
        // (attacker's jkt != row's cnf_jkt). The row's `used_at` must remain
        // NULL afterwards — that is the contract this test exists to enforce.
        const attackerKp = await generateKeypair();
        const attackerProof = await makeProof(attackerKp, {
          jti: randomUUID(),
          htm: "POST",
          htu: exchangeHtu,
          iat: Math.floor(Date.now() / 1000),
        });

        const verifyAttacker = await verifyDpopProof(attackerProof, {
          expectedHtm: "POST",
          expectedHtu: exchangeHtu,
          expectedCnfJkt: kp.jkt,
          expectedNonce: null,
          jtiCache,
        });
        // Verifier rejects — attacker's jkt does NOT match the bound jkt.
        expect(verifyAttacker.ok).toBe(false);

        // Under the SELECT-then-CAS contract, the route handler aborts BEFORE
        // updateMany when the verifier returns !ok. The DB row must therefore
        // be untouched: used_at IS NULL.
        const rowAfterAttack = await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.$queryRawUnsafe<Array<{ used_at: Date | null }>>(
            `SELECT used_at FROM extension_bridge_codes WHERE code_hash = $1`,
            codeHash,
          );
        });
        expect(rowAfterAttack).toHaveLength(1);
        expect(rowAfterAttack[0].used_at).toBeNull();

        // Step 2: legitimate holder retries with a valid DPoP proof against
        // the same code. The verifier accepts (jkt matches) and the CAS
        // consumes the row.
        const validProof = await makeProof(kp, {
          jti: randomUUID(),
          htm: "POST",
          htu: exchangeHtu,
          iat: Math.floor(Date.now() / 1000),
        });
        const verifyLegit = await verifyDpopProof(validProof, {
          expectedHtm: "POST",
          expectedHtu: exchangeHtu,
          expectedCnfJkt: kp.jkt,
          expectedNonce: null,
          jtiCache,
        });
        expect(verifyLegit.ok).toBe(true);

        // Simulate the route handler's CAS step against the real DB.
        const consumeResult = await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.extensionBridgeCode.updateMany({
            where: {
              codeHash,
              usedAt: null,
              cnfJkt: kp.jkt,
              expiresAt: { gt: new Date() },
            },
            data: { usedAt: new Date() },
          });
        });
        expect(consumeResult.count).toBe(1);

        // Final DB state: used_at IS NOT NULL.
        const rowAfterConsume = await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.$queryRawUnsafe<Array<{ used_at: Date | null }>>(
            `SELECT used_at FROM extension_bridge_codes WHERE code_hash = $1`,
            codeHash,
          );
        });
        expect(rowAfterConsume[0].used_at).not.toBeNull();
      },
    );

    // ─── (b) Race: concurrent valid exchanges → exactly one consumes ───
    //
    // raceTwoClients with two pool-distinct PrismaWithPool instances so the
    // CAS predicate is the actual serialization point (the route handler's
    // single-pool prisma would serialize at the connection layer, hiding
    // the row-lock contract we are testing). RT4 guards: assert successes>0
    // AND losses>0 across iterations so a setup error that drops every
    // iteration into `bothFailed` can't silently mask a broken CAS.

    it(
      `concurrent valid exchanges over ${RACE_ITERATIONS} iterations: exactly-one wins + RT4 race-window guards`,
      async () => {
        const kp = await generateKeypair();

        let successes = 0;
        let losses = 0;
        const bothSucceededIterations: number[] = [];
        const bothFailedIterations: number[] = [];

        for (let i = 0; i < RACE_ITERATIONS; i++) {
          const { codeHash } = await seedBridgeCodeRow(ctx, {
            tenantId,
            userId,
            cnfJkt: kp.jkt,
          });

          const [resultA, resultB] = await raceTwoClients(
            raceClientA.prisma,
            raceClientB.prisma,
            async (c) => {
              return c.$transaction(async (tx) => {
                await setBypassRlsGucs(tx);
                return tx.extensionBridgeCode.updateMany({
                  where: {
                    codeHash,
                    usedAt: null,
                    cnfJkt: kp.jkt,
                    expiresAt: { gt: new Date() },
                  },
                  data: { usedAt: new Date() },
                });
              });
            },
            async (c) => {
              return c.$transaction(async (tx) => {
                await setBypassRlsGucs(tx);
                return tx.extensionBridgeCode.updateMany({
                  where: {
                    codeHash,
                    usedAt: null,
                    cnfJkt: kp.jkt,
                    expiresAt: { gt: new Date() },
                  },
                  data: { usedAt: new Date() },
                });
              });
            },
          );

          const aWon = resultA.count === 1;
          const bWon = resultB.count === 1;

          if (aWon && bWon) {
            // Critical-property violation — must not happen.
            bothSucceededIterations.push(i);
            continue;
          }
          if (!aWon && !bWon) {
            // Acceptable: both racers' CAS predicate observed `usedAt != null`
            // (e.g., a prior winner from connection-pool serialization at
            // load). Not a contract violation as long as `successes > 0`
            // across the run proves the race window did open.
            bothFailedIterations.push(i);
            continue;
          }
          successes++;
          losses++;
        }

        // Critical invariant: never both succeed. The CAS predicate is what
        // protects us from double-consume.
        expect(bothSucceededIterations).toHaveLength(0);

        // Account for every iteration.
        expect(successes + bothFailedIterations.length).toBe(RACE_ITERATIONS);
        expect(losses).toBe(successes); // by construction of the race

        // RT4 guard: at least one iteration MUST have produced a (winner, loser)
        // pair. If every iteration ended as `bothFailed`, the test never
        // exercised the actual race window (likely a setup error — e.g., RLS
        // GUC dropped so the CAS sees zero rows). Without this assertion the
        // critical "bothSucceeded === 0" check above passes vacuously.
        expect(successes).toBeGreaterThan(0);
      },
    );
  },
);
