/**
 * Integration tests for audit_chain_anchors epoch column migration (T13).
 *
 * Phase 2 migration (20260502000000_audit_anchor_publisher_phase2) added the
 * epoch column as nullable INTEGER with DEFAULT 1. This test verifies the
 * migration sequence's correctness invariants:
 *
 *   1. The epoch column exists with DEFAULT 1 and is nullable.
 *   2. INSERT with default epoch succeeds; epoch = 1.
 *   3. INSERT with explicit NULL epoch succeeds (nullable).
 *   4. Backfill: UPDATE ... SET epoch = 1 WHERE epoch IS NULL updates affected rows.
 *   5. After backfill, no NULL epochs remain.
 *   6. Negative: attempting to ALTER COLUMN epoch SET NOT NULL without backfill
 *      fails with a not-null constraint violation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";

describe("audit_chain_anchors — epoch column migration invariants", () => {
  let ctx: TestContext;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    // No per-test setup needed — each test creates its own tenants.
  });

  afterEach(async () => {
    // Clean up all tenants created in this test
    const ids = tenantIds.splice(0);
    for (const id of ids) {
      await ctx.deleteTestData(id);
    }
  });

  it("Test 1: epoch column exists in audit_chain_anchors with nullable=true and default=1", async () => {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
        data_type: string;
      }[]>(
        `SELECT column_name, is_nullable, column_default, data_type
         FROM information_schema.columns
         WHERE table_name = 'audit_chain_anchors'
           AND column_name = 'epoch'`,
      );
    });

    expect(rows).toHaveLength(1);
    const col = rows[0]!;
    expect(col.column_name).toBe("epoch");
    expect(col.is_nullable).toBe("YES");
    expect(col.data_type).toBe("integer");
    // The default must reference the value 1
    expect(col.column_default).toContain("1");
  });

  it("Test 2: INSERT with default epoch succeeds and epoch = 1", async () => {
    const tenantId = await ctx.createTenant();
    tenantIds.push(tenantId);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now())`,
        tenantId,
      );
    });

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ epoch: number | null }[]>(
        `SELECT epoch FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.epoch).toBe(1);
  });

  it("Test 3: INSERT with explicit NULL epoch succeeds (column is nullable)", async () => {
    const tenantId = await ctx.createTenant();
    tenantIds.push(tenantId);

    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$executeRawUnsafe(
          `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at, epoch)
           VALUES ($1::uuid, 0, '\\x00'::bytea, now(), NULL)`,
          tenantId,
        );
      }),
    ).resolves.toBeDefined();

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ epoch: number | null }[]>(
        `SELECT epoch FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.epoch).toBeNull();
  });

  it("Test 4 + 5: backfill sets epoch=1 for NULL rows, leaving no NULLs", async () => {
    // Create two tenants — one with explicit NULL epoch, one with default (1)
    const tenantIdNull = await ctx.createTenant();
    const tenantIdDefault = await ctx.createTenant();
    tenantIds.push(tenantIdNull, tenantIdDefault);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      // Insert with explicit NULL epoch
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at, epoch)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now(), NULL)`,
        tenantIdNull,
      );
      // Insert with default epoch (= 1)
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now())`,
        tenantIdDefault,
      );
    });

    // Confirm NULL epoch exists before backfill
    const beforeBackfill = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ epoch: number | null }[]>(
        `SELECT epoch FROM audit_chain_anchors
         WHERE tenant_id = ANY($1::uuid[])
         ORDER BY tenant_id`,
        [tenantIdNull, tenantIdDefault],
      );
    });

    const nullBeforeCount = beforeBackfill.filter((r) => r.epoch === null).length;
    expect(nullBeforeCount).toBeGreaterThan(0);

    // Run backfill for these two specific tenants only (scoped to test data)
    const updated = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const result = await tx.$queryRawUnsafe<{ count: string }[]>(
        `WITH updated AS (
           UPDATE audit_chain_anchors
           SET epoch = 1
           WHERE epoch IS NULL
             AND tenant_id = ANY($1::uuid[])
           RETURNING tenant_id
         )
         SELECT count(*)::text AS count FROM updated`,
        [tenantIdNull, tenantIdDefault],
      );
      return parseInt(result[0]?.count ?? "0", 10);
    });

    // At least one row must have been updated (the NULL-epoch one)
    expect(updated).toBeGreaterThan(0);

    // After backfill: no NULL epochs remain for these tenants
    const afterBackfill = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ epoch: number | null }[]>(
        `SELECT epoch FROM audit_chain_anchors
         WHERE tenant_id = ANY($1::uuid[])`,
        [tenantIdNull, tenantIdDefault],
      );
    });

    const nullAfterCount = afterBackfill.filter((r) => r.epoch === null).length;
    expect(nullAfterCount).toBe(0);

    // All epochs must be 1
    for (const row of afterBackfill) {
      expect(row.epoch).toBe(1);
    }
  });

  it("Test 6 (negative): ALTER COLUMN epoch SET NOT NULL fails when NULL rows exist (no backfill)", async () => {
    const tenantId = await ctx.createTenant();
    tenantIds.push(tenantId);

    // Insert a row with explicit NULL epoch — no backfill
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at, epoch)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now(), NULL)`,
        tenantId,
      );
    });

    // Attempting SET NOT NULL must fail due to existing NULL values.
    // We run this in a SAVEPOINT so we can recover without aborting the outer tx.
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        // Use a SAVEPOINT + ROLLBACK TO SAVEPOINT to test the DDL failure in isolation.
        // If ALTER succeeds (unexpected), the outer expect will catch the absence of an error.
        await tx.$executeRawUnsafe(`SAVEPOINT epoch_not_null_test`);
        try {
          await tx.$executeRawUnsafe(
            `ALTER TABLE audit_chain_anchors ALTER COLUMN epoch SET NOT NULL`,
          );
          // If we reach here, DDL succeeded (no NULLs exist) — roll it back anyway
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT epoch_not_null_test`);
          throw new Error("ALTER succeeded unexpectedly (NULL rows should have blocked it)");
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.includes("ALTER succeeded unexpectedly")
          ) {
            throw err;
          }
          // Expected: DDL was rejected due to NULL constraint violation
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT epoch_not_null_test`);
          throw new Error("DDL correctly rejected: NULL epoch rows prevent SET NOT NULL");
        }
      }),
    ).rejects.toThrow(/DDL correctly rejected|NULL epoch rows prevent SET NOT NULL/);
  });
});
