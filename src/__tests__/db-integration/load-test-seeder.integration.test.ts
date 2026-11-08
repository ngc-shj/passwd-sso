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
import { promisify } from "node:util";
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

  async function pendingOutboxRow(): Promise<string> {
    const id = randomUUID();
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
  });

  afterEach(() => {
    seeder("--cleanup");
  });

  afterAll(async () => {
    // Fallback when the seeder's own cleanup broke (the regression these cells
    // catch): remove what it left, so the next run is not refused. Its outbox
    // rows are this test's fixtures; FAILED makes them deletable.
    const users = `(SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local')`;
    for (const statement of [
      `UPDATE audit_outbox SET status = 'FAILED' WHERE tenant_id = $1::uuid AND status NOT IN ('SENT', 'FAILED')`,
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
    // The worker's part, so afterEach can clean up.
    await markSent(outboxId);
  });

  it("cleanup waits for a PENDING outbox row the worker delivers, then completes", async () => {
    seed();
    const outboxId = await pendingOutboxRow();

    const cleanup = promisify(execFile)(process.execPath, [SEEDER, "--cleanup"], {
      env: seederEnv({ LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_MS: "20000" }),
      timeout: CHILD_TIMEOUT_MS,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await markSent(outboxId);
    await cleanup;

    const tenant = await one<{ n: number }>(`SELECT count(*)::int AS n FROM tenants WHERE id = $1::uuid`, TENANT_ID);
    expect(tenant).toEqual({ n: 0 });
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
