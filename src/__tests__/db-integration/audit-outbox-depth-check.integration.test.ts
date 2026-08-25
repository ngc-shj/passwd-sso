/**
 * Regression: `outbox.depth.check_failed` — the depth query ran on a bare
 * pooled connection, outside any bypass transaction, and raised Postgres
 * 22P02 (`invalid input syntax for type uuid: ""`) once that connection had
 * served one bypass transaction. It failed every 30s for 1821+ iterations in
 * production, which meant `outbox.depth.alert` could never fire at all.
 *
 * Why this has to be a real-DB test: the defect is connection-scoped state.
 * A custom GUC set with `SET LOCAL` reverts at transaction end to the SESSION
 * DEFAULT — which is '' once the GUC has been touched — not to unset. The
 * mocked `$transaction` in audit-outbox-worker.test.ts hands back a plain
 * object with no connection, no session and no GUCs, so those 38 tests pass
 * identically against the buggy and the fixed code.
 *
 * `max: 1` is load-bearing. At the default pool size the second statement may
 * land on a fresh connection where the GUC was never touched, and the whole
 * file would pass against the unfixed code.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPrismaForRole,
  setBypassRlsGucs,
  sqlStateOf,
  type PrismaWithPool,
} from "./helpers";
import { readOutboxDepth } from "@/workers/audit-outbox-worker";

describe("audit_outbox depth check on a pooled connection", () => {
  // passwd_outbox_worker: NOBYPASSRLS, and audit_outbox is FORCE ROW LEVEL
  // SECURITY — so the RLS predicate really is evaluated for this role.
  let wp: PrismaWithPool;
  // passwd_outbox_worker holds SELECT/UPDATE/DELETE on audit_outbox but NOT
  // INSERT, so the probe row is seeded through the superuser role.
  let su: PrismaWithPool;

  beforeAll(() => {
    wp = createPrismaForRole("worker", { max: 1 });
    su = createPrismaForRole("superuser");
  });

  afterAll(async () => {
    await wp.prisma.$disconnect();
    await wp.pool.end();
    await su.prisma.$disconnect();
    await su.pool.end();
  });

  /** Put the single pooled connection into the state the worker leaves it in. */
  async function poisonGuc(): Promise<void> {
    await wp.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
    });
  }

  it("leaves app.tenant_id as empty string, not unset, after a bypass transaction", async () => {
    // Precondition asserted, not inferred: if this ever returns null the two
    // tests below stop testing anything and would silently pass.
    await poisonGuc();
    const [row] = await wp.prisma.$queryRawUnsafe<
      Array<{ tenant_id: string | null }>
    >(`SELECT current_setting('app.tenant_id', true) AS tenant_id`);
    expect(row.tenant_id).toBe("");
  });

  it("rejects with 22P02 when the depth query runs outside a bypass transaction", async () => {
    // The control clause: this is the pre-fix shape. It proves the poisoning
    // is real, so the passing test below cannot be passing for a stale reason.
    await poisonGuc();
    let sqlState: string | null = null;
    try {
      await wp.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS pending FROM audit_outbox WHERE status = 'PENDING'`,
      );
    } catch (err) {
      sqlState = sqlStateOf(err);
    }
    expect(sqlState).toBe("22P02");
  });

  it("returns a correct depth on that same connection via readOutboxDepth", async () => {
    await poisonGuc();

    const before = await readOutboxDepth(wp.prisma);
    expect(Number.isInteger(before.pending)).toBe(true);

    // Delta, not an absolute count: the dev DB is shared, and asserting
    // `>= 0` would pass no matter what the query returned.
    const ids: string[] = [];
    await su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO audit_outbox
           (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         SELECT gen_random_uuid(), t.id, '{"probe":"depth-check"}'::jsonb,
                'PENDING', 0, 5, now(), now()
         FROM tenants t LIMIT 1
         RETURNING id`,
      );
      rows.forEach((r) => ids.push(r.id));
    });
    expect(ids).toHaveLength(1);

    try {
      const after = await readOutboxDepth(wp.prisma);
      expect(after.pending - before.pending).toBe(1);
    } finally {
      // Cleanup on the failure path too — a leaked PENDING row would be
      // drained by a live worker and skew a later run.
      await su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        // audit_outbox_before_delete_guard only permits deleting SENT/FAILED
        // rows, so the probe has to be retired before it can be removed.
        await tx.$executeRawUnsafe(
          `UPDATE audit_outbox SET status = 'SENT', sent_at = now() WHERE id = $1::uuid`,
          ids[0],
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_outbox WHERE id = $1::uuid`,
          ids[0],
        );
      });
    }
  });
});
