/**
 * Integration tests for sentinel UUID invariants in audit_logs.
 * Verifies post-migration schema: user_id NOT NULL, FK removed, ANONYMOUS actor type works.
 *
 * Scenarios:
 * 1. FK drop: INSERT with sentinel user_id not in users table succeeds
 * 2. NOT NULL constraint: INSERT with NULL user_id always fails
 * 3. ANONYMOUS actor flows through normally (user_id = ANONYMOUS_ACTOR_ID)
 * 4. audit_logs_outbox_id_actor_type_check still enforced
 * 5. RLS cross-tenant isolation: ANONYMOUS row for tenant A invisible to tenant B
 * 6. Sentinel users are excluded from human audit log views by actor_type filter
 * 7. (backfill correctness) SYSTEM rows have user_id = SYSTEM_ACTOR_ID post-migration
 * 8. ANONYMOUS actor event can be inserted with a non-null chain_seq (chain-append eligible)
 * 9. ANONYMOUS events pass UUID_RE guard (sentinel IDs are valid UUIDs)
 * S3. ANONYMOUS actor with outbox_id=NULL violates CHECK constraint
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit";
import {
  ANONYMOUS_ACTOR_ID,
  SYSTEM_ACTOR_ID,
  SENTINEL_ACTOR_IDS,
  UUID_RE,
} from "@/lib/constants/app";

describe("audit-sentinel: post-migration invariants", () => {
  let ctx: TestContext;
  let tenantIdA: string;
  let tenantIdB: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantIdA = await ctx.createTenant();
    tenantIdB = await ctx.createTenant();
    userId = await ctx.createUser(tenantIdA);
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantIdA);
    await ctx.deleteTestData(tenantIdB);
  });

  // Scenario 1: FK drop — sentinels don't exist in users table but INSERT succeeds
  it("allows INSERT with ANONYMOUS_ACTOR_ID not in users table (FK removed)", async () => {
    // Verify ANONYMOUS_ACTOR_ID is not in users table
    const userRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM users WHERE id = $1::uuid`,
        ANONYMOUS_ACTOR_ID,
      );
    });
    expect(Number(userRows[0].cnt)).toBe(0);

    const outboxId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
        outboxId,
        tenantIdA,
      );
    });

    // This INSERT would fail with FK constraint pre-migration; post-migration it succeeds
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (
            id, tenant_id, scope, action, user_id, actor_type, metadata, created_at, outbox_id
          ) VALUES (
            gen_random_uuid(), $1::uuid,
            $2::"AuditScope", $3::"AuditAction",
            $4::uuid, $5::"ActorType",
            $6::jsonb, now(), $7::uuid
          )`,
          tenantIdA,
          AUDIT_SCOPE.TENANT,
          AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
          ANONYMOUS_ACTOR_ID,
          ACTOR_TYPE.ANONYMOUS,
          JSON.stringify({ ip: "1.2.3.4" }),
          outboxId,
        );
      }),
    ).resolves.not.toThrow();

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ user_id: string; actor_type: string }[]>(
        `SELECT user_id::text, actor_type::text FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction"`,
        tenantIdA,
        AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(ANONYMOUS_ACTOR_ID);
    expect(rows[0].actor_type).toBe("ANONYMOUS");
  });

  // Scenario 2: NOT NULL constraint — any NULL user_id fails
  it("rejects INSERT with NULL user_id (NOT NULL constraint)", async () => {
    const outboxId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
        outboxId,
        tenantIdA,
      );
    });

    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (
            id, tenant_id, scope, action, user_id, actor_type, metadata, created_at, outbox_id
          ) VALUES (
            gen_random_uuid(), $1::uuid,
            $2::"AuditScope", $3::"AuditAction",
            NULL, $4::"ActorType",
            $5::jsonb, now(), $6::uuid
          )`,
          tenantIdA,
          AUDIT_SCOPE.PERSONAL,
          AUDIT_ACTION.ENTRY_CREATE,
          ACTOR_TYPE.HUMAN,
          JSON.stringify({}),
          outboxId,
        );
      }),
    ).rejects.toThrow(/null value in column|not-null constraint|audit_logs_outbox_id_actor_type_check/);
  });

  // Scenario 3: audit_logs_outbox_id_actor_type_check still enforced
  it("rejects HUMAN actor with outbox_id = NULL (CHECK constraint enforced)", async () => {
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (
            id, tenant_id, scope, action, user_id, actor_type, metadata, created_at
          ) VALUES (
            gen_random_uuid(), $1::uuid,
            $2::"AuditScope", $3::"AuditAction",
            $4::uuid, $5::"ActorType",
            $6::jsonb, now()
          )`,
          tenantIdA,
          AUDIT_SCOPE.PERSONAL,
          AUDIT_ACTION.ENTRY_CREATE,
          userId,
          ACTOR_TYPE.HUMAN,
          JSON.stringify({}),
        );
      }),
    ).rejects.toThrow(/audit_logs_outbox_id_actor_type_check/);
  });

  // Scenario 4: SYSTEM actor with SYSTEM_ACTOR_ID works (outbox_id = NULL allowed for SYSTEM)
  it("allows SYSTEM actor with SYSTEM_ACTOR_ID and NULL outbox_id", async () => {
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (
            id, tenant_id, scope, action, user_id, actor_type, metadata, created_at
          ) VALUES (
            gen_random_uuid(), $1::uuid,
            $2::"AuditScope", $3::"AuditAction",
            $4::uuid, $5::"ActorType",
            $6::jsonb, now()
          )`,
          tenantIdA,
          AUDIT_SCOPE.TENANT,
          AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
          SYSTEM_ACTOR_ID,
          ACTOR_TYPE.SYSTEM,
          JSON.stringify({ test: true }),
        );
      }),
    ).resolves.not.toThrow();
  });

  // Scenario 5: RLS cross-tenant isolation for ANONYMOUS rows
  it("RLS isolation: ANONYMOUS row for tenant A is invisible to tenant B session", async () => {
    const outboxId = randomUUID();
    // Insert outbox row for tenant A
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
        outboxId,
        tenantIdA,
      );
    });

    // Insert ANONYMOUS audit log for tenant A
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type, metadata, created_at, outbox_id
        ) VALUES (
          gen_random_uuid(), $1::uuid,
          $2::"AuditScope", $3::"AuditAction",
          $4::uuid, $5::"ActorType",
          $6::jsonb, now(), $7::uuid
        )`,
        tenantIdA,
        AUDIT_SCOPE.TENANT,
        AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
        ANONYMOUS_ACTOR_ID,
        ACTOR_TYPE.ANONYMOUS,
        JSON.stringify({ ip: "1.2.3.4" }),
        outboxId,
      );
    });

    // Query as tenant B using RLS — should see 0 rows from tenant A
    const rows = await ctx.app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL app.current_tenant_id = $1`,
        tenantIdB,
      );
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = $2::"AuditAction" AND actor_type = 'ANONYMOUS'`,
        tenantIdA,
        AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
      );
    });

    expect(Number(rows[0].cnt)).toBe(0);
  });

  // Scenario 6: Human audit log views exclude sentinels by actor_type filter
  it("human audit views exclude sentinels: ANONYMOUS/SYSTEM rows absent when filtering by HUMAN actor_type", async () => {
    const outboxId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
        outboxId,
        tenantIdA,
      );
    });

    // Insert ANONYMOUS row
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type, metadata, created_at, outbox_id
        ) VALUES (
          gen_random_uuid(), $1::uuid,
          $2::"AuditScope", $3::"AuditAction",
          $4::uuid, $5::"ActorType",
          $6::jsonb, now(), $7::uuid
        )`,
        tenantIdA,
        AUDIT_SCOPE.TENANT,
        AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
        ANONYMOUS_ACTOR_ID,
        ACTOR_TYPE.ANONYMOUS,
        JSON.stringify({ ip: "5.6.7.8" }),
        outboxId,
      );
    });

    // Query filtered by actor_type = HUMAN — sentinel row must not appear
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ user_id: string }[]>(
        `SELECT user_id::text FROM audit_logs
         WHERE tenant_id = $1::uuid AND actor_type = 'HUMAN'
         AND user_id = ANY(ARRAY[$2::uuid, $3::uuid])`,
        tenantIdA,
        ANONYMOUS_ACTOR_ID,
        SYSTEM_ACTOR_ID,
      );
    });

    expect(rows).toHaveLength(0);

    // Confirm sentinel_actor_ids set in application matches what we expect
    expect(SENTINEL_ACTOR_IDS.has(ANONYMOUS_ACTOR_ID)).toBe(true);
    expect(SENTINEL_ACTOR_IDS.has(SYSTEM_ACTOR_ID)).toBe(true);
  });

  // Scenario 7: backfill correctness — SYSTEM rows have SYSTEM_ACTOR_ID post-migration
  it("migration backfill: all SYSTEM rows with outbox_id IS NULL have user_id = SYSTEM_ACTOR_ID", async () => {
    // Since the migration already ran and user_id is NOT NULL, we cannot re-seed NULL rows.
    // This test asserts the post-migration invariant: any SYSTEM actor row bypassing the outbox
    // (outbox_id IS NULL) must have been written with SYSTEM_ACTOR_ID. This covers:
    //   (a) pre-migration rows backfilled by the migration, and
    //   (b) new rows written by writeDirectAuditLog which always uses SYSTEM_ACTOR_ID.
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ user_id: string }>>(
        `SELECT user_id::text FROM audit_logs
         WHERE actor_type = 'SYSTEM' AND outbox_id IS NULL
         LIMIT 100`,
      );
    });
    for (const row of rows) {
      expect(row.user_id).toBe(SYSTEM_ACTOR_ID);
    }
  });

  // Scenario 8: ANONYMOUS actor event can be inserted with non-null chain_seq
  it("ANONYMOUS actor event can be inserted with chain_seq set (chain-append eligible)", async () => {
    // Insert an outbox row first (CHECK constraint requires outbox_id for ANONYMOUS)
    const outboxId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
        outboxId,
        tenantIdA,
      );
    });

    // Insert an ANONYMOUS audit_logs row with an explicit chain_seq to simulate
    // the worker's deliverRowWithChain path. The column accepts any integer.
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (
            id, tenant_id, scope, action, user_id, actor_type, metadata, created_at, outbox_id, chain_seq
          ) VALUES (
            gen_random_uuid(), $1::uuid,
            $2::"AuditScope", $3::"AuditAction",
            $4::uuid, $5::"ActorType",
            $6::jsonb, now(), $7::uuid, 1
          )`,
          tenantIdA,
          AUDIT_SCOPE.TENANT,
          AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
          ANONYMOUS_ACTOR_ID,
          ACTOR_TYPE.ANONYMOUS,
          JSON.stringify({}),
          outboxId,
        );
      }),
    ).resolves.not.toThrow();

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: number | null }[]>(
        `SELECT chain_seq FROM audit_logs
         WHERE tenant_id = $1::uuid AND outbox_id = $2::uuid`,
        tenantIdA,
        outboxId,
      );
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].chain_seq).not.toBeNull();
  });

  // Scenario 9: ANONYMOUS and SYSTEM sentinel IDs pass UUID_RE — worker guard does not fire
  it("ANONYMOUS events pass UUID_RE guard: sentinel IDs are valid UUIDs so invalid_userid_skipped is never triggered", async () => {
    // The worker UUID_RE guard skips rows where UUID_RE.test(payload.userId) === false.
    // Sentinel IDs must be valid UUIDs so they always pass the guard.
    // This is a pure unit-level assertion within the integration test to prove the invariant holds
    // for the values that reach the DB.
    expect(UUID_RE.test(ANONYMOUS_ACTOR_ID)).toBe(true);
    expect(UUID_RE.test(SYSTEM_ACTOR_ID)).toBe(true);
    // An empty string (parsePayload fallback for null) must NOT pass — proving the guard fires
    // only for malformed payloads, never for legitimate sentinels.
    expect(UUID_RE.test("")).toBe(false);
  });

  // S3: ANONYMOUS actor with outbox_id = NULL violates CHECK constraint
  it("rejects ANONYMOUS actor with outbox_id = NULL (CHECK constraint audit_logs_outbox_id_actor_type_check)", async () => {
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (
            id, tenant_id, scope, action, user_id, actor_type, metadata, created_at
          ) VALUES (
            gen_random_uuid(), $1::uuid,
            $2::"AuditScope", $3::"AuditAction",
            $4::uuid, $5::"ActorType",
            $6::jsonb, now()
          )`,
          tenantIdA,
          AUDIT_SCOPE.TENANT,
          AUDIT_ACTION.SHARE_ACCESS_VERIFY_FAILED,
          ANONYMOUS_ACTOR_ID,
          ACTOR_TYPE.ANONYMOUS,
          JSON.stringify({}),
        );
      }),
    ).rejects.toThrow(/audit_logs_outbox_id_actor_type_check/);
  });
});
