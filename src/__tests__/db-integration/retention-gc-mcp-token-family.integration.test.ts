/**
 * Real-DB family-aware GC tests for mcp_access_tokens (SC5 / C5).
 *
 * The MCP_TOKEN_FAMILY_DEAD guard must hold the deletion of an expired access
 * token until no live refresh token OR delegation session references it; the FK
 * ON DELETE CASCADE then removes the dead children. The negative tests assert the
 * LIVE CHILD ROW SURVIVES the sweep (not just the parent count) so removing the
 * guard flips them red (the cascade would destroy the live child — RT7/T1).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { sweepOnce } from "@/workers/retention-gc-worker/sweep";

describe("retention-gc mcp_access_tokens family-aware GC (SC5/C5)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let clientId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    clientId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_clients (id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_dcr, tenant_id, created_at, updated_at)
         VALUES ($1::uuid, $2, 'hash', 'fam-test', '{}', 'credentials:list', false, $3::uuid, now(), now())`,
        clientId,
        `cl-${clientId.slice(0, 12)}`,
        tenantId,
      );
    });
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  async function insertAccessToken(expiresAt: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_access_tokens (id, token_hash, client_id, tenant_id, user_id, scope, expires_at, created_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'credentials:list', ${expiresAt}, now())`,
        id,
        `ath-${id.slice(0, 16)}`,
        clientId,
        tenantId,
        userId,
      );
    });
    return id;
  }

  async function insertRefreshToken(
    accessTokenId: string,
    expiresAt: string,
    revoked: boolean,
  ): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_refresh_tokens (id, token_hash, family_id, access_token_id, client_id, tenant_id, user_id, scope, expires_at, revoked_at, created_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, 'credentials:list', ${expiresAt}, ${revoked ? "now()" : "NULL"}, now())`,
        id,
        `rth-${id.slice(0, 16)}`,
        randomUUID(),
        accessTokenId,
        clientId,
        tenantId,
        userId,
      );
    });
    return id;
  }

  async function insertDelegationSession(
    accessTokenId: string,
    expiresAt: string,
    revoked: boolean,
  ): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO delegation_sessions (id, tenant_id, user_id, mcp_token_id, entry_ids, expires_at, revoked_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '{}', ${expiresAt}, ${revoked ? "now()" : "NULL"}, now())`,
        id,
        tenantId,
        userId,
        accessTokenId,
      );
    });
    return id;
  }

  async function accessTokenExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM mcp_access_tokens WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  async function refreshTokenExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM mcp_refresh_tokens WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  async function delegationExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM delegation_sessions WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  async function sweep() {
    return sweepOnce(ctx.su.prisma, 100, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: false,
    });
  }

  it("deletes an expired access token whose family is fully dead + cascades the dead children", async () => {
    const at = await insertAccessToken("now() - interval '2 hours'");
    // dead refresh token (expired) + revoked delegation session — neither is live
    const rt = await insertRefreshToken(at, "now() - interval '1 hour'", false);
    const ds = await insertDelegationSession(at, "now() + interval '1 hour'", true);

    await sweep();

    expect(await accessTokenExists(at)).toBe(false);
    // cascade removed the dead children
    expect(await refreshTokenExists(rt)).toBe(false);
    expect(await delegationExists(ds)).toBe(false);
  });

  it("does NOT delete an expired access token with a LIVE refresh token (guard holds; live child survives)", async () => {
    const at = await insertAccessToken("now() - interval '2 hours'");
    const liveRt = await insertRefreshToken(at, "now() + interval '6 days'", false);

    await sweep();

    // Guard holds — parent kept AND the live child survives (RT7: removing the
    // guard would cascade-destroy liveRt → this assertion goes red).
    expect(await accessTokenExists(at)).toBe(true);
    expect(await refreshTokenExists(liveRt)).toBe(true);
  });

  it("does NOT delete an expired access token with a LIVE delegation session (guard holds; live child survives)", async () => {
    const at = await insertAccessToken("now() - interval '2 hours'");
    const liveDs = await insertDelegationSession(at, "now() + interval '1 hour'", false);

    await sweep();

    expect(await accessTokenExists(at)).toBe(true);
    expect(await delegationExists(liveDs)).toBe(true);
  });

  it("a revoked-but-unexpired refresh token does NOT keep its parent alive", async () => {
    const at = await insertAccessToken("now() - interval '2 hours'");
    // revoked (revoked_at set) but expires in the future — must NOT count as live
    const revokedRt = await insertRefreshToken(at, "now() + interval '6 days'", true);

    await sweep();

    expect(await accessTokenExists(at)).toBe(false);
    expect(await refreshTokenExists(revokedRt)).toBe(false);
  });

  it("worker role can cascade-delete with children granted SELECT-only (C4/R14 — no child DELETE grant needed)", async () => {
    // Eligible parent (expired) + a DEAD refresh token child. Deleting the parent
    // AS the least-privilege worker role must cascade-remove the child even though
    // the role has only SELECT (not DELETE) on mcp_refresh_tokens — proving the
    // R14 correction: Postgres' RI cascade does not re-check the invoking role's
    // privilege on cascade-target tables.
    const at = await insertAccessToken("now() - interval '2 hours'");
    const deadRt = await insertRefreshToken(at, "now() - interval '1 hour'", false);

    await ctx.retentionWorker.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_access_tokens WHERE (id) IN (
           SELECT id FROM mcp_access_tokens
           WHERE expires_at < now()
             AND NOT EXISTS (
               SELECT 1 FROM mcp_refresh_tokens r
               WHERE r.access_token_id = mcp_access_tokens.id
                 AND r.revoked_at IS NULL AND r.expires_at > now())
             AND NOT EXISTS (
               SELECT 1 FROM delegation_sessions d
               WHERE d.mcp_token_id = mcp_access_tokens.id
                 AND d.revoked_at IS NULL AND d.expires_at > now())
             AND id = $1::uuid
           LIMIT 100)`,
        at,
      );
    });

    expect(await accessTokenExists(at)).toBe(false);
    expect(await refreshTokenExists(deadRt)).toBe(false); // cascade succeeded
  });

  it("worker role CANNOT directly DELETE from mcp_refresh_tokens (no DELETE grant — least privilege)", async () => {
    const at = await insertAccessToken("now() + interval '1 hour'");
    const rt = await insertRefreshToken(at, "now() + interval '6 days'", false);

    await expect(
      ctx.retentionWorker.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await tx.$executeRawUnsafe(
          `DELETE FROM mcp_refresh_tokens WHERE id = $1::uuid`,
          rt,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
