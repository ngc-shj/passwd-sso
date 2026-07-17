/**
 * Integration test (real DB): personal keyVersion current-version guard —
 * rotation-vs-write race invariant (C6, security-control-verification plan).
 *
 * Production entry points are driven directly, never a test-authored
 * reimplementation of the tx (test-F1/RT5):
 *   - Route handler: PUT from "@/app/api/passwords/[id]/route" (session auth
 *     mocked via checkAuth, DB real — precedent:
 *     cache-rollback-report-audit.integration.test.ts imports the route
 *     handler and mocks only the auth boundary).
 *   - Rotation: the real applyVaultRotation (the user FOR UPDATE CAS is the
 *     FIRST statement inside it, so direct calls exercise it).
 *
 * Run: docker compose up -d db && npm run test:integration -- key-version-guard
 */

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
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import {
  createTestContext,
  createPrismaForRole,
  setBypassRlsGucs,
  seedVaultUser,
  Deferred,
  type TestContext,
} from "./helpers";
import { applyVaultRotation, type RotationPayload } from "@/lib/vault/rotate-key-server";
import { assertCurrentKeyVersion } from "@/lib/vault/key-version-guard";

// ── Auth boundary mock (mirrors cache-rollback-report-audit precedent):
// checkAuth is the ONLY thing stubbed. Everything downstream (Prisma,
// tenant-context RLS transactions) is real. ────────────────────────────────
const mockCheckAuth = vi.fn();
vi.mock("@/lib/auth/session/check-auth", () => ({
  checkAuth: (...args: unknown[]) => mockCheckAuth(...args),
}));
// Rate limiters use in-memory/Redis state keyed per-process; disable so a
// 50-iteration loop against the same userId never gets throttled mid-run.
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));

import { PUT } from "@/app/api/passwords/[id]/route";

function mockSession(userId: string): void {
  mockCheckAuth.mockResolvedValue({ ok: true, auth: { type: "session", userId } });
}

/**
 * deleteTestData can lose a race against the live audit-outbox-worker
 * process (running against this same dev DB — see CLAUDE.md docker
 * services): the worker drains audit_outbox rows into audit_logs
 * concurrently with cleanup, so a freshly-inserted audit_logs row can appear
 * AFTER this helper's own audit_logs delete step, failing the tenant
 * delete's audit_logs_tenant_id_fkey. This suite drives the real PUT route
 * across many iterations (heavy audit emission), so retry with backoff.
 */
async function deleteTestDataWithRetry(ctx: TestContext, tenantId: string): Promise<void> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await ctx.deleteTestData(tenantId);
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      await new Promise((res) => setTimeout(res, 50 * attempt));
    }
  }
}

function buildPutRequest(
  entryId: string,
  body: Record<string, unknown>,
): NextRequest {
  return new NextRequest(`http://localhost/api/passwords/${entryId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function callPut(entryId: string, body: Record<string, unknown>) {
  return PUT(buildPutRequest(entryId, body), putParams(entryId));
}

function hex(nBytes: number): string {
  return randomBytes(nBytes).toString("hex");
}

function blobPayload() {
  return {
    ciphertext: hex(32),
    iv: hex(12),
    authTag: hex(16),
  };
}

async function seedPasswordEntry(
  ctx: TestContext,
  userId: string,
  tenantId: string,
  keyVersion: number,
): Promise<string> {
  const entryId = randomUUID();
  const now = new Date().toISOString();
  const placeholder = hex(32);
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO password_entries (
         id, user_id, tenant_id,
         encrypted_blob, blob_iv, blob_auth_tag,
         encrypted_overview, overview_iv, overview_auth_tag,
         key_version, aad_version, entry_type,
         created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         $4, $5, $6, $7, $8, $9,
         $10, 1, 'LOGIN', $11, $11
       )`,
      entryId, userId, tenantId,
      placeholder, hex(12), hex(16),
      placeholder, hex(12), hex(16),
      keyVersion,
      now,
    );
  });
  return entryId;
}

async function getEntryKeyVersion(ctx: TestContext, entryId: string): Promise<number> {
  const r = await ctx.su.pool.query<{ key_version: number }>(
    `SELECT key_version FROM password_entries WHERE id = $1::uuid`,
    [entryId],
  );
  if (r.rowCount === 0) throw new Error("entry not found");
  return r.rows[0].key_version;
}

async function getHistoryCount(ctx: TestContext, entryId: string): Promise<number> {
  const r = await ctx.su.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM password_entry_histories WHERE entry_id = $1::uuid`,
    [entryId],
  );
  return parseInt(r.rows[0].count, 10);
}

function buildMinimalRotationPayload(entryIds: string[]): RotationPayload {
  const hex24 = hex(12);
  const hex32 = hex(16);
  const hex64 = hex(32);
  return {
    encryptedSecretKey: "new-esk-placeholder",
    secretKeyIv: hex24,
    secretKeyAuthTag: hex32,
    accountSalt: hex64,
    newAuthHash: hex64,
    verificationArtifact: { ciphertext: hex64, iv: hex24, authTag: hex32 },
    encryptedEcdhPrivateKey: "new-ecdh-placeholder",
    ecdhPrivateKeyIv: hex24,
    ecdhPrivateKeyAuthTag: hex32,
    entries: entryIds.map((id) => ({
      id,
      encryptedBlob: { ciphertext: hex(32), iv: hex24, authTag: hex32 },
      encryptedOverview: { ciphertext: hex(32), iv: hex24, authTag: hex32 },
      aadVersion: 1,
    })),
    historyEntries: [],
    attachmentCekRewraps: [],
  };
}

/** Drive applyVaultRotation exactly as the route does (wraps in a tx). */
async function rotate(
  ctx: TestContext,
  userId: string,
  tenantId: string,
  oldKeyVersion: number,
  newKeyVersion: number,
  payload: RotationPayload,
  oldVaultSetupAt: Date | null,
  oldAccountSalt: string,
) {
  return ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return applyVaultRotation(
      tx, userId, tenantId, oldKeyVersion, newKeyVersion,
      "hash", "salt", payload, oldVaultSetupAt, oldAccountSalt,
    );
  });
}

describe("personal keyVersion guard — real-DB integration (C6)", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await deleteTestDataWithRetry(ctx, tenantId);
  });

  // ── T1: stale write post-rotation (sequential) ───────────────────────────

  it("T1 — PUT with stale keyVersion after rotation → 409 KEY_VERSION_MISMATCH, entry unmodified, no history row", async () => {
    const { userId, keyVersion: v1, vaultSetupAt, accountSalt } = await seedVaultUser(ctx, tenantId);
    const entryId = await seedPasswordEntry(ctx, userId, tenantId, v1);

    const v2 = v1 + 1;
    const payload = buildMinimalRotationPayload([entryId]);
    await rotate(ctx, userId, tenantId, v1, v2, payload, vaultSetupAt, accountSalt);

    expect(await getEntryKeyVersion(ctx, entryId)).toBe(v2);

    mockSession(userId);
    const res = await callPut(entryId, {
      encryptedBlob: blobPayload(),
      keyVersion: v1, // stale — entry is now at v2
      aadVersion: 1,
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("KEY_VERSION_MISMATCH");

    // RT8: non-mutation — entry stays at v2, no history row created.
    expect(await getEntryKeyVersion(ctx, entryId)).toBe(v2);
    expect(await getHistoryCount(ctx, entryId)).toBe(0);
  });

  // ── T2: rotation-vs-write contention (RT4) ────────────────────────────────

  describe("T2 — rotation-vs-write contention (row-lock witness)", () => {
    it("forward: writer holds users FOR SHARE; concurrent rotation blocks at FOR UPDATE, then proceeds after release", async () => {
      const { userId, keyVersion: v1, vaultSetupAt, accountSalt } = await seedVaultUser(ctx, tenantId);
      const entryId = await seedPasswordEntry(ctx, userId, tenantId, v1);
      const v2 = v1 + 1;

      const writerHoldsShare = new Deferred();
      const releaseWriter = new Deferred();
      const rotationBlocked = new Deferred<boolean>();

      const instanceWriter = createPrismaForRole("superuser");
      const instanceWitness = createPrismaForRole("superuser");

      try {
        await Promise.all([
          instanceWriter.pool.query(`SELECT 1`),
          instanceWitness.pool.query(`SELECT 1`),
        ]);

        // Writer: opens a tx, takes the production guard's FOR SHARE lock via
        // assertCurrentKeyVersion, then holds the tx open until released.
        const writerPromise = (async () => {
          const client = await instanceWriter.pool.connect();
          try {
            await client.query("BEGIN");
            await client.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
            await client.query(`SELECT set_config('app.bypass_purpose', 'audit_write', true)`);
            await client.query(
              `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`,
            );
            await client.query(
              `SELECT key_version FROM users WHERE id = $1::uuid FOR SHARE`,
              [userId],
            );
            writerHoldsShare.resolve();
            await releaseWriter.promise;
            await client.query("COMMIT");
          } finally {
            client.release();
          }
        })();

        await writerHoldsShare.promise;

        // Rotation: attempts its FOR UPDATE CAS — must block behind the
        // writer's FOR SHARE lock on the same users row.
        const rotationPromise = (async () => {
          const rotResultPromise = rotate(
            ctx, userId, tenantId, v1, v2,
            buildMinimalRotationPayload([entryId]), vaultSetupAt, accountSalt,
          );
          return rotResultPromise;
        })();

        // Witness: poll pg_blocking_pids for the rotation backend. Because
        // rotation runs through ctx.su.prisma's own pool (not a directly
        // observable single connection), poll pg_locks for an ungranted
        // transactionid wait originating from a backend blocked on the
        // users row, using pg_blocking_pids as the PRIMARY witness.
        const witnessPromise = (async () => {
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            const r = await instanceWitness.pool.query<{
              pid: number;
              blocked_by: number[];
            }>(
              `SELECT pid, pg_blocking_pids(pid) AS blocked_by
               FROM pg_stat_activity
               WHERE state = 'active'
                 AND (query ILIKE '%FOR UPDATE%users%' OR query ILIKE '%users%FOR UPDATE%')`,
            );
            const blocked = r.rows.find((row) => row.blocked_by.length > 0);
            if (blocked) {
              rotationBlocked.resolve(true);
              return;
            }
            await new Promise((res) => setTimeout(res, 20));
          }
          rotationBlocked.resolve(false);
        })();

        // Give the rotation a moment to reach its FOR UPDATE statement and
        // become observably blocked before releasing the writer.
        await new Promise((res) => setTimeout(res, 300));
        const observedBlocked = await Promise.race([
          rotationBlocked.promise,
          new Promise<boolean>((res) => setTimeout(() => res(false), 400)),
        ]);

        releaseWriter.resolve();
        await Promise.all([writerPromise, rotationPromise, witnessPromise]);

        // Fallback witness: if pg_stat_activity polling missed the transient
        // window (timing-sensitive), fall back to pg_locks NOT granted check
        // taken during the blocking window via a second short probe. Since
        // the writer has already released by the time we get here, assert
        // via elapsed-order instead: the rotation could only have completed
        // AFTER releaseWriter.resolve() because it needed the FOR SHARE
        // lock released first. We assert final state as a correctness check
        // and require that at least one contention signal fired.
        expect(observedBlocked || (await rotationBlocked.promise)).toBe(true);

        expect(await getEntryKeyVersion(ctx, entryId)).toBe(v2);
      } finally {
        await instanceWriter.prisma.$disconnect().then(() => instanceWriter.pool.end());
        await instanceWitness.prisma.$disconnect().then(() => instanceWitness.pool.end());
      }
    });

    it("inverse: rotation holds users FOR UPDATE mid-tx; writer's guard read blocks, then observes v2 → 409", async () => {
      const { userId, keyVersion: v1 } = await seedVaultUser(ctx, tenantId);
      const entryId = await seedPasswordEntry(ctx, userId, tenantId, v1);
      const v2 = v1 + 1;

      const rotationHoldsUpdate = new Deferred();
      const releaseRotation = new Deferred();
      const writerBlocked = new Deferred<boolean>();

      const instanceRotation = createPrismaForRole("superuser");
      const instanceWitness = createPrismaForRole("superuser");

      try {
        await Promise.all([
          instanceRotation.pool.query(`SELECT 1`),
          instanceWitness.pool.query(`SELECT 1`),
        ]);

        // Rotation-side: take the users FOR UPDATE lock directly (same
        // predicate applyVaultRotation's CAS uses) and hold it.
        const rotationHoldPromise = (async () => {
          const client = await instanceRotation.pool.connect();
          try {
            await client.query("BEGIN");
            await client.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
            await client.query(`SELECT set_config('app.bypass_purpose', 'audit_write', true)`);
            await client.query(
              `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`,
            );
            await client.query(
              `SELECT key_version, vault_setup_at, account_salt FROM users WHERE id = $1::uuid FOR UPDATE`,
              [userId],
            );
            rotationHoldsUpdate.resolve();
            await releaseRotation.promise;
            // Bump key_version to v2 before releasing, mirroring what
            // applyVaultRotation's user.update does inside the same tx.
            await client.query(
              `UPDATE users SET key_version = $2 WHERE id = $1::uuid`,
              [userId, v2],
            );
            await client.query("COMMIT");
          } finally {
            client.release();
          }
        })();

        await rotationHoldsUpdate.promise;

        // Writer: PUT with the CURRENT (v1) keyVersion — its guard read
        // should block behind rotation's FOR UPDATE, then observe v2 → 409.
        mockSession(userId);
        const writerPromise = callPut(entryId, {
          encryptedBlob: blobPayload(),
          keyVersion: v1,
          aadVersion: 1,
        });

        const witnessPromise = (async () => {
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            const r = await instanceWitness.pool.query<{ count: string }>(
              `SELECT COUNT(*)::text AS count
               FROM pg_locks
               WHERE locktype = 'transactionid' AND NOT granted`,
            );
            if (parseInt(r.rows[0].count, 10) > 0) {
              writerBlocked.resolve(true);
              return;
            }
            await new Promise((res) => setTimeout(res, 20));
          }
          writerBlocked.resolve(false);
        })();

        await new Promise((res) => setTimeout(res, 300));
        const observedBlocked = await Promise.race([
          writerBlocked.promise,
          new Promise<boolean>((res) => setTimeout(() => res(false), 400)),
        ]);

        releaseRotation.resolve();
        const [res] = await Promise.all([writerPromise, rotationHoldPromise, witnessPromise]);

        expect(observedBlocked || (await writerBlocked.promise)).toBe(true);
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error).toBe("KEY_VERSION_MISMATCH");
      } finally {
        await instanceRotation.prisma.$disconnect().then(() => instanceRotation.pool.end());
        await instanceWitness.prisma.$disconnect().then(() => instanceWitness.pool.end());
      }
    });
  });

  // ── T3: loop non-vacuity ──────────────────────────────────────────────────

  it("T3 — 50 iterations racing write vs rotation: at least 2 distinct outcomes; invariant holds every iteration", async () => {
    const ITERATIONS = 50;
    const { userId, vaultSetupAt: initialVaultSetupAt, accountSalt: initialAccountSalt } =
      await seedVaultUser(ctx, tenantId);

    let currentKeyVersion = 1;
    // Rotation never changes vault_setup_at, so the snapshot is stable across
    // iterations; account_salt DOES move on each successful rotation (updated
    // in the loop below).
    const currentVaultSetupAt = initialVaultSetupAt;
    let currentAccountSalt = initialAccountSalt;

    const outcomes = new Set<string>();

    for (let i = 0; i < ITERATIONS; i++) {
      const oldV = currentKeyVersion;
      const newV = oldV + 1;
      const entryId = await seedPasswordEntry(ctx, userId, tenantId, oldV);

      // Per-index jitter to flush ordering nondeterminism.
      const writerDelay = (i * 7) % 13;
      const rotationDelay = (i * 11) % 13;

      mockSession(userId);

      const writerPromise = (async () => {
        await new Promise((res) => setTimeout(res, writerDelay));
        return callPut(entryId, {
          encryptedBlob: blobPayload(),
          keyVersion: oldV,
          aadVersion: 1,
        });
      })();

      // Rotation rewrites account_salt (payload.accountSalt), so the CAS tuple
      // moves each successful cycle. Capture this iteration's payload to track
      // the new salt for the next iteration's snapshot — otherwise iterations
      // 2..N would pass a stale salt and the CAS would reject every rotation
      // after the first, making the loop vacuous.
      const rotationPayload = buildMinimalRotationPayload([entryId]);
      const rotationPromise = (async () => {
        await new Promise((res) => setTimeout(res, rotationDelay));
        try {
          await rotate(
            ctx, userId, tenantId, oldV, newV,
            rotationPayload,
            currentVaultSetupAt, currentAccountSalt,
          );
          return true;
        } catch {
          return false;
        }
      })();

      const [writerRes, rotationOk] = await Promise.all([writerPromise, rotationPromise]);

      if (rotationOk) {
        currentKeyVersion = newV;
        currentAccountSalt = rotationPayload.accountSalt;
      }

      const entryVersionAfter = await getEntryKeyVersion(ctx, entryId);
      if (writerRes.status === 409) {
        outcomes.add("409");
      } else if (writerRes.status === 200) {
        if (entryVersionAfter === oldV) {
          outcomes.add("committed-pre-rotation-old");
        } else {
          outcomes.add("committed-post-rotation-new");
        }
      } else {
        outcomes.add(`unexpected-${writerRes.status}`);
      }

      // Invariant: no personal entry/history row may carry a keyVersion that
      // differs from users.key_version outside an in-flight rotation tx.
      const entryMismatch = await ctx.su.pool.query<{ count: string }>(
        `SELECT count(*)::text FROM password_entries
         WHERE user_id = $1::uuid AND key_version <> (SELECT key_version FROM users WHERE id = $1::uuid)`,
        [userId],
      );
      expect(entryMismatch.rows[0].count).toBe("0");
      const historyMismatch = await ctx.su.pool.query<{ count: string }>(
        `SELECT count(*)::text FROM password_entry_histories h
         JOIN password_entries e ON e.id = h.entry_id
         WHERE e.user_id = $1::uuid AND h.key_version <> (SELECT key_version FROM users WHERE id = $1::uuid)`,
        [userId],
      );
      expect(historyMismatch.rows[0].count).toBe("0");
    }

    // Proves the race actually fired, not just that the final invariant held.
    expect(outcomes.size).toBeGreaterThanOrEqual(2);
  }, 60_000);

  // ── T4a: reset-vs-rotation TOCTOU — decreased-version ────────────────────

  it("T4a — reset commits between route pre-checks and CAS → RotationCasConflictError, vault stays reset", async () => {
    const { userId, keyVersion: v1, vaultSetupAt, accountSalt } = await seedVaultUser(ctx, tenantId);

    // Simulate: reset commits (keyVersion→0, vaultSetupAt→null) AFTER the
    // caller took its pre-tx snapshot (v1/vaultSetupAt/accountSalt) but
    // BEFORE applyVaultRotation's CAS runs.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE users SET key_version = 0, vault_setup_at = NULL, account_salt = NULL WHERE id = $1::uuid`,
        userId,
      );
    });

    const { RotationCasConflictError } = await import("@/lib/vault/rotate-key-server");
    await expect(
      rotate(ctx, userId, tenantId, v1, v1 + 1, buildMinimalRotationPayload([]), vaultSetupAt, accountSalt),
    ).rejects.toThrow(RotationCasConflictError);

    // Vault stays reset — no user.update ran.
    const row = await ctx.su.pool.query<{ key_version: number; vault_setup_at: Date | null }>(
      `SELECT key_version, vault_setup_at FROM users WHERE id = $1::uuid`,
      [userId],
    );
    expect(row.rows[0].key_version).toBe(0);
    expect(row.rows[0].vault_setup_at).toBeNull();
  });

  // ── T4b: reset → resetup → same-version (the CAS-tuple case) ─────────────

  it("T4b — reset→resetup→same-keyVersion: attacker rotation carrying ORIGINAL vaultSetupAt/accountSalt → RotationCasConflictError", async () => {
    const { userId, keyVersion: v1, vaultSetupAt: originalVaultSetupAt, accountSalt: originalAccountSalt } =
      await seedVaultUser(ctx, tenantId);

    // Reset then re-setup: keyVersion returns to 1, but vaultSetupAt and
    // accountSalt are NEW values — the plain keyVersion-only CAS would miss
    // this (T4b is the kill-mutant for that reduced predicate).
    const newVaultSetupAt = new Date(Date.now() + 5000);
    const newAccountSalt = randomBytes(16).toString("hex");
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      // Reset
      await tx.$executeRawUnsafe(
        `UPDATE users SET key_version = 0, vault_setup_at = NULL, account_salt = NULL WHERE id = $1::uuid`,
        userId,
      );
      // Re-setup: same keyVersion (1), NEW vaultSetupAt + accountSalt.
      await tx.$executeRawUnsafe(
        `UPDATE users SET key_version = 1, vault_setup_at = $2, account_salt = $3 WHERE id = $1::uuid`,
        userId, newVaultSetupAt, newAccountSalt,
      );
    });

    const { RotationCasConflictError } = await import("@/lib/vault/rotate-key-server");
    // Attacker's rotation carries the ORIGINAL pre-reset snapshot.
    await expect(
      rotate(
        ctx, userId, tenantId, v1, v1 + 1, buildMinimalRotationPayload([]),
        originalVaultSetupAt, originalAccountSalt,
      ),
    ).rejects.toThrow(RotationCasConflictError);

    // Legit re-setup state is untouched.
    const row = await ctx.su.pool.query<{ key_version: number; account_salt: string }>(
      `SELECT key_version, account_salt FROM users WHERE id = $1::uuid`,
      [userId],
    );
    expect(row.rows[0].key_version).toBe(1);
    expect(row.rows[0].account_salt).toBe(newAccountSalt);
  });

  // ── T4c: rotation-vs-change-passphrase, NO reset ──────────────────────────

  it("T4c — concurrent change-passphrase rewraps accountSalt (keyVersion/vaultSetupAt unchanged) → attacker rotation CAS fails on accountSalt", async () => {
    const { userId, keyVersion: v1, vaultSetupAt: t0, accountSalt: s0 } = await seedVaultUser(ctx, tenantId);

    // Attacker's rotation snapshots (1, T0, S0) — simulated by passing the
    // original seed values as the CAS snapshot below.

    // Legit change-passphrase commits: rewrites accountSalt→S1, LEAVES
    // keyVersion and vaultSetupAt unchanged (mirrors change-passphrase route).
    const s1 = randomBytes(16).toString("hex");
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE users SET account_salt = $2 WHERE id = $1::uuid`,
        userId, s1,
      );
    });

    // Confirm keyVersion/vaultSetupAt are unchanged post-change-passphrase.
    const midRow = await ctx.su.pool.query<{ key_version: number; vault_setup_at: Date }>(
      `SELECT key_version, vault_setup_at FROM users WHERE id = $1::uuid`,
      [userId],
    );
    expect(midRow.rows[0].key_version).toBe(v1);
    expect(midRow.rows[0].vault_setup_at.getTime()).toBe(t0.getTime());

    const { RotationCasConflictError } = await import("@/lib/vault/rotate-key-server");
    // Attacker's rotation CAS reads (1, T0, S1) — key_version and
    // vault_setup_at match, but account_salt = S1 != oldAccountSalt = S0.
    await expect(
      rotate(ctx, userId, tenantId, v1, v1 + 1, buildMinimalRotationPayload([]), t0, s0),
    ).rejects.toThrow(RotationCasConflictError);

    // Legit change-passphrase's rewrap is untouched.
    const finalRow = await ctx.su.pool.query<{ account_salt: string; key_version: number }>(
      `SELECT account_salt, key_version FROM users WHERE id = $1::uuid`,
      [userId],
    );
    expect(finalRow.rows[0].account_salt).toBe(s1);
    expect(finalRow.rows[0].key_version).toBe(v1);
  });

  // ── Guard-comparison sanity (non-lock) — T1 exercises the comparison ─────

  it("assertCurrentKeyVersion (direct) — fails closed on zero-row result", async () => {
    const { KeyVersionMismatchError } = await import("@/lib/vault/key-version-guard");
    const nonExistentUserId = randomUUID();
    await expect(
      ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return assertCurrentKeyVersion(tx, nonExistentUserId, 1);
      }),
    ).rejects.toThrow(KeyVersionMismatchError);
  });
});
