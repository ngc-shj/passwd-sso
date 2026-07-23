/**
 * S14/RT7: cross-check RETENTION_REGISTRY + RLS_FREE_EXPIRY_TABLES against the
 * live DB catalog's ground truth (pg_class.relrowsecurity), via the pure
 * assertRegistryRlsParity function. validateRegistry() (index.ts) only enforces
 * author discipline on the registry's own globalDelete flags; this test proves
 * those flags actually match what Postgres reports for every table, closing
 * the gap the boot validator's TODO tracks.
 *
 * Negative sub-tests inject fixtures against the REAL catalog rows (not a
 * fabricated catalog) so the redness is proven against ground truth: a fake
 * table name that does not exist in the live DB, and a real RLS-enabled table
 * moved into the rls-free set.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  type TestContext,
} from "./helpers";
import {
  RETENTION_REGISTRY,
  RLS_FREE_EXPIRY_TABLES,
  assertRegistryRlsParity,
  type CatalogTableRow,
} from "@/workers/retention-gc-worker/registry";

describe("retention registry vs DB RLS ground truth (S14/RT7)", () => {
  let ctx: TestContext;
  let catalogRows: CatalogTableRow[];

  beforeAll(async () => {
    ctx = await createTestContext();

    // pg_class.relrowsecurity is readable by any role for visible tables (no
    // superuser required) — query as su for consistency with the rest of the
    // harness. relkind = 'r' restricts to ordinary tables (excludes views,
    // sequences, indexes).
    const rows = await ctx.su.prisma.$queryRawUnsafe<
      { table: string; relrowsecurity: boolean }[]
    >(
      `SELECT c.relname AS table, c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    catalogRows = rows;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("has no gap between the registry, RLS_FREE_EXPIRY_TABLES, and the live catalog", () => {
    expect(() =>
      assertRegistryRlsParity(RETENTION_REGISTRY, RLS_FREE_EXPIRY_TABLES, catalogRows),
    ).not.toThrow();
  });

  it("throws when a fake table name is injected into the registry (renamed/missing table drift, RT7-a)", () => {
    const fakeEntry = {
      kind: "EXPIRY" as const,
      table: "this_table_does_not_exist_in_the_db",
      cutoffColumn: "expires_at",
      keyColumns: ["id"],
      globalDelete: true as const,
    };
    expect(() =>
      assertRegistryRlsParity(
        [...RETENTION_REGISTRY, fakeEntry],
        RLS_FREE_EXPIRY_TABLES,
        catalogRows,
      ),
    ).toThrow(/not found in the live DB catalog/);
  });

  it("throws when a real RLS-enabled table is moved into the rls-free set (RT7-b)", () => {
    // "sessions" is a real RLS-enabled EXPIRY table in the registry (see
    // registry.ts) — injecting it into the rls-free set must be caught
    // against the real catalog's relrowsecurity = true for sessions.
    const badRlsFreeTables = new Set([...RLS_FREE_EXPIRY_TABLES, "sessions"]);
    expect(() =>
      assertRegistryRlsParity(RETENTION_REGISTRY, badRlsFreeTables, catalogRows),
    ).toThrow(/relrowsecurity = true/);
  });
});
