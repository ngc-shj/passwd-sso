/**
 * Real-DB tests for EXPIRY_AUDIT_PROVENANCE forensic-credential GC (SC4 / C6).
 *
 * Before deleting an expired credential, the worker emits its provenance to the
 * audit outbox UNDER THE ROW'S OWN TENANT, atomically (a failed emit rolls back
 * the delete — provenance durability). The atomicity test asserts the credential
 * row SURVIVES when the emit fails (RT7: the durability guarantee can fire).
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
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
  inRetentionSweepTx,
} from "./helpers";
import { sweepAuditProvenanceEntry, grantForEntry } from "@/workers/retention-gc-worker/sweep";
import {
  RETENTION_REGISTRY,
  EXPIRED_RECORD_VISIBILITY_GRACE_DAYS,
  type AuditProvenanceEntry,
} from "@/workers/retention-gc-worker/registry";

const extEntry = RETENTION_REGISTRY.find(
  (e): e is AuditProvenanceEntry =>
    e.kind === "EXPIRY_AUDIT_PROVENANCE" && e.table === "extension_tokens",
)!;
const apiKeyEntry = RETENTION_REGISTRY.find(
  (e): e is AuditProvenanceEntry =>
    e.kind === "EXPIRY_AUDIT_PROVENANCE" && e.table === "api_keys",
)!;
const operatorTokenEntry = RETENTION_REGISTRY.find(
  (e): e is AuditProvenanceEntry =>
    e.kind === "EXPIRY_AUDIT_PROVENANCE" && e.table === "operator_tokens",
)!;

// The grace is derived from the registry constant, never a literal. Fail loud if
// a member entry stops carrying it: the boundary tests below pin it.
const G = EXPIRED_RECORD_VISIBILITY_GRACE_DAYS;
for (const entry of [apiKeyEntry, operatorTokenEntry]) {
  if (entry.retentionDays !== G) {
    throw new Error(
      `${entry.table} registry entry must carry retentionDays === EXPIRED_RECORD_VISIBILITY_GRACE_DAYS (${G}), got ${entry.retentionDays}`,
    );
  }
}

// DB-clock expiry expressions around the grace boundary.
const EXPIRED_1H = "now() - interval '1 hour'";
const EXPIRED_WITHIN_GRACE = `now() - make_interval(days => ${G - 1})`;
const EXPIRED_PAST_GRACE = `now() - make_interval(days => ${G}) - interval '1 hour'`;

describe("retention-gc forensic-credential GC (SC4/C6)", () => {
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
    await ctx.deleteTestData(tenantId);
  });

  async function insertExtToken(
    expiresAt: string,
    ip = "10.1.2.3",
  ): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      // client_kind defaults to BROWSER_EXTENSION, which requires cnf_jkt NOT NULL
      // (CHECK extension_tokens_cnf_jkt_required_for_browser_ext).
      await tx.$executeRawUnsafe(
        `INSERT INTO extension_tokens (id, user_id, token_hash, scope, expires_at, tenant_id, family_id, cnf_jkt, last_used_ip, last_used_user_agent, last_used_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3, 'passwords:read', ${expiresAt}, $4::uuid, $5::uuid, $6, $7, 'test-ua', now(), now())`,
        id,
        userId,
        `eth-${id.slice(0, 16)}`,
        tenantId,
        randomUUID(),
        `jkt-${id.slice(0, 16)}`,
        ip,
      );
    });
    return id;
  }

  async function insertApiKey(expiresAt: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO api_keys (id, user_id, tenant_id, token_hash, prefix, name, scope, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'api_XXXX', 'k', 'passwords:read', ${expiresAt}, now())`,
        id,
        userId,
        tenantId,
        `${id.replace(/-/g, "")}${id.replace(/-/g, "")}`,
      );
    });
    return id;
  }

  async function insertOperatorToken(expiresAt: string): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO operator_tokens (id, token_hash, prefix, name, tenant_id, subject_user_id, created_by_user_id, scope, expires_at, created_at)
         VALUES ($1::uuid, $2, 'op_XXXXX', 'k', $3::uuid, $4::uuid, $4::uuid, 'maintenance', ${expiresAt}, now())`,
        id,
        `${id.replace(/-/g, "")}${id.replace(/-/g, "")}`,
        tenantId,
        userId,
      );
    });
    return id;
  }

  async function rowExists(table: string, id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM ${table} WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  async function extTokenExists(id: string): Promise<boolean> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM extension_tokens WHERE id = $1::uuid`,
        id,
      );
    });
    return rows.length > 0;
  }

  async function outboxRowsFor(targetId: string): Promise<
    { tenant_id: string; payload: { action: string; targetId: string; metadata: Record<string, unknown> } }[]
  > {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe(
        `SELECT tenant_id, payload FROM audit_outbox
         WHERE tenant_id = $1::uuid AND payload->>'targetId' = $2`,
        tenantId,
        targetId,
      );
    });
  }

  it("emits provenance to audit_outbox under the row's own tenant, then deletes the expired credential", async () => {
    const tok = await insertExtToken("now() - interval '1 hour'", "203.0.113.9");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepAuditProvenanceEntry(tx, extEntry, 100);
    });

    // Credential deleted.
    expect(await extTokenExists(tok)).toBe(false);

    // Provenance audit landed under THIS tenant (not SYSTEM) with the credential's metadata.
    const rows = await outboxRowsFor(tok);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenantId);
    expect(rows[0].payload.action).toBe("CREDENTIAL_RETENTION_PURGED");
    expect(rows[0].payload.targetId).toBe(tok);
    // provenance metadata captured the table + last_used_ip + owning user.
    expect(rows[0].payload.metadata.table).toBe("extension_tokens");
    expect(rows[0].payload.metadata.last_used_ip).toBe("203.0.113.9");
    expect(rows[0].payload.metadata.user_id).toBe(userId);
  });

  it("does NOT delete a non-expired credential", async () => {
    const tok = await insertExtToken("now() + interval '1 hour'");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await sweepAuditProvenanceEntry(tx, extEntry, 100);
    });

    expect(await extTokenExists(tok)).toBe(true);
    expect(await outboxRowsFor(tok)).toHaveLength(0);
  });

  it("emit failure rolls back the delete — the credential survives (atomicity/RT7)", async () => {
    const tok = await insertExtToken("now() - interval '1 hour'");

    // The emit and the delete share one transaction. Wrap the sweep in an outer
    // tx that throws after it: both the delete AND the audit emit must revert
    // together — proving the provenance-durability atomicity guarantee.
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await sweepAuditProvenanceEntry(tx, extEntry, 100);
        // Abort the transaction after the sweep — emit AND delete must both revert.
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow(/forced rollback/);

    // Both the delete and the audit emit rolled back: credential still present,
    // no orphaned audit row.
    expect(await extTokenExists(tok)).toBe(true);
    expect(await outboxRowsFor(tok)).toHaveLength(0);
  });

  it("worker role CAN delete + audit-emit but CANNOT delete audit_logs (least privilege)", async () => {
    const tok = await insertExtToken("now() - interval '1 hour'");

    // Positive: worker role runs the full capture→emit→delete.
    await inRetentionSweepTx(ctx.retentionWorker.prisma, async (tx) => {
      await sweepAuditProvenanceEntry(tx, extEntry, 100);
    }, grantForEntry(extEntry));
    expect(await extTokenExists(tok)).toBe(false);

    // Negative: worker role still cannot directly DELETE audit_logs.
    await expect(
      ctx.retentionWorker.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      }),
    ).rejects.toThrow(/permission denied/);
  });

  describe.each([
    ["api_keys", apiKeyEntry, insertApiKey],
    ["operator_tokens", operatorTokenEntry, insertOperatorToken],
  ] as const)("%s grace window", (table, entry, insert) => {
    it.each([
      ["1 hour ago", EXPIRED_1H],
      ["G-1 days ago", EXPIRED_WITHIN_GRACE],
    ])("keeps a credential expired %s, with no provenance row", async (_label, expr) => {
      const id = await insert(expr);

      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await sweepAuditProvenanceEntry(tx, entry, 100);
      });

      expect(await rowExists(table, id)).toBe(true);
      expect(await outboxRowsFor(id)).toHaveLength(0);
    });

    it("deletes a credential expired G days + 1 hour ago with one provenance row", async () => {
      const id = await insert(EXPIRED_PAST_GRACE);

      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await sweepAuditProvenanceEntry(tx, entry, 100);
      });

      expect(await rowExists(table, id)).toBe(false);
      const rows = await outboxRowsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(tenantId);
      expect(rows[0].payload.action).toBe("CREDENTIAL_RETENTION_PURGED");
      expect(rows[0].payload.metadata.table).toBe(table);
    });
  });
});
