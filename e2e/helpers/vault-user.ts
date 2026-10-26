/**
 * Seed a vault-ready user (User + VaultKey + Session) whose vault unlocks with
 * TEST_PASSPHRASE. Shared by global-setup (the fixed TEST_USERS) and specs
 * that seed a user of their own per attempt.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setupVaultCrypto } from "./crypto";
import { E2E_TENANT, TEST_PASSPHRASE, seedSession, seedUser, seedVaultKey } from "./db";

export async function seedVaultReadyUser(
  user: { id: string; email: string; name: string },
  pepper: string,
  tenantId: string = E2E_TENANT.id
): Promise<{ sessionToken: string; encryptionKey: Buffer }> {
  const vault = setupVaultCrypto(TEST_PASSPHRASE, pepper);

  const serverSalt = randomBytes(32).toString("hex");
  const serverHash = createHash("sha256")
    .update(vault.authHash + serverSalt)
    .digest("hex");

  await seedUser({
    ...user,
    tenantId,
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

  await seedVaultKey(user.id, vault.verificationArtifact, tenantId);

  // Same shape Auth.js mints (randomUUID): the session-cookie reader refuses
  // values outside that alphabet (src/lib/auth/session/session-cookie.ts).
  const sessionToken = randomUUID();
  await seedSession(user.id, sessionToken, undefined, tenantId);

  return { sessionToken, encryptionKey: vault.encryptionKey };
}
