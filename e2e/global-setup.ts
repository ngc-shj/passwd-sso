/**
 * Playwright global setup — seed test users into the database.
 *
 * Creates two users:
 * 1. "vault-ready" — vault fully set up, ready for unlock tests
 * 2. "fresh" — no vault setup, for setup wizard tests
 *
 * Session tokens are written to .auth-state.json for test consumption.
 */
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

export default async function globalSetup(): Promise<void> {
  // Safety guards
  assertTestDatabase();

  const pepper = process.env.VERIFIER_PEPPER_KEY ?? "";
  if (!pepper) {
    throw new Error("VERIFIER_PEPPER_KEY is required for E2E tests.");
  }

  // Clean up any leftover data from previous runs
  await cleanup();

  // ── Vault-ready user ────────────────────────────────────────
  const vault = setupVaultCrypto(TEST_PASSPHRASE, pepper);

  // Server-side hash: SHA-256(authHash + serverSalt)
  const serverSalt = randomBytes(32).toString("hex");
  const serverHash = createHash("sha256")
    .update(vault.authHash + serverSalt)
    .digest("hex");

  await seedUser({
    ...TEST_USERS.vaultReady,
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

  await seedVaultKey(TEST_USERS.vaultReady.id, vault.verificationArtifact);

  // ── Fresh user (no vault) ──────────────────────────────────
  await seedUser(TEST_USERS.fresh);

  // ── Sessions ───────────────────────────────────────────────
  const vaultReadyToken = `e2e-token-${randomBytes(16).toString("hex")}`;
  const freshToken = `e2e-token-${randomBytes(16).toString("hex")}`;

  await seedSession(TEST_USERS.vaultReady.id, vaultReadyToken);
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
  };

  writeFileSync(AUTH_STATE_PATH, JSON.stringify(authState, null, 2));

  await closePool();

  // Verify pool is properly connected
  console.log("[E2E Setup] Test users seeded successfully.");
}
