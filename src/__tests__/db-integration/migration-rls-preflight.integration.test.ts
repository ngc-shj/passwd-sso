/**
 * The one-shot migration scripts accept `MIGRATION_DATABASE_URL ?? DATABASE_URL`.
 * Run with the fallback they connect as `passwd_app` (NOBYPASSRLS) against
 * FORCE-RLS tables with no tenant GUC set, so their scan SELECT returns zero
 * rows with no error and they print "Migration complete … failed: 0" and exit 0
 * — a clean success that migrated nothing, leaving plaintext OAuth tokens or v1
 * webhook secrets at rest.
 *
 * The preflight refuses on the role rather than counting rows, because a zero
 * count is exactly what BOTH the broken case and the already-migrated case
 * produce and therefore cannot discriminate them. These cases run against the
 * real roles: a stub would only re-assert the branch, not that `passwd_app` and
 * `passwd_user` actually differ in the attribute the branch reads.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPrismaForRole, type PrismaWithPool } from "./helpers";
import {
  assertRlsVisibility,
  checkRlsVisibility,
} from "@/../scripts/lib/assert-rls-visibility";

describe("migration RLS visibility preflight", () => {
  let app: PrismaWithPool;
  let su: PrismaWithPool;

  beforeAll(() => {
    app = createPrismaForRole("app");
    su = createPrismaForRole("superuser");
  });

  afterAll(async () => {
    await app.prisma.$disconnect();
    await app.pool.end();
    await su.prisma.$disconnect();
    await su.pool.end();
  });

  it("reports the app role as unable to see RLS-protected rows", async () => {
    // Pins the premise the refusal rests on. If passwd_app ever gained
    // BYPASSRLS this would fail here rather than silently making the guard
    // a no-op that still reads as protection.
    const v = await checkRlsVisibility(app.prisma);
    expect(v.role).toBe("passwd_app");
    expect(v.isSuperuser).toBe(false);
    expect(v.bypassesRls).toBe(false);
  });

  it("refuses to run a migration on the app connection", async () => {
    // Deny side.
    await expect(
      assertRlsVisibility(app.prisma, "migrate-account-tokens-to-encrypted"),
    ).rejects.toThrow(/RLS_PREFLIGHT_FAILED/);
    // The message must name the offending role and the fix, or the operator
    // reads it as a transient error and re-runs the same broken command.
    await expect(
      assertRlsVisibility(app.prisma, "migrate-account-tokens-to-encrypted"),
    ).rejects.toThrow(/passwd_app[\s\S]*MIGRATION_DATABASE_URL/);
  });

  it("permits the migration role", async () => {
    // Allow side. Without it a preflight that refused unconditionally would
    // satisfy the deny case while making both scripts unrunnable.
    const v = await assertRlsVisibility(su.prisma, "migrate-webhook-secrets");
    expect(v.role).toBe("passwd_user");
    expect(v.isSuperuser || v.bypassesRls).toBe(true);
  });
});
