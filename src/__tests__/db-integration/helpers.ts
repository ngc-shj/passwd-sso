/**
 * Shared helpers for real-DB integration tests.
 *
 * Each test file should call createTestContext() in beforeAll and
 * ctx.cleanup() in afterAll. Within each test, use ctx.createTenant()
 * to get an isolated tenant UUID and ctx.deleteTestData(tenantId) in afterEach.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { randomUUID, randomBytes } from "node:crypto";

// ─── Role connection strings ────────────────────────────────────

type TestRole = "superuser" | "app" | "worker" | "retention-gc-worker";

function getConnectionString(role: TestRole): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set");

  switch (role) {
    case "superuser":
      // Use MIGRATION_DATABASE_URL if available, otherwise fall back to DATABASE_URL
      return process.env.MIGRATION_DATABASE_URL ?? base;
    case "app":
      return (
        process.env.APP_DATABASE_URL ??
        base.replace(
          /\/\/[^:]+:[^@]+@/,
          "//passwd_app:passwd_app_pass@",
        )
      );
    case "worker":
      return (
        process.env.OUTBOX_WORKER_DATABASE_URL ??
        base.replace(
          /\/\/[^:]+:[^@]+@/,
          "//passwd_outbox_worker:passwd_outbox_pass@",
        )
      );
    case "retention-gc-worker":
      return (
        process.env.RETENTION_GC_DATABASE_URL ??
        base.replace(
          /\/\/[^:]+:[^@]+@/,
          "//passwd_retention_gc_worker:passwd_retention_gc_pass@",
        )
      );
  }
}

// ─── Prisma client factory ──────────────────────────────────────

export interface PrismaWithPool {
  prisma: PrismaClient;
  pool: pg.Pool;
}

export function createPrismaForRole(role: TestRole): PrismaWithPool {
  const pool = new pg.Pool({
    connectionString: getConnectionString(role),
    max: 3,
    idleTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  return { prisma, pool };
}

// ─── Bypass RLS GUC helper ──────────────────────────────────────

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setBypassRlsGucs(client: any): Promise<void> {
  await client.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  await client.$executeRaw`SELECT set_config('app.bypass_purpose', 'audit_write', true)`;
  await client.$executeRaw`SELECT set_config('app.tenant_id', ${NIL_UUID}, true)`;
}

// ─── Test context ───────────────────────────────────────────────

export interface TestContext {
  /** Superuser (passwd_user) — for DDL, data setup, privilege queries */
  su: PrismaWithPool;
  /** App role (passwd_app) — for RLS enforcement tests */
  app: PrismaWithPool;
  /** Worker role (passwd_outbox_worker) — for privilege enumeration */
  worker: PrismaWithPool;
  /** Retention-GC-worker role (passwd_retention_gc_worker) — for sweeper privilege tests (C7/C10) */
  retentionWorker: PrismaWithPool;
  /** Create a tenant row and return its UUID */
  createTenant: () => Promise<string>;
  /** Create a user row belonging to a tenant and return its UUID */
  createUser: (tenantId: string) => Promise<string>;
  /** Delete all test data for a tenant (FK-safe order) */
  deleteTestData: (tenantId: string) => Promise<void>;
  /** Disconnect all pools */
  cleanup: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const su = createPrismaForRole("superuser");
  const app = createPrismaForRole("app");
  const worker = createPrismaForRole("worker");
  const retentionWorker = createPrismaForRole("retention-gc-worker");

  // Verify connectivity
  await su.prisma.$executeRaw`SELECT 1`;

  async function createTenant(): Promise<string> {
    const id = randomUUID();
    const slug = `test-${id.replace(/-/g, "").slice(0, 16)}`;
    await su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO tenants (id, name, slug, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, now(), now())`,
        id,
        `test-tenant-${id.slice(0, 8)}`,
        slug,
      );
    });
    return id;
  }

  async function createUser(tenantId: string): Promise<string> {
    const id = randomUUID();
    await su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO users (id, tenant_id, email, name, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, now(), now())`,
        id,
        tenantId,
        `test-${id.slice(0, 8)}@example.com`,
        `Test User ${id.slice(0, 8)}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'OWNER', now(), now())`,
        randomUUID(),
        tenantId,
        id,
      );
    });
    return id;
  }

  async function deleteTestData(tenantId: string): Promise<void> {
    await su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      // FK-safe deletion order
      await tx.$executeRawUnsafe(
        `DELETE FROM webhook_deliveries WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_deliveries WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_delivery_targets WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      // The before-delete trigger blocks DELETE of PENDING/PROCESSING rows,
      // so first move them to FAILED (which the trigger allows).
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
         WHERE tenant_id = $1::uuid AND status IN ('PENDING', 'PROCESSING')`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      // MCP / delegation cleanup (FK-safe order)
      await tx.$executeRawUnsafe(
        `DELETE FROM delegation_sessions WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_refresh_tokens WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_access_tokens WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_authorization_codes WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_clients WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM service_account_tokens WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM service_accounts WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      // Team-vault cleanup (FK-safe order: history → entries → keys → members → teams)
      await tx.$executeRawUnsafe(
        `DELETE FROM team_password_entry_histories WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM team_password_entries WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM team_member_keys WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM team_members WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      // Webhook config tables FK to teams/tenants — delete before teams.
      await tx.$executeRawUnsafe(
        `DELETE FROM team_webhooks WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tenant_webhooks WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM teams WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      // Personal-vault cleanup (FK-safe order: history → entries)
      await tx.$executeRawUnsafe(
        `DELETE FROM password_entry_histories WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM password_entries WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tenant_members WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM users WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = $1::uuid`,
        tenantId,
      );
    });
  }

  async function cleanup(): Promise<void> {
    await Promise.all([
      su.prisma.$disconnect().then(() => su.pool.end()),
      app.prisma.$disconnect().then(() => app.pool.end()),
      worker.prisma.$disconnect().then(() => worker.pool.end()),
      retentionWorker.prisma.$disconnect().then(() => retentionWorker.pool.end()),
    ]);
  }

  return { su, app, worker, retentionWorker, createTenant, createUser, deleteTestData, cleanup };
}

// ─── Deferred barrier for concurrency tests ─────────────────────

export class Deferred<T = void> {
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;
  promise: Promise<T>;

  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

// ─── Vault-user seed helper ──────────────────────────────────────

/**
 * Seed a minimal vault-enabled user (sets encrypted_secret_key, key_version,
 * vault_setup_at, account_salt, etc.) directly via the superuser pool so
 * tests do not need a real passphrase-setup flow.
 *
 * vault_setup_at + account_salt are read by the rotation tuple-CAS
 * (applyVaultRotation's pre-write FOR UPDATE check), so both must be set
 * here and returned for callers to pass as the CAS snapshot.
 */
export async function seedVaultUser(
  ctx: TestContext,
  tenantId: string,
): Promise<{ userId: string; keyVersion: number; vaultSetupAt: Date; accountSalt: string }> {
  const userId = await ctx.createUser(tenantId);
  const keyVersion = 1;
  const accountSalt = randomBytes(16).toString("hex");
  const vaultSetupAt = new Date();

  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE users SET
         encrypted_secret_key = $2,
         secret_key_iv = $3,
         secret_key_auth_tag = $4,
         account_salt = $5,
         master_password_server_hash = $6,
         master_password_server_salt = $7,
         key_version = $8,
         encrypted_ecdh_private_key = $9,
         ecdh_private_key_iv = $10,
         ecdh_private_key_auth_tag = $11,
         vault_setup_at = $12
       WHERE id = $1::uuid`,
      userId,
      "placeholder-esk",
      randomBytes(12).toString("hex"),
      randomBytes(16).toString("hex"),
      accountSalt,
      randomBytes(32).toString("hex"),
      randomBytes(32).toString("hex"),
      keyVersion,
      "placeholder-ecdh",
      randomBytes(12).toString("hex"),
      randomBytes(16).toString("hex"),
      vaultSetupAt,
    );
  });

  return { userId, keyVersion, vaultSetupAt, accountSalt };
}

// ─── Statistical concurrency primitive ──────────────────────────

/**
 * Run two operations in parallel against distinct Prisma clients
 * (= distinct pg.Pool connections), pre-warming both connections so the
 * race window is as tight as `Promise.all` allows.
 *
 * The pg_advisory_lock barrier pattern was considered (plan §11.2 option
 * (b)) but option (a) — the statistical loop — is what callers should
 * wrap this in: 50 iterations is sufficient to flush ordering
 * nondeterminism on a connection-pooled real DB without adding a new
 * concurrency primitive to the repo (no existing precedent).
 */
export async function raceTwoClients<A, B>(
  clientA: PrismaClient,
  clientB: PrismaClient,
  opA: (c: PrismaClient) => Promise<A>,
  opB: (c: PrismaClient) => Promise<B>,
): Promise<[A, B]> {
  // Pre-warm both pooled connections so neither path pays a connection-
  // setup cost during the race.
  await Promise.all([
    clientA.$executeRawUnsafe(`SELECT 1`),
    clientB.$executeRawUnsafe(`SELECT 1`),
  ]);
  return Promise.all([opA(clientA), opB(clientB)]) as Promise<[A, B]>;
}
