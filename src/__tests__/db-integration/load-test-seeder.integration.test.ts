/**
 * Integration test (real DB): the k6 load-test seeder (load-test/setup/
 * seed-load-test-users.mjs, #960) writes users the app can authenticate, and
 * its cleanup removes them and their tenant. The seeder runs only by hand, so
 * this is what makes a schema change that breaks it fail in CI. It runs the
 * seeder as the CLI people run, in a child process.
 *
 * Run: docker compose up -d db && npm run test:integration -- load-test-seeder
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createPrismaForRole } from "./helpers";
import { hashSessionToken } from "@/lib/auth/session/session-cache";

const SEEDER = join(process.cwd(), "load-test/setup/seed-load-test-users.mjs");
const AUTH_FILE = join(process.cwd(), "load-test/setup/.load-test-auth.json");
const TENANT_ID = "00000000-0000-4000-a000-0000000010ad";
// execFileSync blocks the event loop, so vitest's test timeout cannot stop a
// hung child; the child's own timeout (SIGTERM) does.
const CHILD_TIMEOUT_MS = 60_000;

interface Credential {
  userId: string;
  sessionToken: string;
}

describe("load-test seeder — real-DB integration", () => {
  // The seeder writes through a role that bypasses RLS, as its README requires.
  const su = createPrismaForRole("superuser");

  function seederEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      DATABASE_URL: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
      ALLOW_LOAD_TEST_SEED: "true",
      ALLOW_NON_TEST_DBNAME: "true",
      // Nothing listens here: the post-seed request is skipped, not failed.
      BASE_URL: "http://127.0.0.1:9",
      ...extra,
    };
  }

  function seeder(...args: string[]): void {
    execFileSync(process.execPath, [SEEDER, ...args], { env: seederEnv(), stdio: "pipe", timeout: CHILD_TIMEOUT_MS });
  }

  // This suite's own PENDING fixture rows: the only ones the fallback may mark FAILED.
  const createdOutboxIds: string[] = [];
  // Set once beforeAll has found no prior seed; until then the fallback must not run.
  let ownsSeedState = false;

  async function pendingOutboxRow(): Promise<string> {
    const id = randomUUID();
    createdOutboxIds.push(id);
    await su.pool.query(
      `INSERT INTO audit_outbox (id, tenant_id, payload, status) VALUES ($1::uuid, $2::uuid, '{}', 'PENDING')`,
      [id, TENANT_ID],
    );
    return id;
  }

  async function markSent(outboxId: string): Promise<void> {
    await su.pool.query(`UPDATE audit_outbox SET status = 'SENT', sent_at = now() WHERE id = $1::uuid`, [outboxId]);
  }

  function seed(): Credential {
    seeder("--users", "1");
    const credentials = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Credential[];
    expect(credentials).toHaveLength(1);
    return credentials[0];
  }

  async function one<T>(text: string, ...params: unknown[]): Promise<T | undefined> {
    const { rows } = await su.pool.query(text, params);
    return rows[0] as T | undefined;
  }

  beforeAll(async () => {
    // Its cleanup deletes every lt-user-%@loadtest.local user, the fixed tenant
    // and the credentials file; refuse to run over a developer's own seed.
    const existing = await one<{ n: number }>(
      `SELECT (SELECT count(*) FROM users WHERE email LIKE 'lt-user-%@loadtest.local')
            + (SELECT count(*) FROM tenants WHERE id = $1::uuid) AS n`,
      TENANT_ID,
    );
    if (Number(existing?.n) !== 0 || existsSync(AUTH_FILE)) {
      throw new Error("LOAD_TEST_SEEDER_TEST_REFUSED: a load-test seed already exists; run npm run test:load:cleanup first");
    }
    ownsSeedState = true;
  });

  afterEach(() => {
    // A drain timeout well under the child's, so a left-behind PENDING row ends
    // in the seeder's named error rather than a kill.
    if (ownsSeedState) {
      execFileSync(process.execPath, [SEEDER, "--cleanup"], {
        env: seederEnv({ LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_MS: "5000" }),
        stdio: "pipe",
        timeout: CHILD_TIMEOUT_MS,
      });
    }
  });

  afterAll(async () => {
    // Fallback when the seeder's own cleanup broke (the regression these cells
    // catch): remove what it left, so the next run is not refused. Never over a
    // seed that predates the suite (vitest runs afterAll after a refusing
    // beforeAll), and FAILED only for this suite's own fixture rows.
    if (!ownsSeedState) {
      await su.prisma.$disconnect();
      await su.pool.end();
      return;
    }
    await su.pool.query(
      `UPDATE audit_outbox SET status = 'FAILED' WHERE id = ANY($1::uuid[]) AND status NOT IN ('SENT', 'FAILED')`,
      [createdOutboxIds],
    );
    const users = `(SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local')`;
    for (const statement of [
      `DELETE FROM audit_outbox WHERE tenant_id = $1::uuid`,
      `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
      `DELETE FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
      `DELETE FROM sessions WHERE user_id IN ${users}`,
      `DELETE FROM vault_keys WHERE user_id IN ${users}`,
      `DELETE FROM tenant_members WHERE tenant_id = $1::uuid`,
      `DELETE FROM users WHERE email LIKE 'lt-user-%@loadtest.local'`,
      `DELETE FROM tenants WHERE id = $1::uuid`,
    ]) {
      await su.pool.query(statement, statement.includes("$1") ? [TENANT_ID] : []);
    }
    if (existsSync(AUTH_FILE)) unlinkSync(AUTH_FILE);
    await su.prisma.$disconnect();
    await su.pool.end();
  });

  it("seeds a user whose session cookie resolves to an active member of the load-test tenant", async () => {
    const credential = seed();

    // The lookup the app does for the cookie: digest → session row.
    const session = await one<{ user_id: string; tenant_id: string; live: boolean }>(
      `SELECT user_id::text, tenant_id::text, expires > now() AS live FROM sessions WHERE session_token = $1`,
      hashSessionToken(credential.sessionToken),
    );
    expect(session).toEqual({ user_id: credential.userId, tenant_id: TENANT_ID, live: true });

    const member = await one<{ tenant_id: string; active: boolean }>(
      `SELECT u.tenant_id::text, m.deactivated_at IS NULL AS active
         FROM users u JOIN tenant_members m ON m.user_id = u.id AND m.tenant_id = u.tenant_id
        WHERE u.id = $1::uuid`,
      credential.userId,
    );
    expect(member).toEqual({ tenant_id: TENANT_ID, active: true });

    const vaultKey = await one<{ tenant_id: string }>(
      `SELECT tenant_id::text FROM vault_keys WHERE user_id = $1::uuid`,
      credential.userId,
    );
    expect(vaultKey).toEqual({ tenant_id: TENANT_ID });
  });

  it("a re-seed keeps the user id, replaces the session and reactivates a deactivated membership", async () => {
    const first = seed();
    await su.pool.query(`UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid`, [first.userId]);

    const second = seed();

    expect(second.userId).toBe(first.userId);
    const sessions = await su.pool.query(`SELECT session_token FROM sessions WHERE user_id = $1::uuid`, [second.userId]);
    expect(sessions.rows).toEqual([{ session_token: hashSessionToken(second.sessionToken) }]);
    const member = await one<{ active: boolean }>(
      `SELECT deactivated_at IS NULL AS active FROM tenant_members WHERE user_id = $1::uuid`,
      second.userId,
    );
    expect(member).toEqual({ active: true });
  });

  // audit_outbox refuses to delete a row that is not SENT or FAILED, so cleanup
  // waits for the worker and refuses by name when the outbox does not drain.
  it("cleanup refuses by name, deleting nothing, while an outbox row of the tenant stays PENDING", async () => {
    const credential = seed();
    const outboxId = await pendingOutboxRow();

    try {
      let stderr = "";
      try {
        execFileSync(process.execPath, [SEEDER, "--cleanup"], {
          env: seederEnv({ LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_MS: "0" }),
          stdio: "pipe",
          timeout: CHILD_TIMEOUT_MS,
        });
      } catch (e) {
        stderr = String((e as { stderr?: Buffer }).stderr ?? "");
      }
      expect(stderr).toContain("LOAD_TEST_CLEANUP_OUTBOX_UNDRAINED: 1 audit_outbox rows");

      const left = await one<{ users: number; tenants: number }>(
        `SELECT (SELECT count(*)::int FROM users WHERE id = $2::uuid) AS users,
                (SELECT count(*)::int FROM tenants WHERE id = $1::uuid) AS tenants`,
        TENANT_ID,
        credential.userId,
      );
      expect(left).toEqual({ users: 1, tenants: 1 });
    } finally {
      // The worker's part, so afterEach can clean up.
      await markSent(outboxId);
    }
  });

  it("cleanup waits for a PENDING outbox row the worker delivers, then completes", async () => {
    seed();
    const outboxId = await pendingOutboxRow();

    // Above the 20 s drain; the cell's own timeout (below) covers seed time too.
    const child = execFile(process.execPath, [SEEDER, "--cleanup"], {
      env: seederEnv({ LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_MS: "20000" }),
      timeout: 25_000,
    });
    let exited = false;
    try {
      const exit = new Promise<number | null>((resolve) => {
        child.on("exit", (code) => {
          exited = true;
          resolve(code);
        });
      });
      // Sync on the seeder reaching the drain wait (it prints this line right
      // before), not on a fixed sleep; then let at least one poll see PENDING.
      await new Promise<void>((resolve, reject) => {
        child.stdout?.on("data", (chunk: string) => {
          if (String(chunk).includes("Cleaning up 1 load test users")) resolve();
        });
        child.on("exit", () => reject(new Error("seeder exited before reaching the drain wait")));
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(exited).toBe(false);
      await markSent(outboxId);
      expect(await exit).toBe(0);
    } finally {
      if (!exited) child.kill();
      await markSent(outboxId);
    }

    const tenant = await one<{ n: number }>(`SELECT count(*)::int AS n FROM tenants WHERE id = $1::uuid`, TENANT_ID);
    expect(tenant).toEqual({ n: 0 });
  }, 60_000);

  it("cleanup leaves a user matching the load-test email pattern in another tenant alone", async () => {
    const foreignTenant = randomUUID();
    const foreignUser = randomUUID();
    await su.pool.query(
      `INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ($1::uuid, 'foreign', $2, now(), now())`,
      [foreignTenant, `foreign-${foreignTenant.slice(0, 8)}`],
    );
    try {
      await su.pool.query(
        `INSERT INTO users (id, email, tenant_id, created_at, updated_at) VALUES ($1::uuid, $2, $3::uuid, now(), now())`,
        [foreignUser, `lt-user-foreign-${foreignUser.slice(0, 8)}@loadtest.local`, foreignTenant],
      );
      await su.pool.query(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
        [randomUUID(), foreignTenant, foreignUser],
      );
      seed();

      seeder("--cleanup");

      const left = await one<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM users WHERE id = $1::uuid) AS foreign_user,
                (SELECT count(*)::int FROM tenant_members WHERE user_id = $1::uuid) AS foreign_member,
                (SELECT count(*)::int FROM tenants WHERE id = $2::uuid) AS load_test_tenant`,
        foreignUser,
        TENANT_ID,
      );
      expect(left).toEqual({ foreign_user: 1, foreign_member: 1, load_test_tenant: 0 });
    } finally {
      await su.pool.query(`DELETE FROM tenant_members WHERE tenant_id = $1::uuid`, [foreignTenant]);
      await su.pool.query(`DELETE FROM users WHERE id = $1::uuid`, [foreignUser]);
      await su.pool.query(`DELETE FROM tenants WHERE id = $1::uuid`, [foreignTenant]);
    }
  });

  it.each(["abc", "-1"])("cleanup refuses a drain timeout of %j by name", (value) => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [SEEDER, "--cleanup"], {
        env: seederEnv({ LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_MS: value }),
        stdio: "pipe",
        timeout: CHILD_TIMEOUT_MS,
      });
    } catch (e) {
      stderr = String((e as { stderr?: Buffer }).stderr ?? "");
    }
    expect(stderr).toContain("LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_MS must be a non-negative number of milliseconds");
  });

  it("cleanup removes the users and the tenant, including audit rows a worker wrote for the tenant", async () => {
    const credential = seed();
    // A drained event (outbox SENT + its audit_logs row) by an actor that is not
    // a load-test user: audit_logs.tenant_id is RESTRICT, so a row left behind
    // blocks the tenant delete.
    const outboxId = randomUUID();
    await su.pool.query(
      `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at) VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
      [outboxId, TENANT_ID],
    );
    await su.pool.query(
      `INSERT INTO audit_logs (id, tenant_id, scope, action, user_id, actor_type, metadata, created_at, outbox_id)
       VALUES ($1::uuid, $2::uuid, 'PERSONAL'::"AuditScope", 'ENTRY_CREATE'::"AuditAction", $3::uuid,
               'HUMAN'::"ActorType", '{}'::jsonb, now(), $4::uuid)`,
      [randomUUID(), TENANT_ID, randomUUID(), outboxId],
    );

    seeder("--cleanup");

    const left = await one<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM users WHERE email LIKE 'lt-user-%@loadtest.local') AS users,
              (SELECT count(*)::int FROM sessions WHERE session_token = $2) AS sessions,
              (SELECT count(*)::int FROM tenant_members WHERE tenant_id = $1::uuid) AS members,
              (SELECT count(*)::int FROM audit_logs WHERE tenant_id = $1::uuid) AS audit_logs,
              (SELECT count(*)::int FROM tenants WHERE id = $1::uuid) AS tenants`,
      TENANT_ID,
      hashSessionToken(credential.sessionToken),
    );
    expect(left).toEqual({ users: 0, sessions: 0, members: 0, audit_logs: 0, tenants: 0 });
    expect(existsSync(AUTH_FILE)).toBe(false);
  });
});
