/**
 * Playwright global setup — seed test users into the database.
 *
 * Creates twelve users:
 *  1. "vault-ready"      — vault fully set up, for general unlock/CRUD/lock tests
 *  2. "fresh"            — no vault setup, for setup wizard tests
 *  3. "lockout"          — vault set up, dedicated to lockout test (destructive)
 *  4. "reset"            — vault set up, dedicated to vault-reset test (destructive)
 *  5. "resetValidation"  — vault set up, dedicated to vault-reset validation (non-destructive)
 *  6. "teamOwner"        — vault set up, team owner for team tests
 *  7. "teamMember"       — vault set up, team member for invitation tests
 *  8. "eaGrantor"        — vault set up, emergency access grantor
 *  9. "eaGrantee"        — vault set up, emergency access grantee
 * 10. "tenantAdmin"      — vault set up, tenant admin (ADMIN role)
 * 11. "passphraseChange" — vault set up, dedicated to passphrase change test (destructive)
 * 12. "keyRotation"      — vault set up, dedicated to key rotation test (destructive)
 *
 * Session tokens are written to .auth-state.json for test consumption.
 */
import { config } from "dotenv";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Redis from "ioredis";

// Load .env.local so DATABASE_URL / VERIFIER_PEPPER_KEY are available
config({ path: join(__dirname, "..", ".env.local") });
import { setupVaultCrypto } from "./helpers/crypto";
import {
  assertTestDatabase,
  cleanup,
  closePool,
  seedTenant,
  seedTenantMember,
  seedUser,
  seedSession,
  seedVaultKey,
  TEST_USERS,
  TEST_PASSPHRASE,
} from "./helpers/db";
import { seedPasswordEntry } from "./helpers/password-entry";
import { seedShareLink } from "./helpers/share-link";
import { seedTeam, seedTeamMember } from "./helpers/team";
import { seedEmergencyGrant } from "./helpers/emergency-access";

const AUTH_STATE_PATH = join(__dirname, ".auth-state.json");

/** Seed a vault-ready user (User + VaultKey + Session). */
async function seedVaultReadyUser(
  user: { id: string; email: string; name: string },
  pepper: string
): Promise<{ sessionToken: string; encryptionKey: Buffer }> {
  const vault = setupVaultCrypto(TEST_PASSPHRASE, pepper);

  const serverSalt = randomBytes(32).toString("hex");
  const serverHash = createHash("sha256")
    .update(vault.authHash + serverSalt)
    .digest("hex");

  await seedUser({
    ...user,
    vaultFields: {
      accountSalt: vault.accountSalt,
      encryptedSecretKey: vault.encryptedSecretKey,
      secretKeyIv: vault.secretKeyIv,
      secretKeyAuthTag: vault.secretKeyAuthTag,
      masterPasswordServerHash: serverHash,
      masterPasswordServerSalt: serverSalt,
      passphraseVerifierHmac: vault.verifierHmac,
      keyVersion: 1,
      ecdhPublicKey: vault.ecdhPublicKey,
      encryptedEcdhPrivateKey: vault.encryptedEcdhPrivateKey,
      ecdhPrivateKeyIv: vault.ecdhPrivateKeyIv,
      ecdhPrivateKeyAuthTag: vault.ecdhPrivateKeyAuthTag,
    },
  });

  await seedVaultKey(user.id, vault.verificationArtifact);

  const sessionToken = `e2e-token-${randomBytes(16).toString("hex")}`;
  await seedSession(user.id, sessionToken);

  return { sessionToken, encryptionKey: vault.encryptionKey };
}

/** Clear Redis rate limit keys for all E2E test users to avoid cooldown failures. */
async function clearRateLimits(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  const redis = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false });
  try {
    await redis.connect();
    const userIds = Object.values(TEST_USERS).map((u) => u.id);
    const keys = [
      ...userIds.map((id) => `rl:watchtower:start:${id}`),
      ...userIds.map((id) => `rl:watchtower:hibp:${id}`),
      ...userIds.map((id) => `rl:ea_create:${id}`),
      ...userIds.map((id) => `rl:vault_rotate:${id}`),
      ...userIds.map((id) => `rl:vault_change_pass:${id}`),
      ...userIds.map((id) => `rl:vault_unlock:${id}`),
      ...userIds.map((id) => `rl:vault_unlock_data:${id}`),
      ...userIds.map((id) => `rl:vault_setup:${id}`),
    ];
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // Redis unavailable — rate limits will use in-memory fallback
  } finally {
    await redis.quit().catch(() => null);
  }
}

export default async function globalSetup(): Promise<void> {
  // Safety guards
  assertTestDatabase();

  const pepper = process.env.VERIFIER_PEPPER_KEY ?? "";
  if (!pepper) {
    throw new Error("VERIFIER_PEPPER_KEY is required for E2E tests.");
  }

  // Clear Redis rate limits from previous runs (e.g. watchtower scan cooldown)
  await clearRateLimits();

  // Clean up any leftover data from previous runs
  await cleanup();

  // ── Seed tenant first (all users depend on it) ────────────────
  await seedTenant();

  // ── Vault-ready users ─────────────────────────────────────────
  const { sessionToken: vaultReadyToken, encryptionKey: vaultReadyKey } =
    await seedVaultReadyUser(TEST_USERS.vaultReady, pepper);
  const { sessionToken: lockoutToken } = await seedVaultReadyUser(TEST_USERS.lockout, pepper);
  const { sessionToken: resetToken } = await seedVaultReadyUser(TEST_USERS.reset, pepper);
  const { sessionToken: resetValidationToken } = await seedVaultReadyUser(TEST_USERS.resetValidation, pepper);
  const { sessionToken: teamOwnerToken } = await seedVaultReadyUser(TEST_USERS.teamOwner, pepper);
  const { sessionToken: teamMemberToken } = await seedVaultReadyUser(TEST_USERS.teamMember, pepper);
  const { sessionToken: eaGrantorToken } = await seedVaultReadyUser(TEST_USERS.eaGrantor, pepper);
  const { sessionToken: eaGranteeToken } = await seedVaultReadyUser(TEST_USERS.eaGrantee, pepper);
  const { sessionToken: tenantAdminToken } = await seedVaultReadyUser(TEST_USERS.tenantAdmin, pepper);
  const { sessionToken: passphraseChangeToken } = await seedVaultReadyUser(TEST_USERS.passphraseChange, pepper);
  const { sessionToken: keyRotationToken } = await seedVaultReadyUser(TEST_USERS.keyRotation, pepper);

  // tenantAdmin requires an explicit ADMIN role in the tenant
  await seedTenantMember(TEST_USERS.tenantAdmin.id, "ADMIN");
  // teamOwner needs ADMIN role to create teams via the teams page UI
  await seedTenantMember(TEST_USERS.teamOwner.id, "ADMIN");

  // ── Fresh user (no vault) ─────────────────────────────────────
  await seedUser(TEST_USERS.fresh);
  const freshToken = `e2e-token-${randomBytes(16).toString("hex")}`;
  await seedSession(TEST_USERS.fresh.id, freshToken);

  // ── Team: pre-seed teamOwner as OWNER and teamMember as MEMBER ────
  const E2E_TEAM_ID = "00000000-0000-4000-e2e0-000000e2e000";
  await seedTeam({
    id: E2E_TEAM_ID,
    name: "E2E Pre-seeded Team",
    slug: "e2e-preseeded-team",
    createdById: TEST_USERS.teamOwner.id,
  });
  await seedTeamMember({
    teamId: E2E_TEAM_ID,
    userId: TEST_USERS.teamOwner.id,
    role: "OWNER",
  });
  await seedTeamMember({
    teamId: E2E_TEAM_ID,
    userId: TEST_USERS.teamMember.id,
    role: "MEMBER",
  });

  // ── Emergency access: pre-seed grant at IDLE status ───────────
  const E2E_EA_GRANT_ID = "00000000-0000-4000-e2e0-00000ea00001";
  await seedEmergencyGrant({
    id: E2E_EA_GRANT_ID,
    ownerId: TEST_USERS.eaGrantor.id,
    granteeId: TEST_USERS.eaGrantee.id,
    granteeEmail: TEST_USERS.eaGrantee.email,
    status: "IDLE",
    waitDays: 3,
  });

  // ── Password entry + share link for vaultReady user ───────────
  const E2E_ENTRY_ID = "00000000-0000-4000-e2e0-000000e2e001";
  await seedPasswordEntry({
    id: E2E_ENTRY_ID,
    userId: TEST_USERS.vaultReady.id,
    title: "E2E Seeded Entry",
    encryptionKey: vaultReadyKey,
  });
  const shareLinkToken = await seedShareLink({
    createdById: TEST_USERS.vaultReady.id,
    entryId: E2E_ENTRY_ID,
    title: "E2E Seeded Entry",
  });

  // Write auth state for tests
  const authState = {
    vaultReady: {
      ...TEST_USERS.vaultReady,
      sessionToken: vaultReadyToken,
      passphrase: TEST_PASSPHRASE,
    },
    fresh: {
      ...TEST_USERS.fresh,
      sessionToken: freshToken,
    },
    lockout: {
      ...TEST_USERS.lockout,
      sessionToken: lockoutToken,
      passphrase: TEST_PASSPHRASE,
    },
    reset: {
      ...TEST_USERS.reset,
      sessionToken: resetToken,
      passphrase: TEST_PASSPHRASE,
    },
    resetValidation: {
      ...TEST_USERS.resetValidation,
      sessionToken: resetValidationToken,
      passphrase: TEST_PASSPHRASE,
    },
    teamOwner: {
      ...TEST_USERS.teamOwner,
      sessionToken: teamOwnerToken,
      passphrase: TEST_PASSPHRASE,
    },
    teamMember: {
      ...TEST_USERS.teamMember,
      sessionToken: teamMemberToken,
      passphrase: TEST_PASSPHRASE,
    },
    eaGrantor: {
      ...TEST_USERS.eaGrantor,
      sessionToken: eaGrantorToken,
      passphrase: TEST_PASSPHRASE,
    },
    eaGrantee: {
      ...TEST_USERS.eaGrantee,
      sessionToken: eaGranteeToken,
      passphrase: TEST_PASSPHRASE,
    },
    tenantAdmin: {
      ...TEST_USERS.tenantAdmin,
      sessionToken: tenantAdminToken,
      passphrase: TEST_PASSPHRASE,
    },
    passphraseChange: {
      ...TEST_USERS.passphraseChange,
      sessionToken: passphraseChangeToken,
      passphrase: TEST_PASSPHRASE,
    },
    keyRotation: {
      ...TEST_USERS.keyRotation,
      sessionToken: keyRotationToken,
      passphrase: TEST_PASSPHRASE,
    },
    shareLinkToken,
  };

  writeFileSync(AUTH_STATE_PATH, JSON.stringify(authState, null, 2), { mode: 0o600 });

  await closePool();

  console.log("[E2E Setup] Test users seeded successfully (12 users).");
}
