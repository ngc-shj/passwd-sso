/**
 * iOS AutoFill MVP — T23: extension_tokens schema is backward-compatible.
 *
 * The clientKind / device_pubkey / cnf_jkt / last_used_ip / last_used_user_agent
 * columns were added to extension_tokens by migration
 * 20260501000000_extension_token_client_kind. This test verifies that:
 *
 *   1. A row inserted without specifying client_kind backfills to
 *      'BROWSER_EXTENSION' (DB default fired).
 *   2. The new optional columns are NULL by default.
 *   3. validateExtensionToken() against such a row succeeds without
 *      requiring a DPoP proof (legacy bearer-only path).
 *
 * The migration itself is run by the integration-test bootstrap (the DB is
 * already at HEAD). This test asserts the post-migration steady state.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { validateExtensionToken } from "@/lib/auth/tokens/extension-token";
import { hashToken } from "@/lib/crypto/crypto-server";

describe("extension_tokens migration backward compatibility (T23)", () => {
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
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM extension_tokens WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  /**
   * Insert a row that simulates a pre-migration extension-token: only the
   * legacy required columns are set; client_kind / device_pubkey / cnf_jkt
   * / last_used_ip / last_used_user_agent are deliberately omitted to
   * exercise their column defaults.
   */
  async function insertLegacyTokenRow(plaintextToken: string): Promise<string> {
    const id = randomUUID();
    const familyId = randomUUID();
    const tokenHash = hashToken(plaintextToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO extension_tokens (
           id, user_id, tenant_id, token_hash, scope, expires_at,
           created_at, family_id, family_created_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now(), $7::uuid, now()
         )`,
        id,
        userId,
        tenantId,
        tokenHash,
        "passwords:read,passwords:write",
        expiresAt,
        familyId,
      );
    });
    return id;
  }

  it("DB default fires: client_kind = 'BROWSER_EXTENSION' for rows that omit it", async () => {
    const id = await insertLegacyTokenRow("legacy_test_token_1");

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        Array<{
          client_kind: string;
          device_pubkey: string | null;
          cnf_jkt: string | null;
          last_used_ip: string | null;
          last_used_user_agent: string | null;
        }>
      >(
        `SELECT client_kind, device_pubkey, cnf_jkt, last_used_ip, last_used_user_agent
         FROM extension_tokens WHERE id = $1::uuid`,
        id,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].client_kind).toBe("BROWSER_EXTENSION");
    expect(rows[0].device_pubkey).toBeNull();
    expect(rows[0].cnf_jkt).toBeNull();
    expect(rows[0].last_used_ip).toBeNull();
    expect(rows[0].last_used_user_agent).toBeNull();
  });

  it("validateExtensionToken accepts a BROWSER_EXTENSION row without a DPoP proof", async () => {
    const plaintext = "legacy_test_token_2";
    const tokenId = await insertLegacyTokenRow(plaintext);

    // No `dpop` header on the request — must succeed for BROWSER_EXTENSION.
    const req = new NextRequest("http://localhost/api/passwords", {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    const result = await validateExtensionToken(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.tokenId).toBe(tokenId);
      expect(result.data.userId).toBe(userId);
      expect(result.data.tenantId).toBe(tenantId);
      expect(result.data.scopes).toEqual(
        expect.arrayContaining(["passwords:read", "passwords:write"]),
      );
    }
  });
});
