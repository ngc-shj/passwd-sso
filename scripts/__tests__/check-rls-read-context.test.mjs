/**
 * Self-test for check-rls-read-context.mjs.
 *
 * The gate exists because three real defects shipped past a gate that matched
 * helper NAMES, so the cases below are the shapes of those defects, not
 * invented ones:
 *   - a bare model read   (audit-outbox processDeliveryBatch, audit-chain-verify)
 *   - a bare raw-SQL read (audit-outbox checkDepthAlert)
 * Each is paired with the wrapped form that must stay green — a gate that only
 * denies is one nobody can adopt.
 *
 * Runs the gate as a subprocess against a synthetic repo root, so the scan
 * root, manifest and schema are all fixture-controlled and no case depends on
 * the state of the real tree.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GATE = join(REPO_ROOT, "scripts/checks/check-rls-read-context.mjs");

const MANIFEST = ["audit_outbox", "audit_logs"].join("\n");
const SCHEMA = `
model AuditOutbox {
  id String @id
  @@map("audit_outbox")
}
model AuditLog {
  id String @id
  @@map("audit_logs")
}
model Tenant {
  id String @id
  @@map("tenants")
}
`;

let root;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rls-read-ctx-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "prisma"), { recursive: true });
  mkdirSync(join(root, "src/workers"), { recursive: true });
  writeFileSync(
    join(root, "scripts/rls-cross-tenant-tables.manifest"),
    MANIFEST,
  );
  writeFileSync(join(root, "prisma/schema.prisma"), SCHEMA);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write one worker file and run the gate over src/workers. */
function runGate(source, { dirs = "src/workers" } = {}) {
  if (source !== null) {
    writeFileSync(join(root, "src/workers/subject.ts"), source);
  }
  return spawnSync("node", [GATE], {
    encoding: "utf8",
    env: {
      ...process.env,
      RLS_READ_CONTEXT_ROOT: root,
      RLS_READ_CONTEXT_DIRS: dirs,
    },
  });
}

describe("check-rls-read-context", () => {
  it("FAILS a bare model read on an RLS table", () => {
    const r = runGate(`
      export async function f(prisma: any) {
        return prisma.auditOutbox.findMany({ where: { id: { in: [] } } });
      }
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("audit_outbox");
  });

  it("FAILS a bare raw-SQL read naming an RLS table", () => {
    const r = runGate(`
      export async function f(prisma: any) {
        return prisma.$queryRawUnsafe(
          "SELECT COUNT(*) FROM audit_outbox WHERE status = 'PENDING'",
        );
      }
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("audit_outbox");
  });

  it("PASSES the same read wrapped in a $transaction callback", () => {
    // Allow side. Without it a gate that flagged every statement would satisfy
    // both deny cases and be reverted the first time someone ran it.
    const r = runGate(`
      export async function f(prisma: any) {
        return prisma.$transaction(async (tx: any) => {
          await setBypassRlsGucs(tx);
          return tx.auditOutbox.findMany({});
        });
      }
      declare function setBypassRlsGucs(tx: any): Promise<void>;
    `);
    expect(r.status).toBe(0);
  });

  it("PASSES a transaction client threaded into a helper by type", () => {
    // reapStuckRowsInTx(tx, ...) is this shape; treating it as a violation
    // would flag 8 correct call sites in audit-outbox-worker alone.
    const r = runGate(`
      import type { Prisma } from "@prisma/client";
      export async function helper(tx: Prisma.TransactionClient) {
        return tx.auditOutbox.findMany({});
      }
    `);
    expect(r.status).toBe(0);
  });

  it("PASSES a table with no tenant_isolation policy", () => {
    // tenants is the tenancy root and carries no policy; flagging it would be
    // a false positive that trains readers to ignore the gate.
    const r = runGate(`
      export async function f(prisma: any) {
        return prisma.tenant.findMany({});
      }
    `);
    expect(r.status).toBe(0);
  });

  it("PASSES a script that refuses to run without RLS visibility", () => {
    const r = runGate(`
      import { assertRlsVisibility } from "./lib/assert-rls-visibility";
      export async function f(prisma: any) {
        await assertRlsVisibility(prisma, "fixture");
        return prisma.auditOutbox.findMany({});
      }
    `);
    expect(r.status).toBe(0);
  });

  it("FAILS LOUDLY when the scan root resolves to no files", () => {
    // "Examined nothing" must not be spelled like "found nothing wrong" — the
    // shape that lets a gate report PASS forever after a directory rename.
    const r = runGate(null, { dirs: "src/does-not-exist" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("scanned 0 source files");
  });

  it("FAILS LOUDLY when the manifest is unreadable", () => {
    const bare = mkdtempSync(join(tmpdir(), "rls-read-ctx-empty-"));
    try {
      const r = spawnSync("node", [GATE], {
        encoding: "utf8",
        env: {
          ...process.env,
          RLS_READ_CONTEXT_ROOT: bare,
          RLS_READ_CONTEXT_DIRS: "src/workers",
        },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("cannot read");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
