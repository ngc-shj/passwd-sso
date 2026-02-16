/**
 * Playwright global setup — seed test users into the database.
 *
 * Creates four users:
 * 1. "vault-ready" — vault fully set up, for general unlock/CRUD/lock tests
 * 2. "fresh"       — no vault setup, for setup wizard tests
 * 3. "lockout"     — vault set up, dedicated to lockout test (destructive)
 * 4. "reset"       — vault set up, dedicated to vault-reset test (destructive)
 *
 * Session tokens are written to .auth-state.json for test consumption.
 */
import { config } from "dotenv";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Load .env.local so DATABASE_URL / VERIFIER_PEPPER_KEY are available
config({ path: join(__dirname, "..", ".env.local") });
import { setupVaultCrypto } from "./helpers/crypto";
import {
  assertTestDatabase,
  cleanup,
  closePool,
  seedUser,
  seedSession,
  seedVaultKey,
  TEST_USERS,
  TEST_PASSPHRASE,
} from "./helpers/db";

const AUTH_STATE_PATH = join(__dirname, ".auth-state.json");

/** Seed a vault-ready user (User + VaultKey + Session). */
async function seedVaultReadyUser(
  user: { id: string; email: string; name: string },
  pepper: string
): Promise<string> {
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
    },
  });

  await seedVaultKey(user.id, vault.verificationArtifact);

  const token = `e2e-token-${randomBytes(16).toString("hex")}`;
  await seedSession(user.id, token);

  return token;
}

export default async function globalSetup(): Promise<void> {
  // Safety guards
  assertTestDatabase();

  const pepper = process.env.VERIFIER_PEPPER_KEY ?? "";
  if (!pepper) {
    throw new Error("VERIFIER_PEPPER_KEY is required for E2E tests.");
  }

  // Clean up any leftover data from previous runs
  await cleanup();

  // ── Vault-ready users (3: general, lockout, reset) ────────────
  const vaultReadyToken = await seedVaultReadyUser(TEST_USERS.vaultReady, pepper);
  const lockoutToken = await seedVaultReadyUser(TEST_USERS.lockout, pepper);
  const resetToken = await seedVaultReadyUser(TEST_USERS.reset, pepper);

  // ── Fresh user (no vault) ─────────────────────────────────────
  await seedUser(TEST_USERS.fresh);
  const freshToken = `e2e-token-${randomBytes(16).toString("hex")}`;
  await seedSession(TEST_USERS.fresh.id, freshToken);

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
  };

  writeFileSync(AUTH_STATE_PATH, JSON.stringify(authState, null, 2));

  await closePool();

  console.log("[E2E Setup] Test users seeded successfully (4 users).");
}
