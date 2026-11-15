/**
 * Regression: the audit-chain verify worker read `audit_logs` and
 * `audit_chain_anchors` through a bare client as the verifier role, which is
 * NOBYPASSRLS, with no `app.tenant_id` ever set. Both tables are FORCE ROW
 * LEVEL SECURITY with
 *   `bypass_rls='on' OR tenant_id = current_setting('app.tenant_id',true)::uuid`
 * so the predicate evaluated to NULL and every read returned ZERO ROWS WITH NO
 * ERROR. Every tenant then walked an empty chain, found nothing wrong, and was
 * reported healthy — while the heartbeat fired normally.
 *
 * This is the silent half of the RLS-read class. The `audit_outbox` case
 * raised 22P02 once a GUC had been touched on the connection and so was
 * eventually noticed; this one cannot raise anything, which is why the fix
 * carries a precondition assertion rather than relying on an error surfacing,
 * and reports what a tick covered as counts on the heartbeat line.
 *
 * The role matters: these cases run as `passwd_audit_chain_verifier` (#947), the
 * worker's own NOBYPASSRLS role, which holds column-level SELECT on the eleven
 * columns its statements name and nothing else. A superuser client bypasses RLS
 * outright and passes against the unfixed code, and passwd_app would hide a
 * column or table the worker no longer has. The denial cells below pair each
 * refusal with an allow case on the same connection.
 *
 * The `__system__` sentinel cannot be opened as a tenant context, so its chain
 * is read under the AUDIT_CHAIN_VERIFY_SENTINEL_READ bypass instead. That path
 * is exercised on throwaway tenant A while tenant B also has a chain: the grant
 * admits every tenant's rows, so B is what a lost `WHERE tenant_id` would pull
 * into A's walk. No case here writes rows for the real sentinel or touches its
 * audit_chain_enabled — on a shared DB the outbox worker and the anchor
 * publisher would act on that irreversibly.
 */

import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import {
  assertRlsApplies,
  auditChainVerifierConnectionString,
  createPrismaForRole,
  createTestContext,
  setBypassRlsGucs,
  type PrismaWithPool,
  type TestContext,
} from "./helpers";
import { pgErrorCode } from "@/lib/prisma/prisma-error";
import { createClient } from "@/lib/db/pool-factory";
import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
} from "@/lib/audit/audit-chain";
import {
  MAX_ROWS_PER_TENANT,
  runTick,
  verifyChainUnderSentinelGrant,
  verifyTenantChain,
} from "@/../scripts/audit-chain-verify-worker";

const CHAIN_LENGTH = 3;

const VERIFIER_ROLE = "passwd_audit_chain_verifier";

/**
 * Checked first and failed loudly: the migration creates the role NOLOGIN, and
 * a cell that skipped on that would stay green on a database where the
 * verifier cannot connect at all (CI sets the password in its role step).
 */
async function requireVerifierLogin(ctx: TestContext): Promise<void> {
  const [state] = await ctx.su.prisma.$queryRawUnsafe<Array<{ rolcanlogin: boolean }>>(
    `SELECT rolcanlogin FROM pg_roles WHERE rolname = '${VERIFIER_ROLE}'`,
  );
  if (!state?.rolcanlogin) {
    throw new Error(
      `${VERIFIER_ROLE} ${state ? "is NOLOGIN" : "does not exist"}: apply the migrations and give it a login, ` +
        `once per cluster: ALTER ROLE ${VERIFIER_ROLE} WITH LOGIN PASSWORD 'passwd_audit_chain_verifier_pass'`,
    );
  }
}

describe("audit-chain verify worker RLS context", () => {
  let ctx: TestContext;
  let verifier: PrismaWithPool;
  let tenantId: string;
  let otherTenantId: string;
  const logger = { error: () => {}, info: () => {} };

  beforeAll(async () => {
    ctx = await createTestContext();
    await requireVerifierLogin(ctx);
    verifier = createPrismaForRole("audit-chain-verifier");
    await assertRlsApplies(verifier.prisma);
  });
  afterAll(async () => {
    await verifier?.prisma.$disconnect().then(() => verifier.pool.end());
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    otherTenantId = await ctx.createTenant();
    await insertChainedRows(tenantId, CHAIN_LENGTH);
    await insertChainedRows(otherTenantId, CHAIN_LENGTH);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.deleteTestData(otherTenantId);
  });

  /** Seed a valid chain of `count` rows for `tenantId` plus a matching anchor. */
  async function insertChainedRows(tenantId: string, count: number): Promise<string[]> {
    const userId = await ctx.createUser(tenantId);
    const ids: string[] = [];
    let prevHash: Buffer = Buffer.from([0x00]);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now())
         ON CONFLICT (tenant_id) DO NOTHING`,
        tenantId,
      );

      for (let i = 1; i <= count; i++) {
        const id = randomUUID();
        const outboxId = randomUUID();
        const createdAt = new Date(Date.now() + i * 1000);
        const seq = BigInt(i);
        const metadata = { index: i, verify: true };

        const chainInput = buildChainInput({
          id,
          createdAt,
          chainSeq: seq,
          prevHash,
          payload: metadata,
        });
        const eventHash = computeEventHash(
          prevHash,
          computeCanonicalBytes(chainInput),
        );

        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
           VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
          outboxId,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (
            id, tenant_id, scope, action, user_id, actor_type,
            metadata, created_at, outbox_id,
            chain_seq, event_hash, chain_prev_hash
          ) VALUES (
            $1::uuid, $2::uuid, 'PERSONAL'::"AuditScope", 'ENTRY_CREATE'::"AuditAction",
            $3::uuid, 'HUMAN'::"ActorType",
            $4::jsonb, $5::timestamptz, $6::uuid,
            $7, $8, $9
          )`,
          id,
          tenantId,
          userId,
          JSON.stringify(metadata),
          createdAt.toISOString(),
          outboxId,
          seq,
          eventHash,
          prevHash,
        );

        ids.push(id);
        prevHash = eventHash;
      }

      await tx.$executeRawUnsafe(
        `UPDATE audit_chain_anchors
         SET chain_seq = $1, prev_hash = $2, updated_at = now()
         WHERE tenant_id = $3::uuid`,
        BigInt(count),
        prevHash,
        tenantId,
      );
    });

    return ids;
  }

  it("bare reads as the verifier role see zero rows and raise nothing — the silent failure", async () => {
    // The control clause, and the reason this defect survived: "the boundary
    // is working" and "there is nothing here" are indistinguishable to the
    // caller. If this ever starts throwing, the two cases below stop proving
    // what they claim and must be revisited.
    const [anchors, rows] = await Promise.all([
      verifier.prisma.$queryRawUnsafe<unknown[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1`,
        tenantId,
      ),
      verifier.prisma.$queryRawUnsafe<unknown[]>(
        `SELECT id FROM audit_logs WHERE tenant_id = $1 AND chain_seq IS NOT NULL`,
        tenantId,
      ),
    ]);
    expect(anchors).toHaveLength(0);
    expect(rows).toHaveLength(0);

    // Ground truth for BOTH clauses. Without the anchor half, a fixture whose
    // `ON CONFLICT DO NOTHING` anchor insert never landed would satisfy
    // `anchors).toHaveLength(0)` for the wrong reason.
    const [truth] = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ rows: bigint; anchors: bigint }>>(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs
             WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL) AS rows,
           (SELECT COUNT(*) FROM audit_chain_anchors
             WHERE tenant_id = $1::uuid) AS anchors`,
        tenantId,
      );
    });
    expect(Number(truth.rows)).toBe(CHAIN_LENGTH);
    expect(Number(truth.anchors)).toBe(1);
  });

  it("verifies a healthy chain as the verifier role, with the anchor actually compared", async () => {
    // Allow side. anchorChecked is the discriminator that matters: before the
    // fix this returned ok:true with anchorChecked:false and totalVerified:0,
    // i.e. "clean" for a chain it could not see. A fix asserting only `ok`
    // would still pass against the broken code.
    const result = await verifyTenantChain(tenantId, {
      prisma: verifier.prisma,
      logger,
    });

    expect(result.ok).toBe(true);
    expect(result.anchorChecked).toBe(true);
    expect(result.totalVerified).toBe(CHAIN_LENGTH);
  });

  it("detects a tampered row as the verifier role", async () => {
    // Deny side. This is the whole purpose of the worker, and it was
    // unreachable: with zero rows visible there was nothing to find.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_logs SET metadata = '{"tampered":true}'::jsonb
         WHERE tenant_id = $1::uuid AND chain_seq = 2`,
        tenantId,
      );
    });

    const result = await verifyTenantChain(tenantId, {
      prisma: verifier.prisma,
      logger,
    });

    expect(result.ok).toBe(false);
    expect(result.firstTamperedSeq).toBe(2);
    // walkedThrough is what separates "detected tampering" from "saw nothing":
    // before the fix the walk covered 0 rows. anchorChecked is deliberately not
    // asserted here — the walk bails at the first tampered row, so the anchor
    // head-hash comparison never runs.
    expect(result.walkedThrough).toBeGreaterThan(0);
  });

  it("verifies tenant A's chain under the sentinel-read grant as the verifier role, with B's chain present", async () => {
    // Visibility on the bypass path: the grant is what makes A's rows visible
    // to the verifier role, and a clean walk of exactly CHAIN_LENGTH rows shows B's
    // rows, which the grant admits just as well, stayed out of it (joined in,
    // they would interleave by chain_seq and break the walk at seq 1).
    const result = await verifyChainUnderSentinelGrant(tenantId, {
      prisma: verifier.prisma,
      logger,
    });

    expect(result.ok).toBe(true);
    expect(result.anchorChecked).toBe(true);
    expect(result.totalVerified).toBe(CHAIN_LENGTH);
  });

  it("detects a tampered row of tenant A under the sentinel-read grant", async () => {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_logs SET metadata = '{"tampered":true}'::jsonb
         WHERE tenant_id = $1::uuid AND chain_seq = 2`,
        tenantId,
      );
    });

    const result = await verifyChainUnderSentinelGrant(tenantId, {
      prisma: verifier.prisma,
      logger,
    });

    expect(result.ok).toBe(false);
    expect(result.firstTamperedSeq).toBe(2);
    expect(result.walkedThrough).toBeGreaterThan(0);
  });

  it("verifies the sentinel as the verifier role without throwing, matching what a superuser reads of it", async () => {
    // On a clean DB the sentinel has no chain, so this proves the routing
    // (withTenantRls would throw RlsSentinelContextRefused) and that the
    // bypass precondition holds on a real database — not visibility, which
    // the tenant-A cases above prove. Read-only: nothing is written for the
    // sentinel.
    const result = await verifyTenantChain(SYSTEM_TENANT_ID, {
      prisma: verifier.prisma,
      logger,
    });

    const [truth] = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        Array<{ anchor_seq: bigint | null; chained: bigint; walkable: bigint }>
      >(
        `SELECT
           (SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid) AS anchor_seq,
           (SELECT COUNT(*) FROM audit_logs
             WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL) AS chained,
           (SELECT COUNT(*) FROM audit_logs
             WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL
               AND chain_seq <= (SELECT chain_seq FROM audit_chain_anchors
                                  WHERE tenant_id = $1::uuid)) AS walkable`,
        SYSTEM_TENANT_ID,
      );
    });

    if (truth.anchor_seq === null) {
      expect(result.totalVerified).toBe(0);
      expect(result.ok).toBe(Number(truth.chained) === 0);
    } else {
      // Assumes the sentinel's chain is intact: a broken one (e.g. rows purged
      // by its retention) stops the walk early and fails this, as it should.
      // The head hash is compared only when the walk reached the anchor, so a
      // walk the row cap cut short has anchorChecked false.
      expect(result.anchorChecked).toBe(
        Number(truth.anchor_seq) >= 1 &&
          Number(truth.walkable) <= MAX_ROWS_PER_TENANT,
      );
      expect(result.totalVerified).toBe(
        Math.min(Number(truth.walkable), MAX_ROWS_PER_TENANT),
      );
      if (Number(truth.walkable) <= MAX_ROWS_PER_TENANT) {
        expect(result.ok).toBe(true);
        expect(result.reason).toBeUndefined();
      } else {
        expect(result.reason).toBe("TRUNCATED");
      }
    }
  });

  it("C3: runTick enumerates tenants under bypass as the verifier role, matching the superuser count of all tenants (sentinel included) with no coverage shortfall", async () => {
    // `tenants` now carries RLS too (C1): a bare `prisma.tenant.findMany` as
    // passwd_app would see zero rows and every tenant would walk an empty
    // chain — the same silent failure this file's other cells exist to catch,
    // one layer up. runTick must instead enumerate under the named
    // SYSTEM_MAINTENANCE_TENANT_LOOKUP bypass grant.
    const logLines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logLines.push(String(line));
    });
    try {
      await runTick(verifier.prisma, new Map());
    } finally {
      logSpy.mockRestore();
    }

    const heartbeatLine = logLines.find((line) =>
      line.includes("audit-chain-verify-heartbeat"),
    );
    expect(heartbeatLine).toBeDefined();
    const heartbeat = JSON.parse(heartbeatLine!);

    const [{ count: superuserTenantCount }] = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        // Every tenant is verified, the sentinel included (under its own
        // bypass grant), so tenantCount is the count of all tenants.
        `SELECT COUNT(*) AS count FROM tenants`,
      );
    });
    expect(heartbeat.tenantCount).toBe(Number(superuserTenantCount));
    expect(heartbeat.verifiedTenantCount + heartbeat.erroredTenantCount).toBe(heartbeat.tenantCount);
    expect(heartbeat.erroredTenantCount).toBe(0);
  });

  /**
   * Statements the worker never issues, each on the verifier's own connection
   * and each refused with 42501 (insufficient privilege) before any row is
   * touched. Every one is paired with a granted read of the same table on the
   * same connection, so a role that simply could not connect, or a table the
   * pool could not reach, cannot satisfy the denial.
   */
  describe("denials, each paired with its allow case", () => {
    // A connection of its own, never used by the worker functions: a pooled one
    // that ran withTenantRls has its app.tenant_id reverted to '', and a bare
    // read there raises 22P02 instead of returning no rows.
    let client: pg.Client;
    beforeAll(async () => {
      client = createClient({ connectionString: auditChainVerifierConnectionString() });
      await client.connect();
    });
    afterAll(async () => {
      await client.end();
    });

    async function refusal(sql: string): Promise<{ code: string | null; message: string } | null> {
      try {
        await client.query(sql);
      } catch (err) {
        return { code: pgErrorCode(err), message: err instanceof Error ? err.message : String(err) };
      }
      return null;
    }

    const ALLOWED_READS = {
      tenants: "SELECT id FROM tenants LIMIT 1",
      audit_chain_anchors: "SELECT tenant_id, chain_seq, prev_hash FROM audit_chain_anchors LIMIT 1",
      audit_logs:
        "SELECT id, tenant_id, created_at, chain_seq, event_hash, chain_prev_hash, metadata FROM audit_logs LIMIT 1",
    } as const;

    it.each(Object.entries(ALLOWED_READS))("reads the granted columns of %s", async (_table, sql) => {
      await expect(client.query(sql)).resolves.toBeDefined();
    });

    it.each([
      ["a column of tenants outside the grant", "SELECT name FROM tenants LIMIT 1", ALLOWED_READS.tenants],
      ["SELECT * on tenants", "SELECT * FROM tenants LIMIT 1", ALLOWED_READS.tenants],
      ["a column of audit_logs outside the grant", "SELECT action FROM audit_logs LIMIT 1", ALLOWED_READS.audit_logs],
      ["SELECT * on audit_logs", "SELECT * FROM audit_logs LIMIT 1", ALLOWED_READS.audit_logs],
      [
        "a column of audit_chain_anchors outside the grant",
        "SELECT updated_at FROM audit_chain_anchors LIMIT 1",
        ALLOWED_READS.audit_chain_anchors,
      ],
      ["a table outside the grant", "SELECT id FROM users LIMIT 1", ALLOWED_READS.tenants],
      ["a table with no grant at all", "SELECT 1 FROM audit_outbox LIMIT 1", ALLOWED_READS.audit_logs],
    ])("refuses %s with 42501 while the granted read succeeds", async (_name, denied, allowed) => {
      await expect(client.query(allowed)).resolves.toBeDefined();
      const refused = await refusal(denied);
      expect(refused?.code).toBe("42501");
      expect(refused?.message).toMatch(/permission denied for (table|column)/);
      await expect(client.query(allowed)).resolves.toBeDefined();
    });

    // WHERE false: privileges are checked at parse time, before any row is
    // examined, so a role that held the privilege would also write nothing
    // here — the paired read shows the table is otherwise reachable, and the
    // "permission denied" message shows which check refused: an INSERT that
    // held the privilege would still fail 42501 on the RLS policy check
    // ("new row violates row-level security policy").
    it.each([
      ["INSERT", "INSERT INTO tenants (id) VALUES (gen_random_uuid())", "tenants"],
      ["UPDATE", "UPDATE tenants SET id = id WHERE false", "tenants"],
      ["DELETE", "DELETE FROM tenants WHERE false", "tenants"],
      ["INSERT", "INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash) VALUES (gen_random_uuid(), 0, '\\x00')", "audit_chain_anchors"],
      ["UPDATE", "UPDATE audit_chain_anchors SET chain_seq = chain_seq WHERE false", "audit_chain_anchors"],
      ["DELETE", "DELETE FROM audit_chain_anchors WHERE false", "audit_chain_anchors"],
      ["INSERT", "INSERT INTO audit_logs (id, tenant_id) VALUES (gen_random_uuid(), gen_random_uuid())", "audit_logs"],
      ["UPDATE", "UPDATE audit_logs SET metadata = metadata WHERE false", "audit_logs"],
      ["DELETE", "DELETE FROM audit_logs WHERE false", "audit_logs"],
    ] as const)("refuses %s on %s with 42501 while the granted read succeeds", async (_verb, denied, table) => {
      await expect(client.query(ALLOWED_READS[table])).resolves.toBeDefined();
      const refused = await refusal(denied);
      expect(refused?.code).toBe("42501");
      expect(refused?.message).toMatch(/permission denied for (table|column)/);
      await expect(client.query(ALLOWED_READS[table])).resolves.toBeDefined();
    });
  });
});

/**
 * The worker process itself, connecting as the verifier role with nothing else
 * in its environment: no DATABASE_URL, so a production fallback to passwd_app
 * (or to the superuser URL of this suite) would not be silent here. Ready is
 * the first heartbeat that verified at least one tenant, with no enumeration
 * failure and no permission error. Other tenants' chains in a shared database
 * are not asserted.
 */
describe("audit-chain verify worker boots as the verifier role", () => {
  const REPO_ROOT = process.cwd();
  const BOOT_APPLICATION_NAME = "passwd-sso-test-chain-verify-boot";
  let ctx: TestContext;
  let cwd: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    await requireVerifierLogin(ctx);
    // An empty cwd, so the worker's dotenv load finds no .env to fill in a
    // variable this cell means to leave unset.
    cwd = mkdtempSync(join(tmpdir(), "chain-verify-boot-"));
  });
  afterAll(async () => {
    rmSync(cwd, { recursive: true, force: true });
    await ctx.cleanup();
  });

  it("emits a heartbeat verifying a tenant as the verifier role, then shuts down clean on SIGTERM", async () => {
    const url = new URL(auditChainVerifierConnectionString());
    expect(url.username).toBe(VERIFIER_ROLE);
    url.searchParams.set("application_name", BOOT_APPLICATION_NAME);

    const child = spawn(
      join(REPO_ROOT, "node_modules/.bin/tsx"),
      ["--tsconfig", join(REPO_ROOT, "tsconfig.json"), join(REPO_ROOT, "scripts/audit-chain-verify-worker.ts")],
      {
        // Only what the cell names: no DATABASE_URL to fall back on, and no
        // inherited NODE_ENV or worker setting (the type marks NODE_ENV required).
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          AUDIT_CHAIN_VERIFY_DATABASE_URL: url.toString(),
          AUDIT_CHAIN_VERIFY_TICK_INTERVAL_MS: "1000",
        },
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    // "close", not "exit": "exit" can fire before stdout is drained, and the
    // shutdown line asserted below is the last thing the worker writes.
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
      child.on("close", (code, signal) => res({ code, signal })),
    );

    try {
      const heartbeat = await new Promise<{ verifiedTenantCount: number; tenantCount: number }>((res, rej) => {
        const deadline = setTimeout(
          () => rej(new Error(`no heartbeat within 45s\nstdout: ${stdout}\nstderr: ${stderr}`)),
          45_000,
        );
        const onData = () => {
          for (const line of stdout.split("\n")) {
            if (!line.includes('"_logType":"audit-chain-verify-heartbeat"')) continue;
            clearTimeout(deadline);
            child.stdout.off("data", onData);
            res(JSON.parse(line));
            return;
          }
        };
        child.stdout.on("data", onData);
        child.once("exit", () => rej(new Error(`worker exited before a heartbeat\nstdout: ${stdout}\nstderr: ${stderr}`)));
      });

      expect(heartbeat.verifiedTenantCount, stderr).toBeGreaterThanOrEqual(1);
      expect(stdout + stderr).not.toMatch(/TENANT_ENUMERATION_/);
      expect(stderr).not.toMatch(/permission denied|42501/i);

      // The worker's connection is the verifier's, named by its application_name.
      const sessions = await ctx.su.prisma.$queryRawUnsafe<Array<{ usename: string }>>(
        `SELECT usename FROM pg_stat_activity WHERE application_name = '${BOOT_APPLICATION_NAME}'`,
      );
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((r) => r.usename === VERIFIER_ROLE)).toBe(true);

      child.kill("SIGTERM");
      const outcome = await Promise.race([
        exited,
        new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 10_000)),
      ]);
      expect(outcome, stderr).toEqual({ code: 0, signal: null });
      expect(stdout).toContain("audit-chain-verify-worker: shutdown clean");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 75_000);
});

/**
 * The migration's convergence block, between its CONVERGE markers: what the
 * role holds is exactly the eleven columns of the grant and what PUBLIC holds,
 * and replaying the block returns an over-granted role to that state.
 */
describe("role passwd_audit_chain_verifier: effective privileges", () => {
  const MIGRATION = "20261114000400_audit_chain_verifier_role";
  const PRIVILEGE_COLUMNS = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
  const PRIVILEGE_TABLES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
  // D2 of the plan, as keys of the shape snapshot() returns.
  const GRANTED = [
    "COLUMN public.tenants.id SELECT",
    "COLUMN public.audit_chain_anchors.tenant_id SELECT",
    "COLUMN public.audit_chain_anchors.chain_seq SELECT",
    "COLUMN public.audit_chain_anchors.prev_hash SELECT",
    "COLUMN public.audit_logs.id SELECT",
    "COLUMN public.audit_logs.tenant_id SELECT",
    "COLUMN public.audit_logs.created_at SELECT",
    "COLUMN public.audit_logs.chain_seq SELECT",
    "COLUMN public.audit_logs.event_hash SELECT",
    "COLUMN public.audit_logs.chain_prev_hash SELECT",
    "COLUMN public.audit_logs.metadata SELECT",
    "SCHEMA public USAGE",
    "FUNCTION public.rls_bypass_enforced() EXECUTE",
    "FUNCTION public.rls_bypass_admits(text) EXECUTE",
    "DATABASE CONNECT",
  ];

  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
    await requireVerifierLogin(ctx);
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  function convergenceBlock(): string {
    const text = readFileSync(join(process.cwd(), "prisma/migrations", MIGRATION, "migration.sql"), "utf8");
    const name = "audit-chain-verifier-role";
    const found = [...text.matchAll(new RegExp(`-- BEGIN CONVERGE ${name}\\n([\\s\\S]*?)-- END CONVERGE ${name}\\n`, "g"))];
    if (found.length !== 1) throw new Error(`expected exactly one CONVERGE block "${name}", found ${found.length}`);
    return found[0][1];
  }

  /**
   * Every privilege `role` holds, through the has_*_privilege functions, over
   * each column, table, sequence and routine of `public`, the schema and the
   * database. Run on a client inside the caller's transaction.
   */
  async function snapshot(client: pg.PoolClient, role: string): Promise<string[]> {
    const q = async (sql: string) => (await client.query<{ k: string }>(sql, [role])).rows.map((r) => r.k);
    const keys = [
      ...(await q(`
        SELECT format('COLUMN public.%s.%s %s', c.relname, a.attname, p) AS k
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          CROSS JOIN unnest(ARRAY[${PRIVILEGE_COLUMNS.map((p) => `'${p}'`).join(",")}]) AS p
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND has_column_privilege($1, c.oid, a.attnum, p)`)),
      ...(await q(`
        SELECT format('TABLE public.%s %s', c.relname, p) AS k
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          CROSS JOIN unnest(ARRAY[${PRIVILEGE_TABLES.map((p) => `'${p}'`).join(",")}]) AS p
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND has_table_privilege($1, c.oid, p)`)),
      ...(await q(`
        SELECT format('SEQUENCE public.%s %s', c.relname, p) AS k
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p
         WHERE c.relkind = 'S' AND has_sequence_privilege($1, c.oid, p)`)),
      ...(await q(`
        SELECT format('FUNCTION public.%s(%s) EXECUTE', p.proname, oidvectortypes(p.proargtypes)) AS k
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
         WHERE has_function_privilege($1, p.oid, 'EXECUTE')`)),
      ...(await q(`
        SELECT format('SCHEMA public %s', p) AS k
          FROM unnest(ARRAY['USAGE', 'CREATE']) AS p
         WHERE has_schema_privilege($1, 'public', p)`)),
      ...(await q(`
        SELECT format('DATABASE %s', p) AS k
          FROM unnest(ARRAY['CONNECT', 'CREATE', 'TEMPORARY']) AS p
         WHERE has_database_privilege($1, current_database(), p)`)),
    ];
    return keys.sort();
  }

  /** What a role with no grant of its own holds: PUBLIC's share, computed by asking the server about a fresh role. */
  async function publicHeld(client: pg.PoolClient): Promise<string[]> {
    const probe = `probe_public_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await client.query(`CREATE ROLE ${probe} NOLOGIN`);
    return snapshot(client, probe);
  }

  it("holds exactly the eleven granted columns, the two function EXECUTEs and what PUBLIC holds", async () => {
    const client = await ctx.su.pool.connect();
    try {
      await client.query("BEGIN");
      const expected = [...new Set([...GRANTED, ...(await publicHeld(client))])].sort();
      const actual = await snapshot(client, VERIFIER_ROLE);
      expect(actual.filter((k) => !expected.includes(k)), "held beyond the grant and PUBLIC").toEqual([]);
      expect(expected.filter((k) => !actual.includes(k)), "granted but not held").toEqual([]);
      // Anti-vacuity: the enumeration saw the granted columns at all.
      expect(actual).toContain("COLUMN public.audit_logs.metadata SELECT");
      expect(actual.filter((k) => k.startsWith("COLUMN "))).toHaveLength(11);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("replaying the convergence block returns an over-granted role to the same state", async () => {
    const client = await ctx.su.pool.connect();
    try {
      await client.query("BEGIN");
      const before = await snapshot(client, VERIFIER_ROLE);
      const [{ rolconnlimit: limitBefore }] = (
        await client.query<{ rolconnlimit: number }>(`SELECT rolconnlimit FROM pg_roles WHERE rolname = $1`, [VERIFIER_ROLE])
      ).rows;

      await client.query(`GRANT INSERT, UPDATE, DELETE ON audit_logs TO ${VERIFIER_ROLE}`);
      await client.query(`GRANT SELECT ON tenants TO ${VERIFIER_ROLE}`);
      await client.query(`GRANT SELECT (name) ON tenants TO ${VERIFIER_ROLE}`);
      await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${VERIFIER_ROLE}`);
      await client.query(`GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO ${VERIFIER_ROLE}`);
      await client.query(`GRANT CREATE ON SCHEMA public TO ${VERIFIER_ROLE}`);
      await client.query(`ALTER ROLE ${VERIFIER_ROLE} CONNECTION LIMIT 99`);

      const overGranted = await snapshot(client, VERIFIER_ROLE);
      // The over-grant took effect, or the replay below proves nothing.
      expect(overGranted).not.toEqual(before);
      expect(overGranted).toContain("TABLE public.audit_logs INSERT");

      await client.query(convergenceBlock());

      expect(await snapshot(client, VERIFIER_ROLE)).toEqual(before);
      const { rows } = await client.query<{ rolconnlimit: number }>(
        `SELECT rolconnlimit FROM pg_roles WHERE rolname = $1`,
        [VERIFIER_ROLE],
      );
      expect(rows[0].rolconnlimit).toBe(limitBefore);
      expect(limitBefore).toBe(10);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
