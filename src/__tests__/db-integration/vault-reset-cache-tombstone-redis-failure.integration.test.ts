/**
 * Integration test (real DB + faulty Redis): vault reset under Redis outage.
 *
 * Verifies the audit-trail invariant added in PR #431:
 *
 *   - Postgres-side revocation (Session/ExtensionToken/ApiKey/Mcp* delete +
 *     revokedAt) is durable even when the Redis tombstone write fails.
 *   - The returned `cacheTombstoneFailures` count equals the number of
 *     session tokens whose tombstone did NOT land — surfaced into audit
 *     metadata by VAULT_RESET_EXECUTED / ADMIN_VAULT_RESET_EXECUTE so a
 *     silent Redis outage during reset is forensically visible.
 *
 * The Redis client is a real ioredis instance pointed at a non-listening
 * port so every command fails at the network layer — no mocking of the
 * production helper code path. The DB layer is real Postgres.
 *
 * Run: docker compose up -d db && npm run test:integration -- \
 *      vault-reset-cache-tombstone-redis-failure.integration
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
import IORedis from "ioredis";
import { randomUUID } from "node:crypto";

// A real ioredis client pointed at a port nothing listens on. With
// enableOfflineQueue:false + retryStrategy:null, every command fails
// immediately at the network layer instead of being queued for retry.
// The mock returns this client wherever the production code calls
// `getRedis()`, so invalidateCachedSession*'s try/catch path is exercised
// faithfully — only the underlying socket is "broken", not the helper.
const faultyRedis = new IORedis({
  host: "127.0.0.1",
  port: 1,
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  connectTimeout: 100,
});
faultyRedis.on("error", () => {});

vi.mock("@/lib/redis", () => ({
  getRedis: () => faultyRedis,
  validateRedisConfig: () => {},
}));

import { invalidateUserSessions } from "@/lib/auth/session/user-session-invalidation";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";

const dbAvailable = !!process.env.MIGRATION_DATABASE_URL;

describe.skipIf(!dbAvailable)(
  "vault reset under Redis outage (real DB + faulty Redis)",
  () => {
    let ctx: TestContext;
    let tenantId: string;
    let userId: string;

    beforeAll(async () => {
      ctx = await createTestContext();
    });

    afterAll(async () => {
      faultyRedis.disconnect(false);
      await ctx.cleanup();
    });

    beforeEach(async () => {
      tenantId = await ctx.createTenant();
      userId = await ctx.createUser(tenantId);
    });

    afterEach(async () => {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM sessions WHERE user_id = $1::uuid`,
          userId,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM tenant_members WHERE user_id = $1::uuid`,
          userId,
        );
      });
      await ctx.deleteTestData(tenantId);
    });

    async function insertSession(): Promise<string> {
      const token = `sess-${randomUUID()}-${Math.random().toString(36).slice(2)}`;
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO sessions (
             id, session_token, user_id, tenant_id, expires,
             created_at, last_active_at
           ) VALUES (
             $1::uuid, $2, $3::uuid, $4::uuid,
             now() + interval '1 day', now(), now()
           )`,
          randomUUID(),
          token,
          userId,
          tenantId,
        );
      });
      return token;
    }

    it(
      "Postgres delete is durable, cacheTombstoneFailures equals session " +
        "count when Redis is unreachable",
      async () => {
        await insertSession();
        await insertSession();
        await insertSession();

        const result = await invalidateUserSessions(userId, { tenantId });

        // DB-side rows truly deleted (Postgres transaction committed).
        expect(result.sessions).toBe(3);
        const remaining = await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.session.count({ where: { userId } });
        });
        expect(remaining).toBe(0);

        // Redis tombstones all failed — surface the count into the result
        // so the route handler can land it in audit metadata.
        expect(result.cacheTombstoneFailures).toBe(3);
      },
    );

    it(
      "no sessions to delete: cacheTombstoneFailures: 0 (no Redis call " +
        "attempted, so no failure can be observed)",
      async () => {
        const result = await invalidateUserSessions(userId, { tenantId });
        expect(result.sessions).toBe(0);
        expect(result.cacheTombstoneFailures).toBe(0);
      },
    );
  },
);
