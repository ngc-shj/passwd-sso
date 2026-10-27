/**
 * Session passkey gate — real-DB + real-Redis integration
 * (session-api-passkey-gate plan, Testing → Integration; T9, T-R3-9, T-R4-3).
 *
 *   (a) `POST /api/webauthn/register/verify` (verifyRegistration stubbed)
 *       tombstones the cached sessions of the registering user — across
 *       tenants, since `hasPasskey` counts a passkey under any tenant — on
 *       success only, and never another user's entry. The caller's session is
 *       a real Session row with a recent createdAt, so the route's D5 recency
 *       check passes on a fresh sign-in.
 *   (b) Two independently loaded gate modules refusing the same
 *       `userId:blockedPath` write exactly one `audit_outbox` row: the bound is
 *       the Redis-shared limiter, which two separate in-memory fallbacks
 *       could not provide.
 *
 * Under CI a missing REDIS_URL fails (a skip is not a pass); locally it skips.
 *
 * Mocking policy:
 *   - `@/auth`: the session boundary (next-auth's `auth()` does not run
 *     outside a Next.js request); it resolves the seeded user.
 *   - `verifyRegistration`: the attestation, which needs a real authenticator.
 *   - `@/lib/security/rate-limit`: REAL, every limiter with
 *     `failClosedOnRedisError: false`.
 *   - Everything else (passkey state, recency, invalidation, session cache,
 *     audit outbox): REAL.
 *
 * Run (the outbox worker must not share this database — see CLAUDE.md):
 *   docker compose stop audit-outbox-worker retention-gc-worker
 *   npm run test:integration -- session-passkey-gate
 *   docker compose start audit-outbox-worker retention-gc-worker
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { NextRequest } from "next/server";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import {
  hashSessionToken,
  setCachedSession,
  SESSION_CACHE_KEY_PREFIX,
  SESSION_CACHE_TTL_MS,
  type SessionInfo,
} from "@/lib/auth/session/session-cache";
import { generateChallengeId } from "@/lib/auth/webauthn/webauthn-server";
import { getRedis } from "@/lib/redis";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { MS_PER_DAY } from "@/lib/constants/time";

const hasDatabase = !!process.env.DATABASE_URL;
const redisAvailable = !!process.env.REDIS_URL;
const runsUnderCi = !!process.env.CI;

const APP_ORIGIN = "http://localhost:3000";
const GRACE_DAYS = 7;

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));

const mockVerifyRegistration = vi.fn();
vi.mock("@/lib/auth/webauthn/webauthn-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/webauthn/webauthn-server")>()),
  verifyRegistration: (...args: unknown[]) => mockVerifyRegistration(...args),
}));

vi.mock("@/lib/security/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security/rate-limit")>();
  return {
    ...actual,
    createRateLimiter: (options: Parameters<typeof actual.createRateLimiter>[0]) =>
      actual.createRateLimiter({ ...options, failClosedOnRedisError: false }),
  };
});

import { POST as registerVerifyPOST } from "@/app/api/webauthn/register/verify/route";

// A skip under CI would read as a pass; only a local run without the services skips.
describe.skipIf(!runsUnderCi && (!hasDatabase || !redisAvailable))(
  "session passkey gate (real DB + Redis)",
  () => {
    let ctx: TestContext;
    let redis: Redis;
    let tenantIds: string[];
    let userIds: string[];
    let cacheKeys: string[];

    beforeAll(async () => {
      if (!hasDatabase || !redisAvailable) {
        throw new Error("DATABASE_URL and REDIS_URL are required under CI: this suite must not skip");
      }
      ctx = await createTestContext();
      const r = getRedis();
      if (!r) throw new Error("getRedis() returned null despite REDIS_URL being set — check redis.ts");
      redis = r;
    });

    afterAll(async () => {
      await ctx?.cleanup();
    });

    beforeEach(() => {
      vi.stubEnv("AUTH_URL", APP_ORIGIN);
      vi.stubEnv("APP_URL", APP_ORIGIN);
      vi.stubEnv("WEBAUTHN_RP_ID", "localhost");
      tenantIds = [];
      userIds = [];
      cacheKeys = [];
      mockAuth.mockReset();
      mockVerifyRegistration.mockReset();
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      for (const key of cacheKeys) await redis.del(key);
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        for (const table of ["sessions", "webauthn_credentials"]) {
          await tx.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[]) OR user_id = ANY($2::uuid[])`,
            tenantIds,
            userIds,
          );
        }
      });
      for (const id of tenantIds) await ctx.deleteTestData(id);
    });

    // ─── Seeders ─────────────────────────────────────────────────

    async function newTenant(): Promise<string> {
      const id = await ctx.createTenant();
      tenantIds.push(id);
      return id;
    }

    async function newUser(tenantId: string): Promise<string> {
      const id = await ctx.createUser(tenantId);
      userIds.push(id);
      return id;
    }

    /** Required, grace period expired one day ago: a member with no passkey is blocked. */
    async function requirePasskeyPastGrace(tenantId: string): Promise<void> {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `UPDATE tenants
              SET require_passkey = true,
                  require_passkey_enabled_at = $2,
                  passkey_grace_period_days = $3
            WHERE id = $1::uuid`,
          tenantId,
          new Date(Date.now() - (GRACE_DAYS + 1) * MS_PER_DAY),
          GRACE_DAYS,
        );
      });
    }

    /** A live Session row created now (a fresh sign-in); returns the raw cookie token. */
    async function insertSession(userId: string, tenantId: string): Promise<string> {
      const token = randomUUID();
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO sessions (
             id, session_token, user_id, tenant_id, expires, created_at, last_active_at, provider
           ) VALUES (
             $1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now(), 'google'
           )`,
          randomUUID(),
          hashSessionToken(token),
          userId,
          tenantId,
        );
      });
      return token;
    }

    function cacheKey(token: string): string {
      const key = `${SESSION_CACHE_KEY_PREFIX}${hashSessionToken(token)}`;
      cacheKeys.push(key);
      return key;
    }

    /** Prime the proxy's session cache for `token` with a blocked, valid entry. */
    async function primeCache(token: string, userId: string, tenantId: string): Promise<string> {
      const entry: SessionInfo = {
        valid: true,
        userId,
        tenantId,
        hasPasskey: false,
        requirePasskey: true,
        requirePasskeyEnabledAt: new Date(Date.now() - (GRACE_DAYS + 1) * MS_PER_DAY).toISOString(),
        passkeyGracePeriodDays: GRACE_DAYS,
        passkeyStateDegraded: false,
      };
      await setCachedSession(token, entry, SESSION_CACHE_TTL_MS);
      const key = cacheKey(token);
      const raw = await redis.get(key);
      expect(raw, "the primed entry must be in Redis before the call").not.toBeNull();
      return raw as string;
    }

    async function storeChallenge(userId: string): Promise<string> {
      const challengeId = generateChallengeId();
      const key = `webauthn:challenge:register:${userId}:${challengeId}`;
      cacheKeys.push(key);
      await redis.set(key, JSON.stringify({ challenge: "test-challenge", prfSalt: null }), "PX", 60_000);
      return challengeId;
    }

    function verifyRequest(token: string, challengeId: string): NextRequest {
      return new NextRequest(`${APP_ORIGIN}/api/webauthn/register/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: APP_ORIGIN,
          cookie: `authjs.session-token=${token}`,
        },
        body: JSON.stringify({
          challengeId,
          response: { id: "cred", response: { transports: ["internal"] }, clientExtensionResults: {} },
        }),
      });
    }

    function verified(credentialId: string) {
      return {
        verified: true,
        registrationInfo: {
          credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0 },
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
        },
      };
    }

    // ─── (a) register/verify invalidates the user's cache, cross-tenant ───

    describe("register/verify session-cache invalidation", () => {
      let homeTenant: string;
      let otherTenant: string;
      let userId: string;
      let otherUserId: string;
      let homeToken: string;
      let otherTenantToken: string;
      let otherUserToken: string;
      let primed: { home: string; otherTenant: string; otherUser: string };

      beforeEach(async () => {
        homeTenant = await newTenant();
        otherTenant = await newTenant();
        await requirePasskeyPastGrace(homeTenant);
        userId = await newUser(homeTenant);
        otherUserId = await newUser(homeTenant);
        // The caller's session (a fresh sign-in), and the same user's session
        // under another tenant.
        homeToken = await insertSession(userId, homeTenant);
        otherTenantToken = await insertSession(userId, otherTenant);
        otherUserToken = await insertSession(otherUserId, homeTenant);
        primed = {
          home: await primeCache(homeToken, userId, homeTenant),
          otherTenant: await primeCache(otherTenantToken, userId, otherTenant),
          otherUser: await primeCache(otherUserToken, otherUserId, homeTenant),
        };
        mockAuth.mockResolvedValue({ user: { id: userId } });
      });

      it("tombstones both of the user's sessions, under different tenants, on success", async () => {
        mockVerifyRegistration.mockResolvedValue(verified(`cred-${randomUUID()}`));
        const res = await registerVerifyPOST(verifyRequest(homeToken, await storeChallenge(userId)));
        expect(res.status, await res.clone().text()).toBe(201);

        const tombstone = { tombstone: true };
        expect(JSON.parse((await redis.get(cacheKey(homeToken))) as string)).toStrictEqual(tombstone);
        expect(JSON.parse((await redis.get(cacheKey(otherTenantToken))) as string)).toStrictEqual(tombstone);
      });

      it("leaves another user's entry untouched on success", async () => {
        mockVerifyRegistration.mockResolvedValue(verified(`cred-${randomUUID()}`));
        const res = await registerVerifyPOST(verifyRequest(homeToken, await storeChallenge(userId)));
        expect(res.status).toBe(201);
        expect(await redis.get(cacheKey(otherUserToken))).toBe(primed.otherUser);
      });

      it("leaves every entry untouched when verification fails", async () => {
        mockVerifyRegistration.mockResolvedValue({ verified: false });
        const res = await registerVerifyPOST(verifyRequest(homeToken, await storeChallenge(userId)));
        expect(res.status).toBe(400);
        expect(await redis.get(cacheKey(homeToken))).toBe(primed.home);
        expect(await redis.get(cacheKey(otherTenantToken))).toBe(primed.otherTenant);
        expect(await redis.get(cacheKey(otherUserToken))).toBe(primed.otherUser);
      });
    });

    // ─── (b) the audit bound is shared across gate instances ───

    describe("blocked-request audit bound across processes", () => {
      async function blockedRowsFor(userId: string, tenantId: string): Promise<{ blockedPath: unknown }[]> {
        const rows = await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.$queryRawUnsafe<{ payload: Record<string, unknown> }[]>(
            `SELECT payload FROM audit_outbox
              WHERE tenant_id = $1::uuid
                AND payload->>'action' = $2
                AND payload->>'userId' = $3`,
            tenantId,
            AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
            userId,
          );
        });
        // A PERSONAL row is invisible to the tenant audit log, where this
        // admin-group action is listed; every row must be TENANT-scoped.
        expect(rows.map((r) => r.payload.scope)).toEqual(rows.map(() => AUDIT_SCOPE.TENANT));
        return rows.map((r) => ({
          blockedPath: (r.payload.metadata as Record<string, unknown> | undefined)?.blockedPath,
        }));
      }

      /** A freshly evaluated copy of the gate module, with its own in-memory limiter fallback. */
      async function loadGateInstance() {
        vi.resetModules();
        return import("@/lib/proxy/session-passkey-gate");
      }

      function blockedRequest(path: string): NextRequest {
        return new NextRequest(`${APP_ORIGIN}${path}`, { headers: { origin: APP_ORIGIN } });
      }

      it("two gate instances refusing the same userId:blockedPath write exactly one outbox row", async () => {
        const tenantId = await newTenant();
        const userId = await newUser(tenantId);
        const first = await loadGateInstance();
        const second = await loadGateInstance();
        expect(second).not.toBe(first);

        const blockedPath = first.blockedPath("GET", "/api/passwords");
        const limiterKey = `rl:passkey_session_gate_audit:${userId}:${blockedPath}`;
        cacheKeys.push(limiterKey);

        await first.auditSessionPasskeyBlock({ req: blockedRequest("/api/passwords"), userId, tenantId, blockedPath });
        await second.auditSessionPasskeyBlock({ req: blockedRequest("/api/passwords"), userId, tenantId, blockedPath });

        expect(await blockedRowsFor(userId, tenantId)).toEqual([{ blockedPath: "GET /api/passwords" }]);
        // Both instances counted in the one Redis key; neither fell back to memory.
        expect(await redis.get(limiterKey)).toBe("2");
      });

      it("control: the second instance does write a row for a different blockedPath", async () => {
        const tenantId = await newTenant();
        const userId = await newUser(tenantId);
        const first = await loadGateInstance();
        const second = await loadGateInstance();
        const passwords = first.blockedPath("GET", "/api/passwords");
        const vault = second.blockedPath("GET", "/api/vault/status");
        cacheKeys.push(
          `rl:passkey_session_gate_audit:${userId}:${passwords}`,
          `rl:passkey_session_gate_audit:${userId}:${vault}`,
        );

        await first.auditSessionPasskeyBlock({ req: blockedRequest("/api/passwords"), userId, tenantId, blockedPath: passwords });
        await second.auditSessionPasskeyBlock({ req: blockedRequest("/api/vault/status"), userId, tenantId, blockedPath: vault });

        const paths = (await blockedRowsFor(userId, tenantId)).map((r) => r.blockedPath).sort();
        expect(paths).toEqual(["GET /api/passwords", "GET /api/vault"]);
      });
    });
  },
);
