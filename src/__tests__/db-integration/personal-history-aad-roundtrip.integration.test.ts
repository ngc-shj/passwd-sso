/**
 * Integration test (real DB + real Web Crypto): personal entry history blob
 * decrypts with the ENTRY AAD (PV "blob"), not a history-specific scope.
 *
 * This is the boundary round-trip test that the original unit test could not
 * be (it mocks decryptData + the AAD builders). It seals a blob with the real
 * `buildPersonalEntryAAD(userId, entryId, "blob")` AAD via real AES-256-GCM,
 * stores it as a PasswordEntryHistory row (mirroring the server's verbatim
 * snapshot at src/app/api/passwords/[id]/route.ts), reads it back, and decrypts
 * with the same entry AAD. Regression guard for the AAD-scope-mismatch bug
 * (PV-snapshot vs PH-decrypt) fixed in personal-history-aad-mismatch.
 *
 * Run: docker compose up -d db && npm run test:integration -- personal-history-aad-roundtrip
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { encryptData, decryptData } from "@/lib/crypto/crypto-client";
import { createTestContext, type TestContext } from "./helpers";

async function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

describe("personal history AAD round-trip (real crypto + real DB)", () => {
  let ctx: TestContext;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    for (const t of tenantIds.splice(0)) {
      await ctx.deleteTestData(t);
    }
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("history blob sealed as a verbatim entry-blob snapshot decrypts with the entry AAD", async () => {
    const tenantId = await ctx.createTenant();
    tenantIds.push(tenantId);
    const userId = await ctx.createUser(tenantId);
    const entryId = randomUUID();
    const historyId = randomUUID();
    const key = await generateVaultKey();

    const payload = JSON.stringify({
      title: "Bank",
      username: "alice",
      password: "s3cret-原文",
    });
    const overviewPayload = JSON.stringify({ title: "Bank", username: "alice" });

    // Producer side: client encrypts the entry blob/overview with the PV AADs.
    const blobAad = buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.BLOB);
    const overviewAad = buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.OVERVIEW);
    const blob = await encryptData(payload, key, blobAad);
    const overview = await encryptData(overviewPayload, key, overviewAad);

    // Seed the entry, then snapshot its blob verbatim into history — exactly
    // what PUT /api/passwords/[id] does (copies existing.encryptedBlob).
    await ctx.su.prisma.passwordEntry.create({
      data: {
        id: entryId,
        userId,
        tenantId,
        encryptedBlob: blob.ciphertext,
        blobIv: blob.iv,
        blobAuthTag: blob.authTag,
        encryptedOverview: overview.ciphertext,
        overviewIv: overview.iv,
        overviewAuthTag: overview.authTag,
        keyVersion: 1,
        aadVersion: 1,
      },
    });
    await ctx.su.prisma.passwordEntryHistory.create({
      data: {
        id: historyId,
        entryId,
        tenantId,
        encryptedBlob: blob.ciphertext,
        blobIv: blob.iv,
        blobAuthTag: blob.authTag,
        keyVersion: 1,
        aadVersion: 1,
      },
    });

    // Consumer side: read the history row back and decrypt with the ENTRY AAD.
    const row = await ctx.su.prisma.passwordEntryHistory.findUniqueOrThrow({
      where: { id: historyId },
    });
    const decrypted = await decryptData(
      { ciphertext: row.encryptedBlob, iv: row.blobIv, authTag: row.blobAuthTag },
      key,
      buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.BLOB),
    );
    expect(JSON.parse(decrypted)).toEqual(JSON.parse(payload));

    // Anti-vacuous: a wrong AAD scope MUST fail to authenticate, proving the
    // positive case did not pass by coincidence. (Use a still-existing wrong
    // scope — the retired "PH" history builder no longer exists.)
    await expect(
      decryptData(
        { ciphertext: row.encryptedBlob, iv: row.blobIv, authTag: row.blobAuthTag },
        key,
        buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.OVERVIEW),
      ),
    ).rejects.toThrow();
  });
});
