/**
 * Integration test (real DB, worker role): no delivery to a deactivated audit
 * delivery target (containment-followups-plan C6).
 *
 * - The delivery claim takes only rows whose target is active, so a
 *   deactivated target's backlog (fresh and retry rows) stays PENDING, unsent.
 * - expireInactiveTargetDeliveriesInTx moves PENDING rows of an inactive
 *   target older than the injected cutoff to FAILED, each with one dead-letter
 *   audit row, under the OUTBOX_DELIVERY_EXPIRY grant as passwd_outbox_worker.
 * - Overlapping passes are disjoint (FOR UPDATE SKIP LOCKED) and ordered
 *   against a concurrent re-activation (FOR SHARE OF t).
 *
 * The claim is table-wide, so every assertion is made on this file's own row
 * ids. Run: npm run test:integration -- audit-delivery-inactive-target
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { createRaceHelpers, holdPrismaWriter } from "./race-helpers";
import { AUDIT_ACTION, AUDIT_OUTBOX } from "@/lib/constants/audit/audit";
import { MS_PER_HOUR } from "@/lib/constants/time";
import { BYPASS_GRANT, setBypassGucs } from "@/lib/tenant-rls-grants";

const { mockDeliver } = vi.hoisted(() => ({ mockDeliver: vi.fn() }));

// The deliverer is the network boundary; decryption of the placeholder target
// config is stubbed so a claimed row really reaches the deliverer.
vi.mock("@/workers/audit-delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/workers/audit-delivery")>();
  return { ...actual, DELIVERERS: { WEBHOOK: { deliver: mockDeliver } } };
});
vi.mock("@/lib/crypto/crypto-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/crypto-server")>();
  return {
    ...actual,
    decryptServerData: () => "{}",
    getMasterKeyByVersion: () => Buffer.alloc(32),
  };
});
vi.mock("@/lib/crypto/share-master-keys", () => ({ warmShareMasterKeys: async () => {} }));

import {
  expireInactiveTargetDeliveriesInTx,
  processDeliveryBatch,
  purgeRetention,
  purgeSentAgedInTx,
} from "@/workers/audit-outbox-worker";

const HELD_TX_TIMEOUT_MS = 30_000;
const BIG_BATCH = 1000;
const PAST = "now() - interval '1 hour'";

type DeliveryRow = { id: string; status: string; attempt_count: number; last_error: string | null };

describe("audit delivery to an inactive target (C6)", () => {
  let ctx: TestContext;
  let race: ReturnType<typeof createRaceHelpers>;
  let tenantId: string;
  // Fixed injected cutoff: rows are backdated relative to it, never the wall clock.
  const cutoff = new Date(Date.now() - 48 * MS_PER_HOUR);
  const oldAt = new Date(cutoff.getTime() - MS_PER_HOUR);
  const youngAt = new Date(cutoff.getTime() + MS_PER_HOUR);

  beforeAll(async () => {
    ctx = await createTestContext();
    race = createRaceHelpers(ctx.su.pool);
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    mockDeliver.mockReset();
    mockDeliver.mockResolvedValue(undefined);
    tenantId = await ctx.createTenant();
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  // ─── seeding and reading (superuser, test setup) ───────────────

  async function sql<T = unknown>(query: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(query, ...params);
    });
  }

  async function seedTarget(isActive: boolean): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO audit_delivery_targets (
         id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
         master_key_version, is_active, created_at
       ) VALUES ($1::uuid, $2::uuid, 'WEBHOOK', 'enc', 'iv', 'tag', 1, $3, now())`,
      id,
      tenantId,
      isActive,
    );
    return id;
  }

  /** A SENT outbox row plus one PENDING delivery of it to `targetId`. */
  async function seedDelivery(
    targetId: string,
    opts: { createdAt?: Date; attemptCount?: number; outboxSentHoursAgo?: number } = {},
  ): Promise<{ deliveryId: string; outboxId: string }> {
    const outboxId = randomUUID();
    const deliveryId = randomUUID();
    const sentHoursAgo = opts.outboxSentHoursAgo ?? 1;
    await sql(
      `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
       VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', now() - make_interval(hours => $4))`,
      outboxId,
      tenantId,
      JSON.stringify({ scope: "TENANT", action: "ENTRY_CREATE", userId: randomUUID(), actorType: "HUMAN" }),
      sentHoursAgo,
    );
    await sql(
      `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status, attempt_count, next_retry_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING', $5, ${PAST}, $6::timestamptz)`,
      deliveryId,
      outboxId,
      targetId,
      tenantId,
      opts.attemptCount ?? 0,
      opts.createdAt ?? new Date(),
    );
    return { deliveryId, outboxId };
  }

  async function setActive(targetId: string, isActive: boolean): Promise<void> {
    await sql(`UPDATE audit_delivery_targets SET is_active = $2 WHERE id = $1::uuid`, targetId, isActive);
  }

  async function deliveriesOf(ids: string[]): Promise<Map<string, DeliveryRow>> {
    const rows = await sql<DeliveryRow>(
      `SELECT id, status::text AS status, attempt_count, last_error FROM audit_deliveries WHERE id = ANY($1::uuid[])`,
      ids,
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  async function deadLettersOf(ids: string[]): Promise<Map<string, Array<Record<string, unknown>>>> {
    const rows = await sql<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
       WHERE tenant_id = $1::uuid AND action = $2::"AuditAction" AND metadata->>'deliveryId' = ANY($3::text[])`,
      tenantId,
      AUDIT_ACTION.AUDIT_DELIVERY_DEAD_LETTER,
      ids,
    );
    const byDelivery = new Map<string, Array<Record<string, unknown>>>();
    for (const r of rows) {
      const key = r.metadata.deliveryId as string;
      byDelivery.set(key, [...(byDelivery.get(key) ?? []), r.metadata]);
    }
    return byDelivery;
  }

  async function outboxExists(outboxId: string): Promise<boolean> {
    return (await sql(`SELECT 1 FROM audit_outbox WHERE id = $1::uuid`, outboxId)).length === 1;
  }

  // ─── the passes under test (worker role, real grants) ──────────

  function expire(cutoffAt: Date, limit: number): Promise<number> {
    return ctx.worker.prisma.$transaction(async (tx) => {
      await setBypassGucs(tx, BYPASS_GRANT.OUTBOX_DELIVERY_EXPIRY);
      return expireInactiveTargetDeliveriesInTx(tx, cutoffAt, limit);
    });
  }

  function deliveredOutboxIds(): string[] {
    return mockDeliver.mock.calls.map((c) => (c[1] as { id: string }).id);
  }

  // ─── claim ──────────────────────────────────────────────────────

  describe("claim", () => {
    it("does not claim or deliver due fresh and retry rows of an inactive target, and claims the same rows once re-activated", async () => {
      const inactive = await seedTarget(false);
      const fresh = await seedDelivery(inactive);
      const retry = await seedDelivery(inactive, { attemptCount: 2 });
      const mine = [fresh, retry];

      await processDeliveryBatch(ctx.worker.prisma, BIG_BATCH);

      expect(deliveredOutboxIds()).not.toContain(fresh.outboxId);
      expect(deliveredOutboxIds()).not.toContain(retry.outboxId);
      const parked = await deliveriesOf(mine.map((d) => d.deliveryId));
      expect(parked.get(fresh.deliveryId)).toMatchObject({ status: "PENDING", attempt_count: 0 });
      expect(parked.get(retry.deliveryId)).toMatchObject({ status: "PENDING", attempt_count: 2 });

      await setActive(inactive, true);
      await processDeliveryBatch(ctx.worker.prisma, BIG_BATCH);

      expect(deliveredOutboxIds()).toContain(fresh.outboxId);
      expect(deliveredOutboxIds()).toContain(retry.outboxId);
      const sent = await deliveriesOf(mine.map((d) => d.deliveryId));
      expect(sent.get(fresh.deliveryId)?.status).toBe("SENT");
      expect(sent.get(retry.deliveryId)?.status).toBe("SENT");
    });

    it("claims and delivers a row of an active target while an inactive target's row beside it stays parked", async () => {
      const active = await seedTarget(true);
      const inactive = await seedTarget(false);
      const live = await seedDelivery(active);
      const parked = await seedDelivery(inactive);

      await processDeliveryBatch(ctx.worker.prisma, BIG_BATCH);

      expect(deliveredOutboxIds()).toContain(live.outboxId);
      expect(deliveredOutboxIds()).not.toContain(parked.outboxId);
      const rows = await deliveriesOf([live.deliveryId, parked.deliveryId]);
      expect(rows.get(live.deliveryId)?.status).toBe("SENT");
      expect(rows.get(parked.deliveryId)?.status).toBe("PENDING");
    });
  });

  // ─── expiry ─────────────────────────────────────────────────────

  describe("expiry", () => {
    it("expires an old row of an inactive target with one dead-letter row; a younger one and an active target's old row stay PENDING", async () => {
      const inactive = await seedTarget(false);
      const active = await seedTarget(true);
      const old = await seedDelivery(inactive, { createdAt: oldAt });
      const young = await seedDelivery(inactive, { createdAt: youngAt });
      const activeOld = await seedDelivery(active, { createdAt: oldAt });
      const ids = [old, young, activeOld].map((d) => d.deliveryId);

      expect(await expire(cutoff, BIG_BATCH)).toBeGreaterThanOrEqual(1);

      const rows = await deliveriesOf(ids);
      expect(rows.get(old.deliveryId)).toMatchObject({ status: "FAILED", last_error: "target inactive" });
      expect(rows.get(young.deliveryId)?.status).toBe("PENDING");
      expect(rows.get(activeOld.deliveryId)?.status).toBe("PENDING");

      const dead = await deadLettersOf(ids);
      expect(dead.get(old.deliveryId)).toEqual([
        { deliveryId: old.deliveryId, targetId: inactive, error: "target inactive" },
      ]);
      expect(dead.has(young.deliveryId)).toBe(false);
      expect(dead.has(activeOld.deliveryId)).toBe(false);
    });

    it("leaves the target's failCount alone", async () => {
      const inactive = await seedTarget(false);
      await seedDelivery(inactive, { createdAt: oldAt });
      await expire(cutoff, BIG_BATCH);
      const [target] = await sql<{ fail_count: number }>(
        `SELECT fail_count FROM audit_delivery_targets WHERE id = $1::uuid`,
        inactive,
      );
      expect(target.fail_count).toBe(0);
    });

    it("a second pass writes no further dead-letter row", async () => {
      const inactive = await seedTarget(false);
      const old = await seedDelivery(inactive, { createdAt: oldAt });
      await expire(cutoff, BIG_BATCH);
      await expire(cutoff, BIG_BATCH);
      expect((await deadLettersOf([old.deliveryId])).get(old.deliveryId)).toHaveLength(1);
    });

    it("processes only `limit` rows per pass and drains the remainder on the next", async () => {
      const inactive = await seedTarget(false);
      const seeded: string[] = [];
      for (let i = 0; i < 5; i++) {
        seeded.push((await seedDelivery(inactive, { createdAt: new Date(oldAt.getTime() + i) })).deliveryId);
      }
      const failedCount = async () =>
        [...(await deliveriesOf(seeded)).values()].filter((r) => r.status === "FAILED").length;

      expect(await expire(cutoff, 3)).toBe(3);
      expect(await failedCount()).toBe(3);
      expect(await expire(cutoff, 3)).toBe(2);
      expect(await failedCount()).toBe(5);
    });

    it("after expiry and re-activation the FAILED rows are not claimed and a new event is", async () => {
      const inactive = await seedTarget(false);
      const old = await seedDelivery(inactive, { createdAt: oldAt });
      await expire(cutoff, BIG_BATCH);
      await setActive(inactive, true);
      const fresh = await seedDelivery(inactive);

      await processDeliveryBatch(ctx.worker.prisma, BIG_BATCH);

      expect(deliveredOutboxIds()).not.toContain(old.outboxId);
      expect(deliveredOutboxIds()).toContain(fresh.outboxId);
      const rows = await deliveriesOf([old.deliveryId, fresh.deliveryId]);
      expect(rows.get(old.deliveryId)?.status).toBe("FAILED");
      expect(rows.get(fresh.deliveryId)?.status).toBe("SENT");
    });

    it("releases the outbox row a parked delivery pinned: the SENT purge keeps it before expiry and removes it after", async () => {
      const inactive = await seedTarget(false);
      const old = await seedDelivery(inactive, {
        createdAt: oldAt,
        outboxSentHoursAgo: AUDIT_OUTBOX.RETENTION_HOURS + 1,
      });
      const purgeSent = () =>
        ctx.worker.prisma.$transaction(async (tx) => {
          await setBypassGucs(tx, BYPASS_GRANT.OUTBOX_RETENTION_PURGE);
          return purgeSentAgedInTx(tx, 100_000);
        });

      await purgeSent();
      expect(await outboxExists(old.outboxId)).toBe(true);

      await expire(cutoff, BIG_BATCH);
      await purgeSent();
      expect(await outboxExists(old.outboxId)).toBe(false);
    });

    it("purgeRetention expires and then purges in one call (own tx under the real grant)", async () => {
      const inactive = await seedTarget(false);
      // created_at older than RETENTION_HOURS against the real clock, as purgeRetention computes it.
      const old = await seedDelivery(inactive, {
        createdAt: new Date(Date.now() - (AUDIT_OUTBOX.RETENTION_HOURS + 2) * MS_PER_HOUR),
        outboxSentHoursAgo: AUDIT_OUTBOX.RETENTION_HOURS + 1,
      });

      await purgeRetention(ctx.worker.prisma, { limit: 100_000 });

      expect((await deliveriesOf([old.deliveryId])).get(old.deliveryId)?.status).toBe("FAILED");
      expect(await outboxExists(old.outboxId)).toBe(false);
    });
  });

  // ─── concurrency ────────────────────────────────────────────────

  describe("overlap and re-activation races", () => {
    it("an overlapping pass is not blocked by one holding its pick and takes a disjoint set; one dead-letter row per delivery", async () => {
      const inactive = await seedTarget(false);
      const seeded: string[] = [];
      for (let i = 0; i < 6; i++) {
        seeded.push((await seedDelivery(inactive, { createdAt: new Date(oldAt.getTime() + i) })).deliveryId);
      }

      let aCount = -1;
      const passA = await holdPrismaWriter(
        ctx.worker.prisma,
        async (tx) => {
          await setBypassGucs(tx as Prisma.TransactionClient, BYPASS_GRANT.OUTBOX_DELIVERY_EXPIRY);
          aCount = await expireInactiveTargetDeliveriesInTx(tx as Prisma.TransactionClient, cutoff, 2);
        },
        HELD_TX_TIMEOUT_MS,
      );
      try {
        expect(aCount).toBe(2);

        // B asks for more than is left; SKIP LOCKED hides A's two locked rows.
        const passB = expire(cutoff, 100);
        const outcome = await race.settledOrBlocked(passB, passA.pid, passA.pid);
        expect(outcome).toBe("settled");
        const bCount = await passB;
        expect(bCount).toBeGreaterThan(0);
        expect(aCount + bCount).toBe(seeded.length);
      } finally {
        await passA.release();
      }

      const rows = await deliveriesOf(seeded);
      for (const id of seeded) expect(rows.get(id)?.status).toBe("FAILED");
      const dead = await deadLettersOf(seeded);
      for (const id of seeded) expect(dead.get(id), `dead-letter rows of ${id}`).toHaveLength(1);
    });

    async function heldReactivation(): Promise<{
      targetId: string;
      ids: string[];
      pass: Promise<number>;
      holder: Awaited<ReturnType<typeof holdPrismaWriter>>;
    }> {
      const targetId = await seedTarget(false);
      const ids = [
        (await seedDelivery(targetId, { createdAt: oldAt })).deliveryId,
        (await seedDelivery(targetId, { createdAt: new Date(oldAt.getTime() + 1) })).deliveryId,
      ];
      const holder = await holdPrismaWriter(
        ctx.su.prisma,
        async (tx) => {
          await setBypassRlsGucs(tx);
          await tx.$executeRaw`UPDATE audit_delivery_targets SET is_active = true WHERE id = ${targetId}::uuid`;
        },
        HELD_TX_TIMEOUT_MS,
      );
      const pass = expire(cutoff, BIG_BATCH);
      pass.catch(() => {});
      // Observed waiting on the held re-activation BEFORE it is released.
      try {
        await race.waitForBackendBlockedBy(holder.pid);
      } catch (e) {
        // A pass that never waited ran through; unwind so the failure stays local.
        await holder.abort();
        await pass.catch(() => {});
        throw e;
      }
      return { targetId, ids, pass, holder };
    }

    it("a re-activation held uncommitted makes the pass wait; once it COMMITs the rows stay PENDING with no dead-letter row", async () => {
      const { ids, pass, holder } = await heldReactivation();
      await holder.release();
      await pass;

      const rows = await deliveriesOf(ids);
      for (const id of ids) expect(rows.get(id)?.status).toBe("PENDING");
      expect((await deadLettersOf(ids)).size).toBe(0);
    });

    it("the same held re-activation ROLLED BACK lets the pass expire its rows with one dead-letter row each", async () => {
      const { ids, pass, holder } = await heldReactivation();
      await holder.abort();
      await pass;

      const rows = await deliveriesOf(ids);
      for (const id of ids) expect(rows.get(id)?.status).toBe("FAILED");
      const dead = await deadLettersOf(ids);
      for (const id of ids) expect(dead.get(id)).toHaveLength(1);
    });
  });
});
