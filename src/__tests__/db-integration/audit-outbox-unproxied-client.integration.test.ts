/**
 * C1 / I1.1 — the outbox openers run on the un-proxied client.
 *
 * This is the ONLY enforcement of that invariant. It is not gate-checked, and
 * two review rounds each nominated a static gate that turned out to decide a
 * different predicate: `check-rls-read-context.mjs` asks whether a GUC is
 * established on the receiver of an RLS-table statement, which `prisma` and
 * `prismaBase` satisfy identically. Which client opened the transaction is
 * decided by the database, so it is asked here.
 *
 * Two observations per opener, and both are needed:
 *
 *   - a DIFFERENT `txid_current()` than the caller's. Under the Proxy the
 *     nested `$transaction` is not a transaction at all — the callback runs on
 *     the outer client — so equal txids are the defect's signature.
 *   - the caller's GUCs UNCHANGED afterwards. `set_config(..., true)` is
 *     transaction-local, so a genuinely separate transaction cannot reach them;
 *     under the fold the three the openers set land on the caller and stay for
 *     the rest of its transaction.
 *
 * Read `app.bypass_purpose` as well as `app.bypass_rls`: inside a BYPASS context
 * the first two are already set to the values the fold would write, so purpose
 * is the only one that moves there. Checking only `bypass_rls` would pass on the
 * defect in exactly the configuration the one live in-context emit occupied.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, type TestContext } from "./helpers";
import { enqueueAudit, enqueueAuditBulk, type AuditOutboxPayload } from "@/lib/audit/audit-outbox";
import { prisma } from "@/lib/prisma";
import { withTenantRls, withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

type GucSnapshot = { bypass_rls: string | null; tenant_id: string | null; bypass_purpose: string | null };

describe("outbox openers run on the un-proxied client (C1)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  // Marker-scoped, so every assertion below counts only this test's rows —
  // the sentinel tenant's outbox rows are steady state in this deployment and
  // a tenant-scoped count would measure the background.
  let marker: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    marker = randomUUID();
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  function payload(): AuditOutboxPayload {
    return {
      scope: "PERSONAL",
      action: "ENTRY_CREATE",
      userId,
      actorType: "HUMAN",
      serviceAccountId: null,
      teamId: null,
      targetType: "PasswordEntry",
      targetId: marker,
      metadata: null,
      ip: "127.0.0.1",
      userAgent: "integration-test",
    };
  }

  async function readGucs(tx: { $queryRaw: typeof prisma.$queryRaw }): Promise<GucSnapshot> {
    const [row] = await tx.$queryRaw<GucSnapshot[]>`
      SELECT current_setting('app.bypass_rls', true)     AS bypass_rls,
             current_setting('app.tenant_id', true)      AS tenant_id,
             current_setting('app.bypass_purpose', true) AS bypass_purpose`;
    return row;
  }

  async function txid(tx: { $queryRaw: typeof prisma.$queryRaw }): Promise<string> {
    // `pg_current_xact_id()::xid`, not `txid_current()`. The former is xid8
    // (epoch-extended); the rows are compared against `xmin`, which is a 32-bit
    // xid. They agree only while the xid epoch is 0 — after one wraparound the
    // inequality assertion below would hold unconditionally, INCLUDING under the
    // defect it exists to catch. Casting to `xid` truncates to the same width,
    // so the comparison stays meaningful for the life of the database.
    const [row] = await tx.$queryRaw<{ txid: string }[]>`
      SELECT pg_current_xact_id()::xid::text AS txid`;
    return row.txid;
  }

  it("enqueueAudit writes under its own txid and leaves the caller's tenant-context GUCs alone", async () => {
    let outerTxid = "";
    let before: GucSnapshot = { bypass_rls: null, tenant_id: null, bypass_purpose: null };
    let after: GucSnapshot = before;

    await withTenantRls(prisma, tenantId, async (tx) => {
      outerTxid = await txid(tx);
      before = await readGucs(tx);
      // With tenantId supplied, resolveTenantId is not involved — this is the
      // configuration in which the fold was reachable through the emit path.
      await enqueueAudit(tenantId, payload());
      after = await readGucs(tx);
    });

    expect(after).toEqual(before);
    expect(after.bypass_rls).not.toBe("on");
    expect(after.tenant_id).toBe(tenantId);

    const rows = await ctx.su.prisma.$queryRaw<{ txid: string }[]>`
      SELECT xmin::text AS txid FROM audit_outbox
       WHERE payload->>'targetId' = ${marker}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].txid).not.toBe(outerTxid);
  });

  it("enqueueAuditBulk does the same, for a batch", async () => {
    // The invariant is quantified over BOTH openers. A conversion that left
    // this one on the Proxy would be green in every suite and every gate if
    // only the singular path were pinned.
    let outerTxid = "";
    let before: GucSnapshot = { bypass_rls: null, tenant_id: null, bypass_purpose: null };
    let after: GucSnapshot = before;

    await withTenantRls(prisma, tenantId, async (tx) => {
      outerTxid = await txid(tx);
      before = await readGucs(tx);
      await enqueueAuditBulk(tenantId, [payload(), payload()]);
      after = await readGucs(tx);
    });

    expect(after).toEqual(before);

    const rows = await ctx.su.prisma.$queryRaw<{ txid: string }[]>`
      SELECT xmin::text AS txid FROM audit_outbox
       WHERE payload->>'targetId' = ${marker}`;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.txid).not.toBe(outerTxid);
  });

  it("leaves app.bypass_purpose alone inside a bypass context", async () => {
    // The cell the one live in-context emit occupied. bypass_rls and tenant_id
    // already hold the values the fold would write, so purpose is the only GUC
    // that moves — and it is the one an operator reads to learn why RLS was
    // bypassed for a statement.
    let before: GucSnapshot = { bypass_rls: null, tenant_id: null, bypass_purpose: null };
    let after: GucSnapshot = before;

    await withBypassRls(prisma, async (tx) => {
      before = await readGucs(tx);
      await enqueueAudit(tenantId, payload());
      after = await readGucs(tx);
    }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

    expect(before.bypass_purpose).toBe(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
    expect(after.bypass_purpose).toBe(BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
    expect(after).toEqual(before);
  });

  it("still writes its row when no context is active", async () => {
    // The allow side. Without it, an opener that stopped writing entirely would
    // satisfy every GUC assertion above.
    await enqueueAudit(tenantId, payload());

    const rows = await ctx.su.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM audit_outbox WHERE payload->>'targetId' = ${marker}`;
    expect(Number(rows[0].n)).toBe(1);
  });
});
