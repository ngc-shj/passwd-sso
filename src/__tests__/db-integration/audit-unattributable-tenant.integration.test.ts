/**
 * Real-DB coverage for the unattributable-tenant encoding.
 *
 * `resolveTenantId` used to return null when an event could not be attributed,
 * and both callers then returned WITHOUT enqueuing — no `audit_outbox` row, no
 * `audit_logs` row, one dead-letter log line the shipped forwarder excludes.
 * It now returns `SYSTEM_TENANT_ID`, so the event reaches the outbox.
 *
 * Mocked suites (src/lib/audit/audit.test.ts and its twin) pin the branch. What
 * they cannot show is that the row is ACCEPTED by the database: `audit_outbox`
 * carries an FK to `tenants` with `onDelete: Restrict`, so the encoding only
 * works because the sentinel row actually exists. That is what this file adds.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { createTestContext, type TestContext } from "./helpers";

describe("unattributable audit events", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("the sentinel tenant row exists, which is what makes the encoding writable", async () => {
    // The FK is the reason this is a real-DB case rather than a unit one:
    // audit_outbox.tenant_id references tenants(id) ON DELETE RESTRICT, so an
    // encoding that named a non-existent tenant would fail at insert time and
    // the entry would be lost exactly as before.
    const rows = await ctx.su.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM tenants WHERE id = ${SYSTEM_TENANT_ID}::uuid
    `;
    expect(rows).toHaveLength(1);
  });

  it("no tenant membership grants access to the sentinel tenant", async () => {
    // The access boundary the encoding rests on. /api/tenant/audit-logs scopes
    // by membership, so zero members is what keeps these rows out of every
    // tenant's view — and it is what makes SYSTEM_TENANT_ID an encoding of "no
    // owning tenant" rather than a binding to somebody else's.
    const rows = await ctx.su.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM tenant_members WHERE tenant_id = ${SYSTEM_TENANT_ID}::uuid
    `;
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("the sentinel tenant has no audit-log retention, and that is a recorded decision", async () => {
    // Pins the option (a) decision so a later migration cannot adopt (b)
    // silently. Setting a retention here would bound the growth AND incur the
    // documented chain-verify interaction: audit_log_purge does not renumber
    // chain_seq, so a default fromSeq=1 verify reports a false TAMPER at the
    // first retained row (docs/security/audit-chain-threat-model.md
    // #retention-purge-interaction). If this assertion is ever changed, the
    // change is that decision being revisited, not a test being updated.
    const rows = await ctx.su.prisma.$queryRaw<{ days: number | null }[]>`
      SELECT audit_log_retention_days AS days FROM tenants WHERE id = ${SYSTEM_TENANT_ID}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.days).toBeNull();
  });
});
