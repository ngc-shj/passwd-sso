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
      // Required under CI=true: the gate refuses scan-scope overrides there
      // unless fixture mode is declared. Porting the guard from
      // check-gate-selftest-coverage.sh means porting its test side too.
      RLS_READ_CONTEXT_FIXTURE_MODE: "1",
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

  // The four ways a statement used to reach an RLS table without the gate
  // seeing it, each measured against this harness before the widening. The
  // allow-side twin of each is below: the point of following a chain further is
  // that correct code keeps passing, and a deny-only widening would just move
  // the false positive.
  describe("indirect access spellings", () => {
    it.each([
      [
        "an alias chain longer than one hop",
        `const a = prisma; const b = a; const c = b;
         return c.auditOutbox.findMany({});`,
      ],
      [
        "element access on the model",
        `return prisma["auditOutbox"].findMany({});`,
      ],
      [
        "element access on the method",
        `return prisma.auditOutbox["findMany"]({});`,
      ],
      [
        "a destructured model accessor",
        `const { auditOutbox } = prisma; return auditOutbox.findMany({});`,
      ],
      [
        "a destructured method",
        `const { findMany } = prisma.auditOutbox; return findMany({});`,
      ],
      [
        "a destructured method under a different local name",
        `const { findMany: fm } = prisma.auditOutbox; return fm({});`,
      ],
      [
        "a destructured raw method",
        "const { $queryRaw } = prisma; return $queryRaw`SELECT count(*) FROM audit_outbox`;",
      ],
      [
        "an accessor alias reached through a second hop",
        `const m = prisma.auditOutbox; const n = m; return n.findMany({});`,
      ],
    ])("FAILS %s", (_label, body) => {
      const r = runGate(`
        export async function f(prisma: any) { ${body} }
      `);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("audit_outbox");
    });

    it.each([
      [
        "an alias chain longer than one hop",
        `const a = tx; const b = a; const c = b;
         return c.auditOutbox.findMany({});`,
      ],
      [
        "a destructured model accessor",
        `const { auditOutbox } = tx; return auditOutbox.findMany({});`,
      ],
      [
        "a destructured method under a different local name",
        `const { findMany: fm } = tx.auditOutbox; return fm({});`,
      ],
    ])("PASSES %s inside a context callback", (_label, body) => {
      const r = runGate(`
        import { withBypassRls } from "@/lib/tenant-rls";
        export async function f(prisma: any) {
          return withBypassRls(prisma, async (tx: any) => { ${body} }, "audit_write");
        }
      `);
      expect(r.status).toBe(0);
    });

    // Round 1 F-C1. A file-wide "first declaration wins" index adjudicated the
    // SECOND statement using the FIRST's initializer, so a bare-client read in
    // one function was cleared by a same-named `const db = tx` in another. That
    // second function is the shape the docblock says shipped to production.
    describe("shadowed bindings resolve from the statement, not the file", () => {
      const bare = `const db = prisma;
                    return db.$queryRaw\`SELECT count(*) FROM audit_outbox\`;`;
      const ctx = `const db = tx;
                   return db.$queryRaw\`SELECT count(*) FROM audit_outbox\`;`;

      // `tx: TransactionClient`, never `tx: any`. The typed parameter is what
      // makes the sibling's binding context-bearing — with `any` these cases
      // report no matter how the resolver behaves, and a mutation back to
      // file-wide resolution leaves them green. (Measured: it did.)
      const TYPED = "tx: Prisma.TransactionClient";

      it.each([
        ["the context binding is declared FIRST", ctx, bare],
        ["the bare binding is declared FIRST", bare, ctx],
      ])("FAILS the bare-client read when %s", (_label, first, second) => {
        const r = runGate(`
          import type { Prisma } from "@prisma/client";
          declare const prisma: any;
          export async function a(${TYPED}) { ${first} }
          export async function b(${TYPED}) { ${second} }
        `);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("audit_outbox");
      });

      it("FAILS a shadowed model-accessor read behind a 2-hop sibling chain", () => {
        const r = runGate(`
          import type { Prisma } from "@prisma/client";
          declare const prisma: any;
          export async function drain(${TYPED}) {
            const conn = tx; const db = conn;
            return db.$queryRaw\`SELECT count(*) FROM audit_outbox\`;
          }
          export async function depthAlert(${TYPED}) {
            const db = prisma;
            return db.auditOutbox.count({});
          }
        `);
        expect(r.status).not.toBe(0);
      });

      it("FAILS when two sibling scopes bind the name and neither encloses the read", () => {
        // Unresolvable must fail CLOSED: an alias the gate cannot follow is not
        // an alias it may assume safe.
        const r = runGate(`
          import type { Prisma } from "@prisma/client";
          declare const prisma: any;
          declare const db: any;
          export function outer() { const db = prisma; void db; }
          export async function g(${TYPED}) { return db.auditOutbox.findMany({}); }
        `);
        expect(r.status).not.toBe(0);
      });

      it("PASSES an inner-block binding that shadows an outer bare-client one", () => {
        // The allow side of the same mechanism. Innermost binder wins, so the
        // outer `const db = prisma` must not drag the inner read down with it.
        const r = runGate(`
          import { withBypassRls } from "@/lib/tenant-rls";
          declare const prisma: any;
          export async function f() {
            const db = prisma;
            void db;
            return withBypassRls(prisma, async (tx: any) => {
              { const db = tx; return db.auditOutbox.findMany({}); }
            }, "audit_write");
          }
        `);
        expect(r.status).toBe(0);
      });
    });

    it("REPORTS rather than crashes on a cyclic alias chain", () => {
      // `seen`, not a hop counter, is what bounds the context walk: a cycle has
      // no length, and `seen.add` of a name already present does not grow it.
      // Asserted on the REPORT, not on a non-zero exit — dropping the guard
      // overflows the stack, which also exits non-zero and would leave this
      // green while the gate had stopped being able to answer.
      const r = runGate(`
        export async function f() {
          const a = b; const b = a;
          return a.auditOutbox.findMany({});
        }
      `);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("audit_outbox");
      expect(r.stderr).not.toContain("call stack");
    });
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
    // Anchored at line start: `toContain` stays green against
    // `# DISABLED: queue_step ...`, which is disarming, not deletion.
    const prePr = readFileSync(join(REPO_ROOT, "scripts/pre-pr.sh"), "utf8");
    expect(prePr).toMatch(/^queue_step .*check-rls-read-context\.mjs/m);
  });

  describe("$transaction GUC establishment", () => {
    const read = "return tx.auditOutbox.findMany({});";
    const decl = "declare function setBypassRlsGucs(x: any): Promise<void>;";

    // Every one of these re-admits the checkDepthAlert defect. They are the
    // shapes a text predicate over the callback source accepts, which is why
    // the check is an AST walk rather than a regex.
    it.each([
      ["a comment naming the helper", `/* setBypassRlsGucs(tx) in caller */ ${read}`],
      ["a comment naming set_config", `/* set_config("app.tenant_id", t, true) */ ${read}`],
      ["a string literal naming the helper", `const m = "wrap in setBypassRlsGucs(tx)"; void m; ${read}`],
      ["the setter on a DIFFERENT binding", `await setBypassRlsGucs(other); ${read}`],
      ["set_config to the EMPTY string", `await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', '', true)"); ${read}`],
    ])("FAILS a bare $transaction with only %s", (_label, body) => {
      const r = runGate(`
        export async function f(prisma: any, other: any) {
          return prisma.$transaction(async (tx: any) => { ${body} });
        }
        ${decl}
      `);
      expect(r.status).not.toBe(0);
    });

    it("FAILS when the setter runs AFTER the read", () => {
      const r = runGate(`
        export async function f(prisma: any) {
          return prisma.$transaction(async (tx: any) => {
            const rows = await tx.auditOutbox.findMany({});
            await setBypassRlsGucs(tx);
            return rows;
          });
        }
        ${decl}
      `);
      expect(r.status).not.toBe(0);
    });

    it("PASSES a real setBypassRlsGucs on the binding, before the read", () => {
      const r = runGate(`
        export async function f(prisma: any) {
          return prisma.$transaction(async (tx: any) => {
            await setBypassRlsGucs(tx);
            ${read}
          });
        }
        ${decl}
      `);
      expect(r.status).toBe(0);
    });

    it("PASSES raw set_config on the binding, before the read", () => {
      const r = runGate(`
        export async function f(prisma: any, t: string) {
          return prisma.$transaction(async (tx: any) => {
            await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", t);
            ${read}
          });
        }
      `);
      expect(r.status).toBe(0);
    });

    it("REPORTS rather than accepts when the binding is passed to an unknown helper", () => {
      // A project-local establishTenantContext(tx, ...) may or may not set the
      // GUC. Undecidable must fail loudly, not resolve to "fine".
      const r = runGate(`
        export async function f(prisma: any, t: string) {
          return prisma.$transaction(async (tx: any) => {
            await establishTenantContext(tx, t);
            ${read}
          });
        }
        declare function establishTenantContext(tx: any, t: string): Promise<void>;
      `);
      expect(r.status).not.toBe(0);
    });
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
          RLS_READ_CONTEXT_FIXTURE_MODE: "1",
        },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("cannot read");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
