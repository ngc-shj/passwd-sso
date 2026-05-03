/**
 * Integration test (real DB): vault rotation gap closure (#433).
 *
 * Validates the cross-table atomicity properties that mock-based unit tests
 * cannot exercise — Postgres FK / RLS / CHECK constraints, real updateMany
 * filter behavior, and the actual `data:` payload landing in the rows.
 *
 * Scope:
 *   - markGrantsStaleForOwner under live DB:
 *       (1) STALE flip + ownerEphemeralPublicKey null for IDLE / REQUESTED /
 *           ACTIVATED grants (#433/S1+S2)
 *       (2) ACCEPTED grants are NOT touched (negative case for the
 *           STALE_ELIGIBLE filter)
 *       (3) wrapping ciphertext + keyVersion + wrapVersion are RETAINED
 *           (forensic trail per S2 minimum-clear)
 *       (4) keyVersion < newKeyVersion guard works (older versions become
 *           STALE; newer / equal are skipped)
 *   - invalidateUserSessions under live DB: rotation reason revokes all
 *     six user-bound token classes (#433/S-N2)
 *
 * Out of scope (covered by route-level unit tests):
 *   - The full POST /api/vault/rotate-key handler (auth + tenant context +
 *     advisory lock + entry re-encryption flow). Invoking the route from a
 *     test runs into the proxy / session / RLS context wiring — the
 *     building blocks below are the load-bearing security parts.
 *
 * Run: docker compose up -d db && npm run test:integration -- vault-rotate-key-gaps
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { markGrantsStaleForOwner } from "@/lib/emergency-access/emergency-access-server";
import { invalidateUserSessions } from "@/lib/auth/session/user-session-invalidation";
import { EA_STATUS } from "@/lib/constants";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";

// All seeded grants share these placeholder wrapping values; the assertions
// only care about which are nulled vs retained.
const WRAPPING_PLACEHOLDER = {
  encryptedSecretKey: "esk-placeholder",
  secretKeyIv: "a".repeat(24),
  secretKeyAuthTag: "b".repeat(32),
  hkdfSalt: "c".repeat(64),
  ownerEphemeralPublicKey: "ephemeral-pubkey-placeholder",
  granteePublicKey: "grantee-pubkey-placeholder",
};

interface SeededGrant {
  id: string;
  status: keyof typeof EA_STATUS;
  keyVersion: number | null;
}

describe("vault rotation gaps — markGrantsStaleForOwner (real DB / #433/S1+S2)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let ownerId: string;
  let granteeId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    ownerId = await ctx.createUser(tenantId);
    granteeId = await ctx.createUser(tenantId);
  });

  async function seedGrant(opts: SeededGrant): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO emergency_access_grants (
           id, tenant_id, owner_id, grantee_id, grantee_email,
           status, wait_days, token_hash, token_expires_at,
           encrypted_secret_key, secret_key_iv, secret_key_auth_tag,
           hkdf_salt, owner_ephemeral_public_key, grantee_public_key,
           wrap_version, key_version, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
           $6::"EmergencyAccessStatus", 7, $7, now() + interval '30 days',
           $8, $9, $10, $11, $12, $13,
           1, $14, now(), now()
         )`,
        opts.id,
        tenantId,
        ownerId,
        granteeId,
        `grantee-${opts.id.slice(0, 6)}@example.com`,
        opts.status,
        randomBytes(32).toString("hex"),
        WRAPPING_PLACEHOLDER.encryptedSecretKey,
        WRAPPING_PLACEHOLDER.secretKeyIv,
        WRAPPING_PLACEHOLDER.secretKeyAuthTag,
        WRAPPING_PLACEHOLDER.hkdfSalt,
        WRAPPING_PLACEHOLDER.ownerEphemeralPublicKey,
        WRAPPING_PLACEHOLDER.granteePublicKey,
        opts.keyVersion,
      );
    });
  }

  async function fetchGrant(id: string): Promise<{
    status: string;
    encrypted_secret_key: string | null;
    secret_key_iv: string | null;
    secret_key_auth_tag: string | null;
    hkdf_salt: string | null;
    owner_ephemeral_public_key: string | null;
    key_version: number | null;
    wrap_version: number;
  }> {
    const r = await ctx.su.pool.query(
      `SELECT status, encrypted_secret_key, secret_key_iv, secret_key_auth_tag,
              hkdf_salt, owner_ephemeral_public_key, key_version, wrap_version
       FROM emergency_access_grants WHERE id = $1::uuid`,
      [id],
    );
    if (r.rowCount === 0) throw new Error(`grant ${id} not found`);
    return r.rows[0];
  }

  it("flips IDLE/REQUESTED/ACTIVATED to STALE; nulls ownerEphemeralPublicKey; retains wrapping ciphertext + keyVersion + wrapVersion", async () => {
    const idleId = randomUUID();
    const requestedId = randomUUID();
    const activatedId = randomUUID();

    await seedGrant({ id: idleId, status: "IDLE", keyVersion: 1 });
    await seedGrant({ id: requestedId, status: "REQUESTED", keyVersion: 1 });
    await seedGrant({ id: activatedId, status: "ACTIVATED", keyVersion: 1 });

    // markGrantsStaleForOwner runs inside a tx so the helper inherits its
    // bypass_rls context — production callers wrap in withUserTenantRls; for
    // direct test invocation we use the test superuser's bypass GUC.
    const cleared = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return markGrantsStaleForOwner(ownerId, 2, tx);
    });
    expect(cleared).toBe(3);

    for (const id of [idleId, requestedId, activatedId]) {
      const g = await fetchGrant(id);
      // STALE flip
      expect(g.status).toBe("STALE");
      // ECDH unwrap killer — ephemeral pubkey nulled
      expect(g.owner_ephemeral_public_key).toBeNull();
      // Forensic trail RETAINED — neither ciphertext nor version-tagging
      // columns are touched (#433/S2 minimum-clear)
      expect(g.encrypted_secret_key).toBe(WRAPPING_PLACEHOLDER.encryptedSecretKey);
      expect(g.secret_key_iv).toBe(WRAPPING_PLACEHOLDER.secretKeyIv);
      expect(g.secret_key_auth_tag).toBe(WRAPPING_PLACEHOLDER.secretKeyAuthTag);
      expect(g.hkdf_salt).toBe(WRAPPING_PLACEHOLDER.hkdfSalt);
      expect(g.key_version).toBe(1);
      expect(g.wrap_version).toBe(1);
    }
  });

  it("does NOT touch ACCEPTED grants (pre-escrow state — STALE_ELIGIBLE excludes them)", async () => {
    const acceptedId = randomUUID();
    await seedGrant({ id: acceptedId, status: "ACCEPTED", keyVersion: 1 });

    const cleared = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return markGrantsStaleForOwner(ownerId, 2, tx);
    });
    expect(cleared).toBe(0);

    const g = await fetchGrant(acceptedId);
    expect(g.status).toBe("ACCEPTED");
    expect(g.owner_ephemeral_public_key).toBe(WRAPPING_PLACEHOLDER.ownerEphemeralPublicKey);
  });

  it("skips grants whose keyVersion is already >= newKeyVersion", async () => {
    const sameVersion = randomUUID();
    const newerVersion = randomUUID();
    await seedGrant({ id: sameVersion, status: "IDLE", keyVersion: 5 });
    await seedGrant({ id: newerVersion, status: "IDLE", keyVersion: 6 });

    const cleared = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return markGrantsStaleForOwner(ownerId, 5, tx);
    });
    expect(cleared).toBe(0);

    expect((await fetchGrant(sameVersion)).status).toBe("IDLE");
    expect((await fetchGrant(newerVersion)).status).toBe("IDLE");
  });

  it("treats keyVersion = NULL as eligible (legacy grants from before the column existed)", async () => {
    const nullVersion = randomUUID();
    await seedGrant({ id: nullVersion, status: "IDLE", keyVersion: null });

    const cleared = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return markGrantsStaleForOwner(ownerId, 1, tx);
    });
    expect(cleared).toBe(1);
    expect((await fetchGrant(nullVersion)).status).toBe("STALE");
  });
});

describe("vault rotation gaps — invalidateUserSessions(KEY_ROTATION) (real DB / #433/S-N2)", () => {
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
  });

  it("revokes all six user-bound token classes when called with KEY_ROTATION reason", async () => {
    // Seed at least one row in each class. ApiKey + ExtensionToken require a
    // session row; create one too. Use bypass RLS for setup.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO sessions (id, user_id, tenant_id, session_token, expires)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now() + interval '7 days')`,
        randomUUID(),
        userId,
        tenantId,
        randomBytes(32).toString("hex"),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO extension_tokens (id, user_id, tenant_id, token_hash, scope, family_id, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'extension', $5::uuid, now() + interval '30 days', now())`,
        randomUUID(),
        userId,
        tenantId,
        randomBytes(32).toString("hex"),
        randomUUID(),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO api_keys (id, user_id, tenant_id, prefix, name, token_hash, scope, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'api_test', 'test', $4, 'passwords:read', now() + interval '30 days', now())`,
        randomUUID(),
        userId,
        tenantId,
        randomBytes(32).toString("hex"),
      );
      // mcp_clients FK is required by mcp_access_tokens.client_id.
      const clientId = randomUUID();
      const clientStr = `test-${clientId.slice(0, 8)}`;
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, allowed_scopes, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'credentials:list', now(), now())`,
        clientId,
        tenantId,
        clientStr,
        randomBytes(32).toString("hex"),
        `test-mcp-client-${clientId.slice(0, 8)}`,
      );
      const accessTokenId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_access_tokens (id, user_id, tenant_id, client_id, token_hash, scope, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'credentials:list', now() + interval '1 hour', now())`,
        accessTokenId,
        userId,
        tenantId,
        clientId,
        randomBytes(32).toString("hex"),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_refresh_tokens (id, user_id, tenant_id, client_id, family_id, access_token_id, token_hash, scope, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, 'credentials:list', now() + interval '7 days', now())`,
        randomUUID(),
        userId,
        tenantId,
        clientId,
        randomUUID(),
        accessTokenId,
        randomBytes(32).toString("hex"),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO delegation_sessions (id, user_id, tenant_id, mcp_token_id, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now() + interval '5 minutes', now())`,
        randomUUID(),
        userId,
        tenantId,
        accessTokenId,
      );
    });

    const result = await invalidateUserSessions(userId, {
      tenantId,
      reason: "KEY_ROTATION",
    });

    // The result counts what we just seeded — each class non-zero.
    expect(result.sessions).toBe(1);
    expect(result.extensionTokens).toBe(1);
    expect(result.apiKeys).toBe(1);
    expect(result.mcpAccessTokens).toBe(1);
    expect(result.mcpRefreshTokens).toBe(1);
    expect(result.delegationSessions).toBe(1);

    // Post-state: verify revocation actually landed in the rows.
    const survivingSessions = await ctx.su.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(survivingSessions.rows[0].count).toBe("0"); // sessions are deleted, not soft-revoked

    const tokenClasses = [
      "extension_tokens",
      "api_keys",
      "mcp_access_tokens",
      "mcp_refresh_tokens",
      "delegation_sessions",
    ];
    for (const table of tokenClasses) {
      const r = await ctx.su.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${table}
         WHERE user_id = $1::uuid AND revoked_at IS NULL`,
        [userId],
      );
      expect(r.rows[0].count).toBe("0");
    }
  });
});
