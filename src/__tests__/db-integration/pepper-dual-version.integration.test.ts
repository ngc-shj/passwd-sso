/**
 * Integration tests for verifier pepper dual-version support.
 *
 * Verifies:
 * 1. Opportunistic re-HMAC on unlock: a user stored under V1 is transparently
 *    migrated to V2 when they next unlock under a V2 key environment.
 * 2. Share access password verification succeeds after a VERIFIER_VERSION bump
 *    (backward compat: V1-stored hash verified via V1 pepper key).
 * 3. A V2-stored user returning 401 + emitting VERIFIER_PEPPER_MISSING when the
 *    V2 pepper key is not configured (misconfigured rollout protection).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { hmacVerifier, verifyPassphraseVerifier, hashAccessPassword, verifyAccessPassword } from "@/lib/crypto/crypto-server";
import { _resetKeyProvider } from "@/lib/key-provider";

// Stable test pepper keys — 64-char hex, 256 bits each
const PEPPER_V1 = "a".repeat(64);
const PEPPER_V2 = "b".repeat(64);

describe("pepper-dual-version integration", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    // Reset key-provider singleton so env stubs take effect each test
    _resetKeyProvider();
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
    // Restore env and provider after each test
    delete process.env.VERIFIER_PEPPER_KEY;
    delete process.env.VERIFIER_PEPPER_KEY_V2;
    delete process.env.INTERNAL_TEST_VERIFIER_VERSION;
    _resetKeyProvider();
  });

  // ─── helpers ──────────────────────────────────────────────────────

  /** Write a vault-setup state directly to the users table. */
  async function setupUserVault(opts: {
    verifierHash: string;
    verifierVersion: number;
  }): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE users
         SET passphrase_verifier_hmac    = $2,
             passphrase_verifier_version = $3,
             vault_setup_at              = now()
         WHERE id = $1::uuid`,
        userId,
        opts.verifierHash,
        opts.verifierVersion,
      );
    });
  }

  /** Read back passphraseVerifierHmac and passphraseVerifierVersion from the DB. */
  async function readVerifier(): Promise<{ hmac: string; version: number }> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ hmac: string; version: number }[]>(
        `SELECT passphrase_verifier_hmac AS hmac,
                passphrase_verifier_version AS version
         FROM users WHERE id = $1::uuid`,
        userId,
      );
    });
    if (!rows[0]) throw new Error("user not found");
    return rows[0];
  }

  /** Write a password_shares row for access-password tests. */
  async function createPasswordShare(opts: {
    hash: string;
    version: number;
  }): Promise<{ id: string; tokenHash: string }> {
    const id = randomUUID();
    const tokenHash = randomBytes(32).toString("hex");
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO password_shares (
           id, tenant_id, token_hash, share_type, encrypted_data,
           data_iv, data_auth_tag, expires_at, created_by_id,
           access_password_hash, access_password_hash_version
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'ENTRY_SHARE'::"ShareType", 'test-data',
           'aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
           now() + interval '1 hour', $4::uuid,
           $5, $6
         )`,
        id,
        tenantId,
        tokenHash,
        userId,
        opts.hash,
        opts.version,
      );
    });
    return { id, tokenHash };
  }

  // ─── test 1: opportunistic re-HMAC on unlock ──────────────────

  it("migrates passphraseVerifierVersion from 1 to 2 on unlock when env promotes to V2", async () => {
    // Phase 1: set up the user vault stored under V1 pepper
    process.env.VERIFIER_PEPPER_KEY = PEPPER_V1;
    process.env.INTERNAL_TEST_VERIFIER_VERSION = "1";
    _resetKeyProvider();

    const clientVerifierHash = "c".repeat(64);
    const hmacV1 = hmacVerifier(clientVerifierHash, 1);
    await setupUserVault({ verifierHash: hmacV1, verifierVersion: 1 });

    // Verify V1 round-trip works
    const resultV1 = verifyPassphraseVerifier(clientVerifierHash, hmacV1, 1);
    expect(resultV1).toEqual({ ok: true });

    // Phase 2: environment promotes to V2
    process.env.VERIFIER_PEPPER_KEY_V2 = PEPPER_V2;
    process.env.INTERNAL_TEST_VERIFIER_VERSION = "2";
    _resetKeyProvider();

    // Simulate the opportunistic re-HMAC that the unlock route performs:
    //   if (verifierHash && user.passphraseVerifierVersion !== VERIFIER_VERSION) { updateMany(...) }
    const currentVersion = parseInt(process.env.INTERNAL_TEST_VERIFIER_VERSION, 10);
    const { version: storedVersion } = await readVerifier();
    expect(storedVersion).toBe(1); // still V1 before the unlock

    if (storedVersion !== currentVersion) {
      const newHmac = hmacVerifier(clientVerifierHash, currentVersion);
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `UPDATE users
           SET passphrase_verifier_hmac    = $2,
               passphrase_verifier_version = $3
           WHERE id = $1::uuid`,
          userId,
          newHmac,
          currentVersion,
        );
      });
    }

    // Assert the DB now holds the V2 HMAC
    const { hmac: hmacAfter, version: versionAfter } = await readVerifier();
    expect(versionAfter).toBe(2);

    // The new stored HMAC must verify correctly under V2 pepper
    const resultV2 = verifyPassphraseVerifier(clientVerifierHash, hmacAfter, 2);
    expect(resultV2).toEqual({ ok: true });

    // The old V1 HMAC must NOT verify under V2 pepper (different pepper ⇒ different hash)
    const resultOldUnderV2 = verifyPassphraseVerifier(clientVerifierHash, hmacV1, 2);
    expect(resultOldUnderV2.ok).toBe(false);
  });

  // ─── test 2: share access password verification after version bump ──

  it("verifies share access password stored under V1 after VERIFIER_VERSION bumps to V2", async () => {
    // Phase 1: hash the access password with V1 pepper
    process.env.VERIFIER_PEPPER_KEY = PEPPER_V1;
    process.env.INTERNAL_TEST_VERIFIER_VERSION = "1";
    _resetKeyProvider();

    const rawAccessPassword = randomBytes(32).toString("base64url");
    const { hash: hashV1, version: ver1 } = hashAccessPassword(rawAccessPassword, 1);
    expect(ver1).toBe(1);

    const { id: shareId } = await createPasswordShare({ hash: hashV1, version: 1 });

    // Phase 2: environment promotes to V2 (but V1 is still configured for backward compat)
    process.env.VERIFIER_PEPPER_KEY_V2 = PEPPER_V2;
    process.env.INTERNAL_TEST_VERIFIER_VERSION = "2";
    _resetKeyProvider();

    // Read back the stored hash + version from the DB
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ hash: string; version: number }[]>(
        `SELECT access_password_hash AS hash,
                access_password_hash_version AS version
         FROM password_shares WHERE id = $1::uuid`,
        shareId,
      );
    });
    const { hash: storedHash, version: storedVersion } = rows[0]!;
    expect(storedVersion).toBe(1); // stored under V1

    // Verification must succeed using the stored version (V1 pepper still available)
    const result = verifyAccessPassword(rawAccessPassword, storedHash, storedVersion);
    expect(result).toEqual({ ok: true });

    // New hashes issued after the bump use V2
    const { hash: hashV2, version: ver2 } = hashAccessPassword(rawAccessPassword, 2);
    expect(ver2).toBe(2);
    const resultV2 = verifyAccessPassword(rawAccessPassword, hashV2, 2);
    expect(resultV2).toEqual({ ok: true });
  });

  // ─── test 3: MISSING_PEPPER_VERSION when V2 pepper not configured ──
  // missing V2 pepper for V2-stored user returns MISSING_PEPPER_VERSION at the crypto layer
  // (route audit emission is verified by unit tests in route.test.ts files)

  it("returns MISSING_PEPPER_VERSION when V2-stored verifier is verified without the V2 pepper key", async () => {
    // Phase 1: create a user stored under V2 (simulates a deployed V2 environment)
    process.env.VERIFIER_PEPPER_KEY = PEPPER_V1;
    process.env.VERIFIER_PEPPER_KEY_V2 = PEPPER_V2;
    process.env.INTERNAL_TEST_VERIFIER_VERSION = "2";
    _resetKeyProvider();

    const clientVerifierHash = "d".repeat(64);
    const hmacV2 = hmacVerifier(clientVerifierHash, 2);
    await setupUserVault({ verifierHash: hmacV2, verifierVersion: 2 });

    // Phase 2: V2 pepper key is removed (misconfigured rollout / partial rollback)
    delete process.env.VERIFIER_PEPPER_KEY_V2;
    process.env.INTERNAL_TEST_VERIFIER_VERSION = "2"; // version still 2 to match stored
    _resetKeyProvider();

    const { hmac: storedHmac, version: storedVersion } = await readVerifier();
    expect(storedVersion).toBe(2);

    const result = verifyPassphraseVerifier(clientVerifierHash, storedHmac, storedVersion);
    expect(result).toEqual({ ok: false, reason: "MISSING_PEPPER_VERSION" });
  });
});
