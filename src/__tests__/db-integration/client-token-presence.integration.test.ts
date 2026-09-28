/**
 * long-lived-client-login (B1a) — real-DB integration tests for C2/C4/C5.
 *
 * Mocking policy mirrors extension-token-dpop-flow.integration.test.ts:
 *   - verifyDpopProof / Prisma: REAL (both extension routes under test
 *     require a real DPoP proof for a BROWSER_EXTENSION token, and the
 *     presence/expiry math is read straight off real rows). The JTI cache
 *     used internally falls back to in-memory when Redis is unavailable
 *     (mocked below) — no separate stub needed.
 *   - Rate limiter, audit, access-restriction, ip-access, logger: stubbed —
 *     not the focus of these tests.
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
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { hashToken, generateShareToken } from "@/lib/crypto/crypto-server";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";
import { computeAth } from "@/lib/auth/dpop/verify";
import { issueExtensionToken } from "@/lib/auth/tokens/extension-token";
import { getFamilyPresenceAt } from "@/lib/auth/tokens/client-token-expiry";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { prisma } from "@/lib/prisma";
import { generateKeypair, makeProof, type TestKeypair } from "@/__tests__/helpers/dpop-test-keypair";

// No JTI-cache stub needed: getJtiCache() (used internally by
// validateExtensionTokenDpop, via the real, unmocked verifyDpopProof path)
// already falls back to an in-memory store when getRedis() returns null —
// see the @/lib/redis mock below.

// checkAuth (C2 route) tries an Auth.js session before falling through to
// the Bearer token — every request here is cookieless, so a bare "no
// session" stub is sufficient. Mocked (not real) because next-auth's `auth()`
// does not run outside a real Next.js request context.
const mockAuth = vi.fn().mockResolvedValue(null);
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: vi.fn().mockResolvedValue({ allowed: true }),
    clear: vi.fn(),
  }),
}));

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

vi.mock("@/lib/logger", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const inst = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), child: vi.fn() };
  inst.child.mockReturnValue(inst);
  return {
    default: inst,
    getLogger: () => inst,
    requestContext: new AsyncLocalStorage(),
  };
});

vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: vi.fn().mockResolvedValue(null),
}));

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

vi.mock("@/lib/redis", () => ({
  getRedis: () => null,
  validateRedisConfig: () => {},
}));

import { POST as refreshPOST } from "@/app/api/extension/token/refresh/route";
import { POST as verifyPOST } from "@/app/api/vault/unlock/verify/route";

async function seedVault(ctx: TestContext, userId: string, authHash: string) {
  const salt = "b".repeat(64);
  const serverHash = createHash("sha256").update(authHash + salt).digest("hex");
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE users SET vault_setup_at = now(), master_password_server_hash = $2, master_password_server_salt = $3 WHERE id = $1::uuid`,
      userId,
      serverHash,
      salt,
    );
  });
}

async function issueDpopBoundToken(params: {
  userId: string;
  tenantId: string;
  scope?: string;
}) {
  const kp = await generateKeypair();
  const issued = await issueExtensionToken({
    userId: params.userId,
    tenantId: params.tenantId,
    scope: params.scope ?? "passwords:read,vault:unlock-data",
    cnfJkt: kp.jkt,
  });
  return { kp, issued };
}

async function signedRequest(params: {
  kp: TestKeypair;
  token: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}): Promise<NextRequest> {
  const htu = canonicalHtu({ route: params.path });
  const ath = computeAth(params.token);
  const proof = await makeProof(params.kp, {
    jti: randomUUID(),
    htm: params.method,
    htu,
    iat: Math.floor(Date.now() / 1000),
    ath,
  });
  return new NextRequest(`http://localhost:3000${params.path}`, {
    method: params.method,
    headers: {
      authorization: `Bearer ${params.token}`,
      dpop: proof,
      ...(params.body ? { "content-type": "application/json" } : {}),
    },
    body: params.body ? JSON.stringify(params.body) : undefined,
  });
}

describe("long-lived-client-login B1a — real-DB integration", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });
  afterEach(async () => {
    // Extension tokens FK-Restrict their tenant; drop them before
    // deleteTestData()'s tenant/user cleanup (mirrors
    // extension-token-dpop-flow.integration.test.ts).
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM extension_tokens WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  // ─── C4: deterministic presence sequence (no timing race) ────────────────

  describe("C4: getFamilyPresenceAt", () => {
    it("returns the MAX(lastPresenceAt) across the family INCLUDING a revoked row", async () => {
      const familyId = randomUUID();
      const familyCreatedAt = new Date(Date.now() - 60_000);

      // (1) Create family row A.
      const tokenAHash = hashToken(generateShareToken());
      await withBypassRls(prisma, async (tx) =>
        tx.extensionToken.create({
          data: {
            userId,
            tenantId,
            tokenHash: tokenAHash,
            scope: "passwords:read",
            expiresAt: new Date(Date.now() + 3_600_000),
            familyId,
            familyCreatedAt,
            // BROWSER_EXTENSION rows require cnfJkt NOT NULL (DB CHECK
            // constraint); no real DPoP key needed for this pure-DB test.
            cnfJkt: "A".repeat(43),
          },
        }),
      BYPASS_PURPOSE.TOKEN_LIFECYCLE);

      // (2) Rotate A → B: revoke A, create B carrying the family forward.
      const p0 = new Date(Date.now() - 30_000);
      await withBypassRls(prisma, async (tx) => {
        await tx.extensionToken.updateMany({
          where: { tokenHash: tokenAHash },
          data: { revokedAt: new Date(), lastPresenceAt: p0 },
        });
        return tx.extensionToken.create({
          data: {
            userId,
            tenantId,
            tokenHash: hashToken(generateShareToken()),
            scope: "passwords:read",
            expiresAt: new Date(Date.now() + 3_600_000),
            familyId,
            familyCreatedAt,
            lastPresenceAt: p0,
            cnfJkt: "A".repeat(43),
          },
        });
      }, BYPASS_PURPOSE.TOKEN_LIFECYCLE);

      // (3) Write a NEWER presence directly onto the now-revoked row A —
      // simulating a presence write landing on a row that was concurrently
      // rotated out from under it.
      const p1 = new Date(Date.now() - 5_000);
      await withBypassRls(prisma, async (tx) =>
        tx.extensionToken.updateMany({
          where: { tokenHash: tokenAHash },
          data: { lastPresenceAt: p1 },
        }),
      BYPASS_PURPOSE.TOKEN_LIFECYCLE);

      // (4) getFamilyPresenceAt must return p1 (the true max), not p0 — which
      // requires the query to NOT filter revokedAt: null. A revokedAt filter
      // would see only B's p0 and silently drop the newer p1 written to the
      // revoked row A.
      const presence = await withBypassRls(prisma, async (tx) =>
        getFamilyPresenceAt(tx, familyId, familyCreatedAt),
      BYPASS_PURPOSE.TOKEN_LIFECYCLE);
      expect(presence.getTime()).toBe(p1.getTime());
      expect(presence.getTime()).toBeGreaterThan(p0.getTime());
    });

    it("falls back to familyCreatedAt when no row in the family has ever recorded presence", async () => {
      const familyId = randomUUID();
      const familyCreatedAt = new Date(Date.now() - 120_000);
      await withBypassRls(prisma, async (tx) =>
        tx.extensionToken.create({
          data: {
            userId,
            tenantId,
            tokenHash: hashToken(generateShareToken()),
            scope: "passwords:read",
            expiresAt: new Date(Date.now() + 3_600_000),
            familyId,
            familyCreatedAt,
            cnfJkt: "A".repeat(43),
          },
        }),
      BYPASS_PURPOSE.TOKEN_LIFECYCLE);

      const presence = await withBypassRls(prisma, async (tx) =>
        getFamilyPresenceAt(tx, familyId, familyCreatedAt),
      BYPASS_PURPOSE.TOKEN_LIFECYCLE);
      expect(presence.getTime()).toBe(familyCreatedAt.getTime());
    });
  });

  // ─── C5/FR1: extension refresh with no `sessions` row for the user ───────

  it("extension token refresh succeeds with no Auth.js session row for the user", async () => {
    const { kp, issued } = await issueDpopBoundToken({ userId, tenantId });

    // No row in `sessions` exists for this user at all — the old code path
    // required `prisma.session.findFirst` to return a live row; C5 removes
    // that dependency entirely.
    const sessionCount = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM sessions WHERE user_id = $1::uuid`,
        userId,
      );
    });
    expect(Number(sessionCount[0]!.count)).toBe(0);

    const req = await signedRequest({
      kp,
      token: issued.token,
      method: "POST",
      path: "/api/extension/token/refresh",
    });
    const res = await refreshPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(issued.token);
  });

  // ─── C2: POST /api/vault/unlock/verify end-to-end with a real token row ──

  describe("C2: unlock/verify end-to-end", () => {
    const AUTH_HASH = "a".repeat(64);
    const WRONG_AUTH_HASH = "c".repeat(64);

    it("records presence (lastPresenceAt) on the presenting row without touching expiresAt", async () => {
      await seedVault(ctx, userId, AUTH_HASH);
      const { kp, issued } = await issueDpopBoundToken({ userId, tenantId });

      // Issuance itself already stamps lastPresenceAt = issuance time; back it
      // off so a genuine verify-driven advance is distinguishable from noise.
      const tokenHash = hashToken(issued.token);
      const issuancePresence = new Date(Date.now() - 60_000);
      await withBypassRls(prisma, async (tx) =>
        tx.extensionToken.updateMany({
          where: { tokenHash },
          data: { lastPresenceAt: issuancePresence },
        }),
      BYPASS_PURPOSE.TOKEN_LIFECYCLE);

      const before = await withBypassRls(prisma, async (tx) =>
        tx.extensionToken.findUnique({ where: { tokenHash } }),
      BYPASS_PURPOSE.TOKEN_LIFECYCLE);
      expect(before?.lastPresenceAt?.getTime()).toBe(issuancePresence.getTime());

      const req = await signedRequest({
        kp,
        token: issued.token,
        method: "POST",
        path: "/api/vault/unlock/verify",
        body: { authHash: AUTH_HASH },
      });
      const res = await verifyPOST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ verified: true });

      const after = await withBypassRls(prisma, async (tx) =>
        tx.extensionToken.findUnique({ where: { tokenHash } }),
      BYPASS_PURPOSE.TOKEN_LIFECYCLE);
      expect(after!.lastPresenceAt!.getTime()).toBeGreaterThan(issuancePresence.getTime());
      expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    });

    it("wrong hash returns 422 and leaves the row's lastPresenceAt untouched", async () => {
      await seedVault(ctx, userId, AUTH_HASH);
      const { kp, issued } = await issueDpopBoundToken({ userId, tenantId });
      const tokenHash = hashToken(issued.token);

      const before = await withBypassRls(prisma, async (tx) =>
        tx.extensionToken.findUnique({ where: { tokenHash } }),
      BYPASS_PURPOSE.TOKEN_LIFECYCLE);

      const req = await signedRequest({
        kp,
        token: issued.token,
        method: "POST",
        path: "/api/vault/unlock/verify",
        body: { authHash: WRONG_AUTH_HASH },
      });
      const res = await verifyPOST(req);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("AUTH_HASH_MISMATCH");

      const after = await withBypassRls(prisma, async (tx) =>
        tx.extensionToken.findUnique({ where: { tokenHash } }),
      BYPASS_PURPOSE.TOKEN_LIFECYCLE);
      expect(after!.lastPresenceAt!.getTime()).toBe(before!.lastPresenceAt!.getTime());
    });
  });
});
