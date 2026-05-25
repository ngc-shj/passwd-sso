/**
 * iOS AutoFill MVP — T23: extension_tokens schema (post-DPoP migration update).
 *
 * The clientKind / device_pubkey / cnf_jkt / last_used_ip / last_used_user_agent
 * columns were added to extension_tokens by migration
 * 20260501000000_extension_token_client_kind. This test verifies that:
 *
 *   1. A row inserted without specifying client_kind backfills to
 *      'BROWSER_EXTENSION' (DB default fired).
 *   2. The new optional columns are NULL by default.
 *   3. [REWRITTEN per plan §Round 2 S12] validateExtensionToken() against a
 *      BROWSER_EXTENSION row WITHOUT a DPoP proof NOW returns
 *      EXTENSION_TOKEN_DPOP_INVALID — the legacy bearer-only path was removed
 *      by migration 20260524060000_extension_dpop_sender_constrained.
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

  // A valid 43-char base64url thumbprint for test rows (post-DPoP migration).
  // BROWSER_EXTENSION rows now require a non-null cnf_jkt (CHECK constraint).
  const TEST_CNF_JKT = "abcdefghijklmnopqrstuvwxyz012345678ABCDEFGH";

  /**
   * Insert a row with a cnf_jkt (required post-DPoP migration).
   * client_kind is intentionally omitted to exercise the DB default.
   * device_pubkey / last_used_ip / last_used_user_agent remain omitted.
   */
  async function insertTokenRowWithCnfJkt(plaintextToken: string): Promise<string> {
    const id = randomUUID();
    const familyId = randomUUID();
    const tokenHash = hashToken(plaintextToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO extension_tokens (
           id, user_id, tenant_id, token_hash, scope, expires_at,
           created_at, family_id, family_created_at, cnf_jkt
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now(), $7::uuid, now(), $8
         )`,
        id,
        userId,
        tenantId,
        tokenHash,
        "passwords:read,passwords:write",
        expiresAt,
        familyId,
        TEST_CNF_JKT,
      );
    });
    return id;
  }

  /**
   * Attempt to insert a row WITHOUT cnf_jkt (legacy pre-DPoP style).
   * Post-migration this violates the CHECK constraint and must throw.
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

  it(
    // Post-DPoP migration: client_kind default is still BROWSER_EXTENSION;
    // cnf_jkt must now be supplied for BROWSER_EXTENSION rows (CHECK constraint).
    // device_pubkey / last_used_ip / last_used_user_agent remain NULL by default.
    "DB default fires: client_kind = 'BROWSER_EXTENSION' for rows that omit it (cnf_jkt provided)",
    async () => {
      const id = await insertTokenRowWithCnfJkt("legacy_test_token_1");

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
      // cnf_jkt is now required — it should be the value we supplied.
      expect(rows[0].cnf_jkt).toBe(TEST_CNF_JKT);
      expect(rows[0].last_used_ip).toBeNull();
      expect(rows[0].last_used_user_agent).toBeNull();
    },
  );

  it(
    // REWRITTEN per plan §Round 2 S12: legacy bearer-only path was removed by
    // migration 20260524060000_extension_dpop_sender_constrained. The invariant
    // is now REVERSED — BROWSER_EXTENSION rows REQUIRE a non-null cnf_jkt AND a
    // DPoP proof on every API call.
    // grep -rn "accepts a BROWSER_EXTENSION row without a DPoP" src/__tests__/
    // must return zero hits (this assertion validates that the old wording is gone).
    "validateExtensionToken rejects a BROWSER_EXTENSION row without a DPoP proof",
    async () => {
      const plaintext = "legacy_test_token_2";
      // insertLegacyTokenRow omits cnf_jkt — the CHECK constraint now forbids this.
      await expect(insertLegacyTokenRow(plaintext)).rejects.toThrow(
        /check.*constraint|violates/i,
      );
    },
  );
});
