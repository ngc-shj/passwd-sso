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
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPrismaForRole } from "./helpers";
import { hashSessionToken } from "@/lib/auth/session/session-cache";

const SEEDER = join(process.cwd(), "load-test/setup/seed-load-test-users.mjs");
const AUTH_FILE = join(process.cwd(), "load-test/setup/.load-test-auth.json");
const TENANT_ID = "00000000-0000-4000-a000-0000000010ad";

interface Credential {
  userId: string;
  sessionToken: string;
}

describe("load-test seeder — real-DB integration", () => {
  // The seeder writes through a role that bypasses RLS, as its README requires.
  const su = createPrismaForRole("superuser");

  function seeder(...args: string[]): void {
    execFileSync(process.execPath, [SEEDER, ...args], {
      env: {
        ...process.env,
        DATABASE_URL: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
        ALLOW_LOAD_TEST_SEED: "true",
        ALLOW_NON_TEST_DBNAME: "true",
        // Nothing listens here: the post-seed request is skipped, not failed.
        BASE_URL: "http://127.0.0.1:9",
      },
      stdio: "pipe",
    });
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
