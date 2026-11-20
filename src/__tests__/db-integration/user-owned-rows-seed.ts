/**
 * One row in each tenant-scoped model that binds a row to a user and that a
 * tenant move counts as stranded (src/lib/tenant/stranded-rows.ts), for `userId`
 * under `tenantId`. An enforcing bypass is consulted per row a statement
 * examines, so a cell that runs `realign` or `backfill-owning-column` over a
 * user with no rows proves nothing about the models the grant names: only a seeded
 * row can be refused.
 *
 * Seeded through the superuser client under the test setup grant. The rows are
 * removed with the user (cascade) and the tenant (ctx.deleteTestData); the
 * MCP client and the team are not owned by the user, so they are returned for
 * the caller to name in its own cleanup.
 */
import { randomUUID, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { recipientKey, setBypassRlsGucs, type PrismaWithPool } from "./helpers";

const hex64 = () => randomBytes(32).toString("hex");

/** The models seeded: STRANDED_COUNTERS' member set (the cell that seeds them asserts the two are equal). */
export const USER_OWNED_MODELS = [
  "account",
  "apiKey",
  "attachment",
  "delegationSession",
  "emergencyAccessGrant",
  "extensionBridgeCode",
  "extensionToken",
  "folder",
  "mcpAccessToken",
  "mcpAuthorizationCode",
  "mcpRefreshToken",
  "mobileBridgeCode",
  "notification",
  "operatorToken",
  "passwordEntry",
  "passwordShare",
  "session",
  "tag",
  "teamMemberKey",
  "teamPasswordFavorite",
  "vaultKey",
  "webAuthnCredential",
] as const;

export type SeededUserOwnedRows = { mcpClientId: string; teamId: string };

export async function seedUserOwnedRows(su: PrismaWithPool, tenantId: string, userId: string): Promise<SeededUserOwnedRows> {
  const mcpClientId = randomUUID();
  const teamId = randomUUID();
  const mcpAccessTokenId = randomUUID();
  const teamEntryId = randomUUID();
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  const blob = { encryptedBlob: "b", blobIv: "iv", blobAuthTag: "tag", encryptedOverview: "o", overviewIv: "iv", overviewAuthTag: "tag" };

  const { fingerprint } = await recipientKey(su, userId);
  await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.account.create({
      data: { userId, tenantId, type: "oidc", provider: "google", providerAccountId: `subject-${randomUUID()}` },
    });
    await tx.apiKey.create({
      data: { userId, tenantId, tokenHash: hex64(), prefix: "api_test", name: `key-${randomUUID().slice(0, 8)}`, scope: "passwords:read", expiresAt: soon },
    });
    await tx.passwordEntry.create({ data: { ...blob, keyVersion: 1, userId, tenantId } }).then(async (entry) => {
      await tx.attachment.create({
        data: {
          filename: "a.txt", contentType: "text/plain", sizeBytes: 1, encryptedData: Buffer.from("x"), iv: "iv", authTag: "tag",
          tenantId, createdById: userId, passwordEntryId: entry.id,
        },
      });
    });
    await tx.passwordShare.create({
      data: { tenantId, tokenHash: hex64(), encryptedData: "d", dataIv: "iv", dataAuthTag: "tag", expiresAt: soon, createdById: userId },
    });
    await tx.emergencyAccessGrant.create({
      data: { tenantId, ownerId: userId, granteeEmail: `grantee-${randomUUID()}@example.invalid`, waitDays: 7, tokenHash: hex64(), tokenExpiresAt: soon },
    });
    await tx.extensionToken.create({
      data: { userId, tenantId, tokenHash: hex64(), scope: "extension:read", expiresAt: soon, familyId: randomUUID(), familyCreatedAt: new Date(), cnfJkt: "a".repeat(43) },
    });
    await tx.extensionBridgeCode.create({
      data: { codeHash: hex64(), userId, tenantId, scope: "extension:read", expiresAt: soon, cnfJkt: "a".repeat(43) },
    });
    await tx.mobileBridgeCode.create({
      data: { codeHash: hex64(), userId, tenantId, state: "s".repeat(32), codeChallenge: "c".repeat(43), deviceJkt: "d".repeat(43), expiresAt: soon },
    });
    await tx.folder.create({ data: { name: `folder-${randomUUID().slice(0, 8)}`, userId, tenantId } });
    await tx.tag.create({ data: { name: `tag-${randomUUID().slice(0, 8)}`, userId, tenantId } });
    await tx.notification.create({ data: { userId, tenantId, type: "SECURITY_ALERT", title: "t", body: "b" } });
    await tx.vaultKey.create({
      data: { userId, tenantId, version: 1, verificationCiphertext: "c", verificationIv: "iv", verificationAuthTag: "tag" },
    });
    await tx.webAuthnCredential.create({
      data: { userId, tenantId, credentialId: `cred-${randomUUID()}`, publicKey: "pk", deviceType: "singleDevice" },
    });
    await tx.session.create({
      data: { sessionToken: hex64(), userId, tenantId, expires: soon },
    });
    await tx.operatorToken.create({
      data: { tokenHash: hex64(), prefix: "op_test1", name: `op-${randomUUID().slice(0, 8)}`, tenantId, subjectUserId: userId, createdByUserId: userId, scope: "maintenance", expiresAt: soon },
    });

    // The MCP stack and the team are tenant-owned; the user's rows hang off them.
    await tx.mcpClient.create({
      data: {
        id: mcpClientId, tenantId, clientId: `cli-${mcpClientId.slice(0, 16)}`, clientSecretHash: hex64(), name: `client-${mcpClientId.slice(0, 8)}`,
        redirectUris: ["http://localhost/cb"], allowedScopes: "passwords:read", isActive: true, createdById: userId,
      },
    });
    await tx.mcpAccessToken.create({
      data: { id: mcpAccessTokenId, tokenHash: hex64(), clientId: mcpClientId, tenantId, userId, scope: "passwords:read", expiresAt: soon },
    });
    await tx.mcpRefreshToken.create({
      data: { tokenHash: hex64(), familyId: randomUUID(), accessTokenId: mcpAccessTokenId, clientId: mcpClientId, tenantId, userId, scope: "passwords:read", expiresAt: soon },
    });
    await tx.delegationSession.create({
      data: { tenantId, userId, mcpTokenId: mcpAccessTokenId, entryIds: [], expiresAt: soon },
    });
    await tx.mcpAuthorizationCode.create({
      data: { codeHash: hex64(), clientId: mcpClientId, tenantId, userId, redirectUri: "http://localhost/cb", scope: "passwords:read", codeChallenge: "c".repeat(43), expiresAt: soon },
    });

    await tx.$executeRawUnsafe(
      `INSERT INTO teams (id, tenant_id, name, slug, created_at, updated_at) VALUES ($1::uuid, $2::uuid, 'seed-team', $3, now(), now())`,
      teamId, tenantId, `seed-${teamId.slice(0, 8)}`,
    );
    await tx.teamMemberKey.create({
      data: { teamId, userId, tenantId, encryptedTeamKey: "k", teamKeyIv: "iv", teamKeyAuthTag: "tag", ephemeralPublicKey: "epk", hkdfSalt: "salt", recipientKeyFingerprint: fingerprint },
    });
    await tx.teamPasswordEntry.create({
      data: { id: teamEntryId, ...blob, teamId, tenantId, createdById: userId, updatedById: userId },
    });
    await tx.teamPasswordFavorite.create({ data: { userId, tenantId, teamPasswordEntryId: teamEntryId } });
  });
  return { mcpClientId, teamId };
}

/**
 * Remove every row the seed made. A tenant move leaves the user's rows filed
 * under the tenant that released them, where deleteTestData (which deletes users
 * by their current tenant) no longer reaches them, so a cell that moves the
 * user must clear them by user first.
 */
export async function removeSeededUserOwnedRows(
  su: PrismaClient,
  userId: string,
  seeded: SeededUserOwnedRows,
): Promise<void> {
  const byUser: ReadonlyArray<readonly [table: string, column: string]> = [
    // A delegation session restricts the access token it names.
    ["delegation_sessions", "user_id"],
    ["mcp_refresh_tokens", "user_id"],
    ["mcp_authorization_codes", "user_id"],
    ["mcp_access_tokens", "user_id"],
    ["accounts", "user_id"],
    ["api_keys", "user_id"],
    ["attachments", "created_by_id"],
    ["emergency_access_grants", "owner_id"],
    ["extension_bridge_codes", "user_id"],
    ["extension_tokens", "user_id"],
    ["folders", "user_id"],
    ["mobile_bridge_codes", "user_id"],
    ["notifications", "user_id"],
    ["operator_tokens", "subject_user_id"],
    ["password_entries", "user_id"],
    ["password_shares", "created_by_id"],
    ["sessions", "user_id"],
    ["tags", "user_id"],
    ["team_password_favorites", "user_id"],
    ["team_member_keys", "user_id"],
    ["vault_keys", "user_id"],
    ["webauthn_credentials", "user_id"],
  ];
  await su.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    for (const [table, column] of byUser) {
      await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${column} = $1::uuid`, userId);
    }
    await tx.$executeRawUnsafe(`DELETE FROM mcp_clients WHERE id = $1::uuid`, seeded.mcpClientId);
    await tx.$executeRawUnsafe(`DELETE FROM teams WHERE id = $1::uuid`, seeded.teamId);
  });
}
