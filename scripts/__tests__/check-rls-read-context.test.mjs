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
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
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

  // The exemption needs BOTH the allowlist entry and a resolved call, so these
  // three cases use a real allowlisted path as the fixture filename.
  const EXEMPT_PATH = "scripts/migrate-account-tokens-to-encrypted.ts";

  function runGateAt(relPath, source) {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source);
    return spawnSync("node", [GATE], {
      encoding: "utf8",
      env: {
        ...process.env,
        RLS_READ_CONTEXT_ROOT: root,
        RLS_READ_CONTEXT_DIRS: dirname(relPath),
      },
    });
  }

  it("PASSES an allowlisted script that calls the preflight", () => {
    const r = runGateAt(
      EXEMPT_PATH,
      `
      import { assertRlsVisibility } from "./lib/assert-rls-visibility";
      export async function f(prisma: any) {
        await assertRlsVisibility(prisma, "fixture");
        return prisma.auditOutbox.findMany({});
      }
    `,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("preflight-exempt");
  });

  it("FAILS an allowlisted script whose preflight was removed", () => {
    // The allowlist must not be able to drift away from the control it stands
    // for: being listed cannot save a script that lost its refusal.
    const r = runGateAt(
      EXEMPT_PATH,
      `
      export async function f(prisma: any) {
        return prisma.auditOutbox.findMany({});
      }
    `,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("PREFLIGHT_EXEMPT");
  });

  it("FAILS a NON-allowlisted file that calls the preflight", () => {
    // Calling the helper is not self-service exemption — the allowlist is what
    // makes an exemption visible in a diff.
    const r = runGate(`
      import { assertRlsVisibility } from "./lib/assert-rls-visibility";
      export async function f(prisma: any) {
        await assertRlsVisibility(prisma, "fixture");
        return prisma.auditOutbox.findMany({});
      }
    `);
    expect(r.status).not.toBe(0);
  });

  it("FAILS a bare tagged-template raw read", () => {
    // The dominant raw form in this repo. A TaggedTemplateExpression is a
    // different AST node from a CallExpression, so walking only calls skipped
    // it entirely while RAW_METHODS advertised coverage.
    const r = runGate(`
      export async function f(prisma: any) {
        return prisma.$queryRaw\`SELECT count(*) FROM audit_outbox\`;
      }
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("audit_outbox");
  });

  it("PASSES a tagged-template raw read inside a context callback", () => {
    const r = runGate(`
      import { withBypassRls } from "@/lib/tenant-rls";
      export async function f(prisma: any) {
        return withBypassRls(prisma, async (tx: any) =>
          tx.$queryRaw\`SELECT count(*) FROM audit_outbox\`, "audit_write");
      }
    `);
    expect(r.status).toBe(0);
  });

  it("FAILS a bare $transaction whose callback never sets the GUC", () => {
    // $transaction opens a transaction; it does not establish an RLS context.
    // This is the exact shape of the checkDepthAlert defect.
    const r = runGate(`
      export async function f(prisma: any) {
        return prisma.$transaction(async (tx: any) => tx.auditOutbox.findMany({}));
      }
    `);
    expect(r.status).not.toBe(0);
  });

  it("REPORTS raw SQL it cannot read instead of skipping it", () => {
    // "Unreadable" must not be spelled like "touches no RLS table".
    const r = runGate(`
      const SQL = "SELECT id FROM audit_outbox";
      export async function f(prisma: any) {
        return prisma.$queryRawUnsafe(SQL);
      }
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("UNRESOLVED");
  });

  it("FAILS a file that only MENTIONS assertRlsVisibility in a comment", () => {
    // Deny counterpart to the exemption case. A substring test over the file
    // text would pass this, which is why the exemption resolves the call.
    const r = runGate(`
      // TODO: call assertRlsVisibility(prisma, "subject") before the scan.
      export async function f(prisma: any) {
        return prisma.auditOutbox.findMany({});
      }
    `);
    expect(r.status).not.toBe(0);
  });

  it("PASSES a one-hop alias of a context binding", () => {
    // Allow side for alias resolution: flagging correct code is the pressure
    // that gets a gate routed around.
    const r = runGate(`
      import { withTenantRls } from "@/lib/tenant-rls";
      export async function f(prisma: any, t: string) {
        return withTenantRls(prisma, t, async (tx: any) => {
          const db = tx;
          return db.auditOutbox.findMany({});
        });
      }
    `);
    expect(r.status).toBe(0);
  });

  it("FAILS a one-hop alias of the bare client", () => {
    const r = runGate(`
      export async function f(prisma: any) {
        const p = prisma;
        return p.auditOutbox.findMany({});
      }
    `);
    expect(r.status).not.toBe(0);
  });

  it("REFUSES scan-scope overrides in CI without fixture mode", () => {
    // The overrides exist for this file. Left ungated they are a way to
    // silently narrow what CI examines — a wrong-but-non-empty scope prints OK.
    const r = spawnSync("node", [GATE], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
        RLS_READ_CONTEXT_ROOT: root,
        RLS_READ_CONTEXT_DIRS: "src/workers",
        RLS_READ_CONTEXT_FIXTURE_MODE: "",
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("must not be set in CI");
  });

  it("is wired into scripts/pre-pr.sh", () => {
    // The gate's only execution path (CI runs PRE_PR_STATIC_ONLY=1 pre-pr.sh).
    // Deleting that line disarms it in both places, and
    // check-gate-selftest-coverage only proves a self-test EXISTS.
    const prePr = readFileSync(join(REPO_ROOT, "scripts/pre-pr.sh"), "utf8");
    expect(prePr).toContain("scripts/checks/check-rls-read-context.mjs");
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
