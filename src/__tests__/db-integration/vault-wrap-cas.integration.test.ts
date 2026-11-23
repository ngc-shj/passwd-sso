/**
 * Integration test (real DB): the vault-wrap compare-and-swap on accountSalt
 * in change-passphrase and recovery-key/recover, and on accountSalt +
 * keyVersion in recovery-key/generate.
 *
 * Both routes check the old secret against a snapshot read in one
 * transaction and write the new wrap in another, as
 * `updateMany({ where: { id, accountSalt: <snapshot> } })` under the app role
 * and withTenantRls. The unit tests mock Prisma, so only a real database shows
 * that the legitimate writer's updateMany matches its row under the users RLS
 * policy (count 1) and that a writer whose snapshot went stale matches none
 * (count 0 → 409 VAULT_WRAP_CONFLICT, no audit row).
 *
 * The race is made deterministic: a blocker transaction holds the user row
 * FOR UPDATE, both requests read their snapshot (a plain SELECT, not blocked)
 * and park on the UPDATE, and only then is the blocker committed. The first
 * waiter writes; the second re-evaluates its WHERE against the committed row
 * under READ COMMITTED and matches nothing. Without the barrier the second
 * request could read the first one's committed verifier and be refused by the
 * verifier check instead, never reaching the CAS — which is exactly what the
 * sequential control below shows.
 *
 * Production entry points are driven directly; only the auth and rate-limit
 * boundaries are mocked (precedent: bulk-import-entry-isolation).
 *
 * Run: docker compose up -d db && npm run test:integration -- vault-wrap-cas
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { createTestContext, seedVaultUser, setBypassRlsGucs, type TestContext } from "./helpers";
import { createRaceHelpers } from "./race-helpers";
import { hmacVerifier } from "@/lib/crypto/crypto-server";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));

import { POST as changePassphrase } from "@/app/api/vault/change-passphrase/route";
import { POST as recoverVault } from "@/app/api/vault/recovery-key/recover/route";
import { POST as generateRecoveryKey } from "@/app/api/vault/recovery-key/generate/route";

const CHANGE_URL = "http://localhost/api/vault/change-passphrase";
const RECOVER_URL = "http://localhost/api/vault/recovery-key/recover";
const GENERATE_URL = "http://localhost/api/vault/recovery-key/generate";

function hex(nBytes: number): string {
  return randomBytes(nBytes).toString("hex");
}

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A new passphrase wrap, as the client sends it. */
function newWrap() {
  return {
    encryptedSecretKey: hex(48),
    secretKeyIv: hex(12),
    secretKeyAuthTag: hex(16),
    accountSalt: hex(32),
    newVerifierHash: hex(32),
  };
}

/** A recovery reset body proving `recoveryVerifierHash`, with a fresh wrap. */
function resetBody(recoveryVerifierHash: string) {
  return {
    step: "reset",
    verifierHash: recoveryVerifierHash,
    ...newWrap(),
    recoveryEncryptedSecretKey: hex(48),
    recoverySecretKeyIv: hex(12),
    recoverySecretKeyAuthTag: hex(16),
    recoveryHkdfSalt: hex(32),
    recoveryVerifierHash: hex(32),
  };
}

/** A recovery-key generate body proving `currentVerifierHash`. */
function generateBody(currentVerifierHash: string) {
  return {
    currentVerifierHash,
    encryptedSecretKey: hex(48),
    secretKeyIv: hex(12),
    secretKeyAuthTag: hex(16),
    hkdfSalt: hex(32),
    verifierHash: hex(32),
  };
}

type Wrap = { accountSalt: string; encryptedSecretKey: string };

/**
 * Seed a vault user whose passphrase verifier and recovery verifier are the
 * HMACs of the returned hashes, as the routes check them.
 */
async function seedUserWithVerifiers(ctx: TestContext, tenantId: string) {
  const { userId, accountSalt, keyVersion } = await seedVaultUser(ctx, tenantId);
  const passphraseVerifierHash = hex(32);
  const recoveryVerifierHash = hex(32);
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE users SET
         passphrase_verifier_hmac = $2,
         passphrase_verifier_version = $3,
         recovery_encrypted_secret_key = $4,
         recovery_secret_key_iv = $5,
         recovery_secret_key_auth_tag = $6,
         recovery_hkdf_salt = $7,
         recovery_verifier_hmac = $8,
         recovery_verifier_version = $3,
         recovery_key_set_at = now()
       WHERE id = $1::uuid`,
      userId,
      hmacVerifier(passphraseVerifierHash),
      VERIFIER_VERSION,
      hex(48),
      hex(12),
      hex(16),
      hex(32),
      hmacVerifier(recoveryVerifierHash),
    );
  });
  return { userId, accountSalt, keyVersion, passphraseVerifierHash, recoveryVerifierHash };
}

async function storedWrap(ctx: TestContext, userId: string): Promise<Wrap> {
  const r = await ctx.su.pool.query<{ account_salt: string; encrypted_secret_key: string }>(
    `SELECT account_salt, encrypted_secret_key FROM users WHERE id = $1::uuid`,
    [userId],
  );
  return { accountSalt: r.rows[0].account_salt, encryptedSecretKey: r.rows[0].encrypted_secret_key };
}

/**
 * Audit rows for `action` by `userId`, optionally narrowed by metadata.phase.
 * Looks in both the outbox and audit_logs, in case a worker drained a row.
 */
async function auditCount(
  ctx: TestContext,
  tenantId: string,
  userId: string,
  action: string,
  phase?: string,
): Promise<number> {
  const r = await ctx.su.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
       SELECT payload->'metadata'->>'phase' AS phase FROM audit_outbox
        WHERE tenant_id = $1::uuid AND payload->>'userId' = $2 AND payload->>'action' = $3
       UNION ALL
       SELECT metadata->>'phase' FROM audit_logs
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND action = $3::"AuditAction"
     ) a WHERE $4::text IS NULL OR a.phase = $4::text`,
    [tenantId, userId, action, phase ?? null],
  );
  return r.rows[0].n;
}

type Outcome = { status: number; body: { error?: string; success?: boolean } };

async function outcome(res: Response): Promise<Outcome> {
  return { status: res.status, body: await res.json() };
}

describe("vault wrap compare-and-swap on accountSalt (real DB)", () => {
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
    await ctx.deleteTestData(tenantId);
  });

  /**
   * Hold the user row FOR UPDATE, send both requests, wait until both are
   * parked on the users UPDATE (the first behind the blocker, the second
   * behind the first or the blocker), then commit the blocker.
   */
  async function raceParkedOnUpdate(
    userId: string,
    send: () => [Promise<Response>, Promise<Response>],
  ): Promise<Outcome[]> {
    const race = createRaceHelpers(ctx.su.pool);
    const blocker = await race.holdRowLock(`SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`, [userId]);
    let requests: Promise<Response>[] = [];
    try {
      requests = send();
      for (const r of requests) r.catch(() => {});
      const first = await race.waitForBackendBlockedBy(blocker.pid);
      const second = await (async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = [
            ...(await race.backendsBlockedBy(blocker.pid)),
            ...(await race.backendsBlockedBy(first)),
          ].filter((pid) => pid !== first);
          if (waiting.length > 0) return waiting[0];
          await new Promise((res) => setTimeout(res, 20));
        }
        throw new Error("second request never parked on the users row");
      })();
      for (const pid of [first, second]) {
        expect(await race.waitingQueryOf(pid)).toMatch(/^UPDATE "public"\."users"/);
      }
    } finally {
      await blocker.release();
      // On a failed setup the requests are still running; let them finish
      // before afterEach deletes the rows they write to.
      await Promise.allSettled(requests);
    }
    return Promise.all(requests.map(async (r) => outcome(await r)));
  }

  describe("POST /api/vault/change-passphrase", () => {
    it("two requests proving the same old passphrase: one rewraps, the other gets 409 with no audit row", async () => {
      const seed = await seedUserWithVerifiers(ctx, tenantId);
      mockAuth.mockResolvedValue({ user: { id: seed.userId } });
      const wraps = [newWrap(), newWrap()];

      const outcomes = await raceParkedOnUpdate(seed.userId, () => [
        changePassphrase(jsonRequest(CHANGE_URL, { currentVerifierHash: seed.passphraseVerifierHash, ...wraps[0] })),
        changePassphrase(jsonRequest(CHANGE_URL, { currentVerifierHash: seed.passphraseVerifierHash, ...wraps[1] })),
      ]);

      const winner = outcomes.findIndex((o) => o.status === 200);
      expect(outcomes.map((o) => o.status).sort()).toEqual([200, 409]);
      expect(outcomes[1 - winner].body).toEqual({ error: "VAULT_WRAP_CONFLICT" });
      expect(await storedWrap(ctx, seed.userId)).toEqual({
        accountSalt: wraps[winner].accountSalt,
        encryptedSecretKey: wraps[winner].encryptedSecretKey,
      });
      expect({
        committed: await auditCount(ctx, tenantId, seed.userId, "VAULT_PASSPHRASE_CHANGE", "committed"),
        // The loser returns before session invalidation and its completion row.
        completed: await auditCount(ctx, tenantId, seed.userId, "VAULT_PASSPHRASE_CHANGE", "completed"),
      }).toEqual({ committed: 1, completed: 1 });
    });

    it("a stale old passphrase after a committed change is refused by the verifier check, not the CAS", async () => {
      const seed = await seedUserWithVerifiers(ctx, tenantId);
      mockAuth.mockResolvedValue({ user: { id: seed.userId } });
      const wraps = [newWrap(), newWrap()];

      const first = await outcome(
        await changePassphrase(jsonRequest(CHANGE_URL, { currentVerifierHash: seed.passphraseVerifierHash, ...wraps[0] })),
      );
      const second = await outcome(
        await changePassphrase(jsonRequest(CHANGE_URL, { currentVerifierHash: seed.passphraseVerifierHash, ...wraps[1] })),
      );

      // The second request's snapshot is the committed row, whose verifier is
      // the new passphrase's, so it never reaches the CAS.
      expect([first, second]).toEqual([
        { status: 200, body: { success: true } },
        { status: 401, body: { error: "INVALID_PASSPHRASE" } },
      ]);
      expect((await storedWrap(ctx, seed.userId)).accountSalt).toBe(wraps[0].accountSalt);
      expect(await auditCount(ctx, tenantId, seed.userId, "VAULT_PASSPHRASE_CHANGE", "committed")).toBe(1);
    });
  });

  describe("POST /api/vault/recovery-key/generate", () => {
    // generate does not move the wrap it checks, so two generates do not
    // conflict, and the passphrase-checked writers it races (rotate-key,
    // change-passphrase) replace the verifier: a generate sent after one
    // commits is refused by the verifier check (401), never the CAS. The race
    // the CAS closes is a writer committing between generate's snapshot and
    // its write, so the blocker itself is that writer: it holds the row while
    // generate parks on its UPDATE, applies a rotation's (or a passphrase
    // change's) columns, and commits. Driving rotate-key itself would add
    // nothing the CAS reads: it sees only accountSalt and keyVersion.

    type Move = { accountSalt?: string; keyVersion?: number };

    async function generateBehindWriter(
      seed: Awaited<ReturnType<typeof seedUserWithVerifiers>>,
      move: Move,
    ): Promise<Outcome> {
      const race = createRaceHelpers(ctx.su.pool);
      const res = await race.parkBehind(
        `SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`,
        [seed.userId],
        () => generateRecoveryKey(jsonRequest(GENERATE_URL, generateBody(seed.passphraseVerifierHash))),
        async (blocker, parkedPid) => {
          expect(await race.waitingQueryOf(parkedPid)).toMatch(/^UPDATE "public"\."users"/);
          if (move.accountSalt === undefined && move.keyVersion === undefined) return;
          // What rotate-key commits on the users row: a new wrap and key
          // version, the recovery wrap cleared and marked invalidated.
          await blocker.query(
            `UPDATE users SET
               account_salt = COALESCE($2, account_salt),
               key_version = COALESCE($3, key_version),
               recovery_encrypted_secret_key = NULL,
               recovery_secret_key_iv = NULL,
               recovery_secret_key_auth_tag = NULL,
               recovery_hkdf_salt = NULL,
               recovery_verifier_hmac = NULL,
               recovery_key_set_at = NULL,
               recovery_key_invalidated_at = now()
             WHERE id = $1::uuid`,
            [seed.userId, move.accountSalt ?? null, move.keyVersion ?? null],
          );
        },
      );
      return outcome(res);
    }

    async function recoveryState(userId: string) {
      const r = await ctx.su.pool.query<{ wrap: string | null; invalidated: boolean }>(
        `SELECT recovery_encrypted_secret_key AS wrap,
                recovery_key_invalidated_at IS NOT NULL AS invalidated
           FROM users WHERE id = $1::uuid`,
        [userId],
      );
      return r.rows[0];
    }

    it("parked behind a writer that changes nothing it reads: stores the recovery wrap with its audit row", async () => {
      const seed = await seedUserWithVerifiers(ctx, tenantId);
      mockAuth.mockResolvedValue({ user: { id: seed.userId } });

      const result = await generateBehindWriter(seed, {});

      expect(result).toEqual({ status: 200, body: { success: true } });
      expect(await recoveryState(seed.userId)).toMatchObject({ invalidated: false });
      expect(await auditCount(ctx, tenantId, seed.userId, "RECOVERY_KEY_REGENERATED")).toBe(1);
    });

    it("a rotation committing between its snapshot and its write: 409, the rotation's state kept, no audit row", async () => {
      const seed = await seedUserWithVerifiers(ctx, tenantId);
      mockAuth.mockResolvedValue({ user: { id: seed.userId } });

      const result = await generateBehindWriter(seed, { accountSalt: hex(32), keyVersion: seed.keyVersion + 1 });

      expect(result).toEqual({ status: 409, body: { error: "VAULT_WRAP_CONFLICT" } });
      // The retired key's recovery wrap was not written and the invalidation
      // marker survives, so a later recover cannot restore the old key.
      expect(await recoveryState(seed.userId)).toEqual({ wrap: null, invalidated: true });
      expect(await auditCount(ctx, tenantId, seed.userId, "RECOVERY_KEY_REGENERATED")).toBe(0);
    });

    it("a writer moving only keyVersion is enough to refuse it", async () => {
      const seed = await seedUserWithVerifiers(ctx, tenantId);
      mockAuth.mockResolvedValue({ user: { id: seed.userId } });

      const result = await generateBehindWriter(seed, { keyVersion: seed.keyVersion + 1 });

      expect(result).toEqual({ status: 409, body: { error: "VAULT_WRAP_CONFLICT" } });
    });

    it("a writer moving only accountSalt is enough to refuse it", async () => {
      const seed = await seedUserWithVerifiers(ctx, tenantId);
      mockAuth.mockResolvedValue({ user: { id: seed.userId } });

      const result = await generateBehindWriter(seed, { accountSalt: hex(32) });

      expect(result).toEqual({ status: 409, body: { error: "VAULT_WRAP_CONFLICT" } });
    });
  });

  describe("POST /api/vault/recovery-key/recover (step: reset)", () => {
    it("two resets proving the same recovery key: one rewraps, the other gets 409 with no audit row", async () => {
      const seed = await seedUserWithVerifiers(ctx, tenantId);
      mockAuth.mockResolvedValue({ user: { id: seed.userId } });
      const bodies = [resetBody(seed.recoveryVerifierHash), resetBody(seed.recoveryVerifierHash)];

      const outcomes = await raceParkedOnUpdate(seed.userId, () => [
        recoverVault(jsonRequest(RECOVER_URL, bodies[0])),
        recoverVault(jsonRequest(RECOVER_URL, bodies[1])),
      ]);

      const winner = outcomes.findIndex((o) => o.status === 200);
      expect(outcomes.map((o) => o.status).sort()).toEqual([200, 409]);
      expect(outcomes[1 - winner].body).toEqual({ error: "VAULT_WRAP_CONFLICT" });
      expect(await storedWrap(ctx, seed.userId)).toEqual({
        accountSalt: bodies[winner].accountSalt,
        encryptedSecretKey: bodies[winner].encryptedSecretKey,
      });
      expect(await auditCount(ctx, tenantId, seed.userId, "RECOVERY_PASSPHRASE_RESET")).toBe(1);
    });

    it("a stale recovery key after a committed reset is refused by the verifier check, not the CAS", async () => {
      const seed = await seedUserWithVerifiers(ctx, tenantId);
      mockAuth.mockResolvedValue({ user: { id: seed.userId } });
      const bodies = [resetBody(seed.recoveryVerifierHash), resetBody(seed.recoveryVerifierHash)];

      const first = await outcome(await recoverVault(jsonRequest(RECOVER_URL, bodies[0])));
      const second = await outcome(await recoverVault(jsonRequest(RECOVER_URL, bodies[1])));

      // The reset rewrote the recovery verifier, so the old key no longer verifies.
      expect([first, second]).toEqual([
        { status: 200, body: { success: true } },
        { status: 401, body: { error: "INVALID_RECOVERY_KEY" } },
      ]);
      expect((await storedWrap(ctx, seed.userId)).accountSalt).toBe(bodies[0].accountSalt);
      expect(await auditCount(ctx, tenantId, seed.userId, "RECOVERY_PASSPHRASE_RESET")).toBe(1);
    });
  });
});
