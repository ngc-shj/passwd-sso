import { encryptData } from "@/lib/crypto/crypto-client";
import {
  buildPersonalEntryAAD,
  buildItemKeyWrapAAD,
  VAULT_TYPE,
  AAD_VERSION,
} from "@/lib/crypto/crypto-aad";
import {
  generateItemKey,
  wrapItemKey,
  deriveItemEncryptionKey,
  sealTeamEntryField,
} from "@/lib/crypto/crypto-team";
import {
  buildPersonalImportBlobs,
  resolveEntryTagIds,
  resolveTagNameToIdForImport,
  type ParsedEntry,
} from "@/components/passwords/import/password-import-utils";
import {
  resolveFolderPathsForImport,
  resolveEntryFolderId,
} from "@/components/passwords/import/password-import-folders";
import { apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { MS_PER_SECOND, MS_PER_MINUTE } from "@/lib/constants/time";

const BULK_IMPORT_CHUNK_SIZE = 50;
const MAX_RETRIES_PER_CHUNK = 3;

interface RunImportParams {
  entries: ParsedEntry[];
  isTeamImport: boolean;
  tagsPath: string;
  foldersPath: string;
  sourceFilename: string;
  userId?: string;
  encryptionKey?: CryptoKey;
  keyVersion?: number;
  teamEncryptionKey?: CryptoKey;
  teamKeyVersion?: number;
  teamId?: string;
  onProgress?: (current: number, total: number) => void;
}

interface RunImportResult {
  successCount: number;
  failedCount: number;
}

/**
 * One team import entry: a fresh ItemKey wrapped under the team key, blob and
 * overview sealed at the team entry AAD (ItemKey version 1).
 */
async function encryptTeamImportEntry(
  entry: ParsedEntry,
  tagIds: string[],
  folderId: string | null | undefined,
  teamId: string,
  teamEncryptionKey: CryptoKey,
  teamKeyVersion: number,
): Promise<{ id: string; body: object }> {
  const { fullBlob, overviewBlob } = buildPersonalImportBlobs(entry);
  const entryId = crypto.randomUUID();

  // Generate per-entry ItemKey
  const rawItemKey = generateItemKey();
  let itemEncKey: CryptoKey;
  let encryptedItemKey: { ciphertext: string; iv: string; authTag: string };
  try {
    const ikAad = buildItemKeyWrapAAD(teamId, entryId, teamKeyVersion);
    const wrapped = await wrapItemKey(rawItemKey, teamEncryptionKey, ikAad);
    itemEncKey = await deriveItemEncryptionKey(rawItemKey);
    encryptedItemKey = { ciphertext: wrapped.ciphertext, iv: wrapped.iv, authTag: wrapped.authTag };
  } finally {
    rawItemKey.fill(0);
  }

  const encryptedBlob = await sealTeamEntryField(fullBlob, itemEncKey, {
    teamId,
    entryId,
    vaultType: VAULT_TYPE.BLOB,
    itemKeyVersion: 1,
  });
  const encryptedOverview = await sealTeamEntryField(overviewBlob, itemEncKey, {
    teamId,
    entryId,
    vaultType: VAULT_TYPE.OVERVIEW,
    itemKeyVersion: 1,
  });

  return {
    id: entryId,
    body: {
      id: entryId,
      encryptedBlob,
      encryptedOverview,
      entryType: entry.entryType,
      aadVersion: AAD_VERSION,
      teamKeyVersion,
      itemKeyVersion: 1,
      encryptedItemKey,
      tagIds,
      ...(entry.requireReprompt ? { requireReprompt: true } : {}),
      ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
      ...(folderId ? { teamFolderId: folderId } : {}),
    },
  };
}

/** One personal import entry, sealed at the personal entry AAD. */
async function encryptPersonalImportEntry(
  entry: ParsedEntry,
  tagIds: string[],
  folderId: string | null | undefined,
  userId: string,
  encryptionKey: CryptoKey,
  keyVersion: number,
): Promise<object> {
  const { fullBlob, overviewBlob } = buildPersonalImportBlobs(entry);
  const entryId = crypto.randomUUID();
  // C1: blob and overview now bind distinct vaultType in AAD.
  const blobAad = buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.BLOB);
  const overviewAad = buildPersonalEntryAAD(userId, entryId, VAULT_TYPE.OVERVIEW);
  const encryptedBlob = await encryptData(fullBlob, encryptionKey, blobAad);
  const encryptedOverview = await encryptData(overviewBlob, encryptionKey, overviewAad);

  return {
    id: entryId,
    encryptedBlob,
    encryptedOverview,
    entryType: entry.entryType,
    keyVersion,
    aadVersion: AAD_VERSION,
    tagIds,
    ...(entry.requireReprompt ? { requireReprompt: true } : {}),
    ...(entry.isFavorite ? { isFavorite: true } : {}),
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
    ...(folderId ? { folderId } : {}),
  };
}

function importRequestHeaders(sourceFilename: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "x-passwd-sso-source": "import",
    ...(sourceFilename ? { "x-passwd-sso-filename": sourceFilename } : {}),
  };
}

export async function runImportEntries({
  entries,
  isTeamImport,
  tagsPath,
  foldersPath,
  sourceFilename,
  userId,
  encryptionKey,
  keyVersion,
  teamEncryptionKey,
  teamKeyVersion,
  teamId,
  onProgress,
}: RunImportParams): Promise<RunImportResult> {
  if (!isTeamImport && !encryptionKey) {
    throw new Error("encryptionKey is required for personal import");
  }
  if (!isTeamImport && !userId) {
    throw new Error("userId is required for personal import");
  }
  if (!isTeamImport && keyVersion === undefined) {
    throw new Error("keyVersion is required for personal import");
  }
  if (isTeamImport && (!teamEncryptionKey || !teamId)) {
    throw new Error("teamEncryptionKey and teamId are required for team import");
  }

  let successCount = 0;
  const [tagNameToId, folderPathToId] = await Promise.all([
    resolveTagNameToIdForImport(entries, tagsPath),
    resolveFolderPathsForImport(entries, foldersPath),
  ]);
  const headers = importRequestHeaders(sourceFilename);
  const bulkPath = isTeamImport
    ? apiPath.teamPasswordsBulkImport(teamId!)
    : apiPath.passwordsBulkImport();

  // Track favorited team entries for post-bulk favorite toggle
  const teamFavoriteEntryIds: string[] = [];

  for (let chunkStart = 0; chunkStart < entries.length; chunkStart += BULK_IMPORT_CHUNK_SIZE) {
    const chunk = entries.slice(chunkStart, chunkStart + BULK_IMPORT_CHUNK_SIZE);

    // Encrypt all entries in the chunk
    const encryptedEntries: object[] = [];
    // Collect favorites for this chunk; only committed to teamFavoriteEntryIds on success
    const chunkFavoriteEntryIds: string[] = [];
    for (const entry of chunk) {
      const tagIds = resolveEntryTagIds(entry, tagNameToId);

      const folderId = resolveEntryFolderId(entry, folderPathToId);

      if (isTeamImport) {
        try {
          const sealed = await encryptTeamImportEntry(
            entry, tagIds, folderId, teamId!, teamEncryptionKey!, teamKeyVersion ?? 1,
          );
          if (entry.isFavorite) {
            chunkFavoriteEntryIds.push(sealed.id);
          }
          encryptedEntries.push(sealed.body);
        } catch {
          // Encryption failed for this entry — skip it
          continue;
        }
      } else {
        encryptedEntries.push(
          await encryptPersonalImportEntry(entry, tagIds, folderId, userId!, encryptionKey!, keyVersion!),
        );
      }
    }

    // Send chunk with retry on 429
    let chunkSuccess = 0;
    let retries = 0;
    let sent = false;
    while (!sent && retries < MAX_RETRIES_PER_CHUNK) {
      try {
        const res = await fetchApi(bulkPath, {
          method: "POST",
          headers,
          body: JSON.stringify({ entries: encryptedEntries, sourceFilename }),
        });

        if (res.status === 429) {
          retries++;
          if (retries >= MAX_RETRIES_PER_CHUNK) {
            // Retries exhausted — treat entire chunk as failed
            break;
          }
          const retryAfter = res.headers.get("Retry-After");
          const rawSec = retryAfter ? parseInt(retryAfter, 10) : 1;
          const delayMs = Math.min(Math.max(Number.isNaN(rawSec) ? 1 : rawSec, 1) * MS_PER_SECOND, MS_PER_MINUTE);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        if (res.ok) {
          const data = await res.json();
          chunkSuccess = typeof data.importedCount === "number" ? data.importedCount : 0;
        }
        sent = true;
      } catch {
        // Network error — treat chunk as failed
        sent = true;
      }
    }

    successCount += chunkSuccess;
    // Only schedule favorite toggles if the chunk was accepted by the server
    if (chunkSuccess > 0) {
      for (const id of chunkFavoriteEntryIds) {
        teamFavoriteEntryIds.push(id);
      }
    }
    onProgress?.(Math.min(chunkStart + chunk.length, entries.length), entries.length);
  }

  // Set per-user favorite via toggle API for team entries (best-effort).
  // Done after bulk import so entry IDs are known.
  for (const entryId of teamFavoriteEntryIds) {
    await fetchApi(apiPath.teamPasswordFavorite(teamId!, entryId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }).catch(() => {
      // Silently ignore — entry is already created
    });
  }

  return {
    successCount,
    failedCount: Math.max(0, entries.length - successCount),
  };
}
