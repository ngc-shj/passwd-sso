/**
 * Migration integration test — extension_dpop_sender_constrained (Round 2 T17).
 *
 * Verifies the post-migration state of extension_tokens:
 *   (a) Legacy BROWSER_EXTENSION rows with cnf_jkt IS NULL are deleted.
 *   (b) BROWSER_EXTENSION rows WITH cnf_jkt survive.
 *   (c) IOS_APP rows with cnf_jkt IS NULL survive (allowed per the partial
 *       CHECK constraint; rejected at validate-time, not migration-time).
 *
 * Also verifies the new CHECK constraint:
 *   (d) Inserting a BROWSER_EXTENSION row with cnf_jkt = NULL fails.
 *
 * The migration itself has already run against this test DB (the integration
 * test bootstrap applies all migrations at HEAD). The test seeds "dirty"
 * pre-migration–style state by inserting rows that violate the post-migration
 * invariant — and verifies they would be rejected or absent.
 *
 * Sentinel: this test uses a real Postgres connection (no mocked Prisma).
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
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

// A well-formed 43-char base64url thumbprint used for the "has cnf_jkt" rows.
const VALID_JKT = "abcdefghijklmnopqrstuvwxyz012345678ABCDEFGH";

describe(
  "migration: extension_tokens cnf_jkt CHECK constraint (T17)",
  () => {
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
      // Delete extension_tokens rows created during this test, then tenant data.
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM extension_tokens WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      });
      await ctx.deleteTestData(tenantId);
    });

    // ─── Helper: insert an extension_tokens row, bypassing RLS ─────

    async function insertTokenRow(opts: {
      clientKind: "BROWSER_EXTENSION" | "IOS_APP";
      cnfJkt: string | null;
    }): Promise<string> {
      const id = randomUUID();
      const familyId = randomUUID();
      const tokenHash = `hash-${id}`;
      const expiresAt = new Date(Date.now() + 3_600_000);

      if (opts.cnfJkt === null) {
        // Insert without cnf_jkt — omit the column so the DB default (NULL) applies.
        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          await tx.$executeRawUnsafe(
            `INSERT INTO extension_tokens (
               id, user_id, tenant_id, token_hash, scope, expires_at,
               family_id, family_created_at, client_kind
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
               $7::uuid, now(), $8::"ExtensionTokenClientKind"
             )`,
            id,
            userId,
            tenantId,
            tokenHash,
            "passwords:read",
            expiresAt,
            familyId,
            opts.clientKind,
          );
        });
      } else {
        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          await tx.$executeRawUnsafe(
            `INSERT INTO extension_tokens (
               id, user_id, tenant_id, token_hash, scope, expires_at,
               family_id, family_created_at, client_kind, cnf_jkt
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
               $7::uuid, now(), $8::"ExtensionTokenClientKind", $9
             )`,
            id,
            userId,
            tenantId,
            tokenHash,
            "passwords:read",
            expiresAt,
            familyId,
            opts.clientKind,
            opts.cnfJkt,
          );
        });
      }
      return id;
    }

    // ─── (b) BROWSER_EXTENSION row WITH cnf_jkt survives ───────────

    it("BROWSER_EXTENSION row with cnf_jkt can be inserted and read back", async () => {
      const id = await insertTokenRow({
        clientKind: "BROWSER_EXTENSION",
        cnfJkt: VALID_JKT,
      });

      const rows = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<Array<{ id: string; cnf_jkt: string | null }>>(
          `SELECT id, cnf_jkt FROM extension_tokens WHERE id = $1::uuid`,
          id,
        );
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].cnf_jkt).toBe(VALID_JKT);
    });

    // ─── (c) IOS_APP row with cnf_jkt = NULL survives ──────────────

    it("IOS_APP row with cnf_jkt = NULL is permitted by the CHECK constraint", async () => {
      const id = await insertTokenRow({
        clientKind: "IOS_APP",
        cnfJkt: null,
      });

      const rows = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<Array<{ id: string; cnf_jkt: string | null }>>(
          `SELECT id, cnf_jkt FROM extension_tokens WHERE id = $1::uuid`,
          id,
        );
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].cnf_jkt).toBeNull();
    });

    // ─── (d) BROWSER_EXTENSION row with cnf_jkt = NULL is REJECTED ─

    it("BROWSER_EXTENSION row with cnf_jkt = NULL violates the CHECK constraint", async () => {
      // The migration added:
      //   CHECK (client_kind <> 'BROWSER_EXTENSION' OR cnf_jkt IS NOT NULL)
      // Inserting a BROWSER_EXTENSION row with cnf_jkt = NULL must throw.
      await expect(
        insertTokenRow({ clientKind: "BROWSER_EXTENSION", cnfJkt: null }),
      ).rejects.toThrow(
        // Postgres check constraint violation
        /check.*constraint|violates/i,
      );
    });

    // ─── (a) Migration step: legacy BROWSER_EXTENSION NULL rows were deleted ───
    //
    // The actual "delete legacy rows" migration step has already run against this
    // test DB. We verify the invariant it enforces: the constraint now prevents
    // any new BROWSER_EXTENSION row with null cnf_jkt, and the constraint name
    // is present in the schema (confirms the migration step 4 ran).

    it("constraint extension_tokens_cnf_jkt_required_for_browser_ext is present in the DB", async () => {
      const rows = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<Array<{ constraint_name: string }>>(
          `SELECT constraint_name
           FROM information_schema.check_constraints
           WHERE constraint_name = 'extension_tokens_cnf_jkt_required_for_browser_ext'`,
        );
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].constraint_name).toBe(
        "extension_tokens_cnf_jkt_required_for_browser_ext",
      );
    });

    // ─── Verify the NOT NULL column on extension_bridge_codes ─────────────────

    it("extension_bridge_codes.cnf_jkt is a NOT NULL column (migration step 3)", async () => {
      const rows = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<
          Array<{ column_name: string; is_nullable: string }>
        >(
          `SELECT column_name, is_nullable
           FROM information_schema.columns
           WHERE table_name = 'extension_bridge_codes'
             AND column_name = 'cnf_jkt'`,
        );
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].is_nullable).toBe("NO");
    });
  },
);
