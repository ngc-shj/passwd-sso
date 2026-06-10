/**
 * C13 db-integration: deactivated TenantMember → API key validation fails.
 *
 * Exercises the REAL query shape: deactivate membership via raw UPDATE,
 * then call validateApiKey and assert it returns API_KEY_INVALID.
 *
 * This guards against mock-reality divergence where the unit test passes
 * but the actual tenantMember.findUnique query is wrong (e.g. wrong
 * composite key name, wrong field selection).
 *
 * One db-integration test covers the essence (C13 plan acceptance).
 * Does NOT run the DPoP flow — uses ApiKey (no DPoP required).
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
import { validateApiKey } from "@/lib/auth/tokens/api-key";
import { hashToken } from "@/lib/crypto/crypto-server";
import { NextRequest } from "next/server";
import { API_KEY_PREFIX } from "@/lib/constants/auth/api-key";

// ─── Helpers ─────────────────────────────────────────────────

function makeRequest(token: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/passwords", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function seedApiKey(
  ctx: TestContext,
  tenantId: string,
  userId: string,
  plaintoken: string,
): Promise<string> {
  const tokenHash = hashToken(plaintoken);
  const keyId = randomUUID();
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO api_keys
         (id, user_id, tenant_id, token_hash, prefix, name, scope, expires_at, created_at)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, now())`,
      keyId,
      userId,
      tenantId,
      tokenHash,
      plaintoken.slice(0, 8),
      "integration-test-key",
      "passwords:read",
      new Date(Date.now() + 3_600_000), // 1 hour
    );
  });
  return keyId;
}

async function deactivateMember(
  ctx: TestContext,
  tenantId: string,
  userId: string,
): Promise<void> {
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE tenant_members
         SET deactivated_at = now()
       WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      tenantId,
      userId,
    );
  });
}

// ─── Test suite ───────────────────────────────────────────────

describe("C13: deactivated TenantMember rejects API key (real DB)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let keyId: string;
  const plaintoken = `${API_KEY_PREFIX}c13integtest${randomUUID().replace(/-/g, "")}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    keyId = await seedApiKey(ctx, tenantId, userId, plaintoken);
  });

  afterEach(async () => {
    // Clean up api_key row first, then tenant data (FK-safe order)
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM api_keys WHERE id = $1::uuid`,
        keyId,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  it("active membership ⇒ validateApiKey returns ok:true", async () => {
    const result = await validateApiKey(makeRequest(plaintoken));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.userId).toBe(userId);
      expect(result.data.tenantId).toBe(tenantId);
    }
  });

  it("deactivated membership ⇒ validateApiKey returns API_KEY_INVALID", async () => {
    await deactivateMember(ctx, tenantId, userId);

    const result = await validateApiKey(makeRequest(plaintoken));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("API_KEY_INVALID");
    }
  });
});
