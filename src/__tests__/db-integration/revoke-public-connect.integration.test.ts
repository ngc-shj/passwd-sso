/**
 * Verifies that the REVOKE CONNECT FROM PUBLIC migration (C3) took effect.
 *
 * T1: a freshly-created role with no explicit GRANT cannot connect (PUBLIC revoked).
 * T2: all four legitimate app/worker roles retain their explicit GRANT CONNECT.
 * RT4: both false (probe) and true (legit) branches are asserted, so a no-op
 *      migration or an over-broad REVOKE is caught.
 *
 * Uses has_database_privilege() to check catalog state without needing a live
 * connection as the probe role (NOLOGIN roles cannot actually connect, but the
 * CONNECT privilege catalog check still reflects the grant state correctly).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, type TestContext } from "./helpers";

describe("REVOKE CONNECT FROM PUBLIC (C3 migration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T1: probe role with no explicit GRANT cannot connect (PUBLIC revoked)", async () => {
    // Idempotent cleanup before create (T5: leak-safe)
    await ctx.su.prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS revoke_probe_role`);

    try {
      await ctx.su.prisma.$executeRawUnsafe(`CREATE ROLE revoke_probe_role NOLOGIN`);

      const rows = await ctx.su.prisma.$queryRaw<Array<{ can_connect: boolean }>>`
        SELECT has_database_privilege('revoke_probe_role', current_database(), 'CONNECT') AS can_connect
      `;
      expect(rows[0].can_connect).toBe(false);
    } finally {
      // T5: always clean up so a failed assertion does not leave the role behind
      await ctx.su.prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS revoke_probe_role`);
    }
  });

  it("T2: passwd_app retains explicit GRANT CONNECT", async () => {
    const rows = await ctx.su.prisma.$queryRaw<Array<{ can_connect: boolean }>>`
      SELECT has_database_privilege('passwd_app', current_database(), 'CONNECT') AS can_connect
    `;
    expect(rows[0].can_connect).toBe(true);
  });

  it("T2: passwd_outbox_worker retains explicit GRANT CONNECT", async () => {
    const rows = await ctx.su.prisma.$queryRaw<Array<{ can_connect: boolean }>>`
      SELECT has_database_privilege('passwd_outbox_worker', current_database(), 'CONNECT') AS can_connect
    `;
    expect(rows[0].can_connect).toBe(true);
  });

  it("T2: passwd_anchor_publisher retains explicit GRANT CONNECT", async () => {
    const rows = await ctx.su.prisma.$queryRaw<Array<{ can_connect: boolean }>>`
      SELECT has_database_privilege('passwd_anchor_publisher', current_database(), 'CONNECT') AS can_connect
    `;
    expect(rows[0].can_connect).toBe(true);
  });

  it("T2: passwd_dcr_cleanup_worker retains explicit GRANT CONNECT", async () => {
    const rows = await ctx.su.prisma.$queryRaw<Array<{ can_connect: boolean }>>`
      SELECT has_database_privilege('passwd_dcr_cleanup_worker', current_database(), 'CONNECT') AS can_connect
    `;
    expect(rows[0].can_connect).toBe(true);
  });
});
