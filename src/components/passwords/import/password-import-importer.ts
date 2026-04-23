import { encryptData } from "@/lib/crypto/crypto-client";
import {
  buildPersonalEntryAAD,
  buildTeamEntryAAD,
  buildItemKeyWrapAAD,
  AAD_VERSION,
} from "@/lib/crypto/crypto-aad";
import {
  generateItemKey,
  wrapItemKey,
  deriveItemEncryptionKey,
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
  teamEncryptionKey?: CryptoKey;
  teamKeyVersion?: number;
  teamId?: string;
  onProgress?: (current: number, total: number) => void;
}

interface RunImportResult {
  successCount: number;
  failedCount: number;
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

      if (isTeamImport) {
        try {
          const { fullBlob, overviewBlob } = buildPersonalImportBlobs(entry);
          const entryId = crypto.randomUUID();
          const tkv = teamKeyVersion ?? 1;

          // Generate per-entry ItemKey
          const rawItemKey = generateItemKey();
          let itemEncKey: CryptoKey;
          let encryptedItemKey: { ciphertext: string; iv: string; authTag: string };
          try {
            const ikAad = buildItemKeyWrapAAD(teamId!, entryId, tkv);
            const wrapped = await wrapItemKey(rawItemKey, teamEncryptionKey!, ikAad);
            itemEncKey = await deriveItemEncryptionKey(rawItemKey);
            encryptedItemKey = { ciphertext: wrapped.ciphertext, iv: wrapped.iv, authTag: wrapped.authTag };
          } finally {
            rawItemKey.fill(0);
          }

          const blobAad = buildTeamEntryAAD(teamId!, entryId, "blob", 1);
          const overviewAad = buildTeamEntryAAD(teamId!, entryId, "overview", 1);
          const encryptedBlob = await encryptData(fullBlob, itemEncKey!, blobAad);
          const encryptedOverview = await encryptData(overviewBlob, itemEncKey!, overviewAad);

          if (entry.isFavorite) {
            chunkFavoriteEntryIds.push(entryId);
          }

          const folderId = resolveEntryFolderId(entry, folderPathToId);
          encryptedEntries.push({
            id: entryId,
            encryptedBlob,
            encryptedOverview,
            entryType: entry.entryType,
            aadVersion: AAD_VERSION,
            teamKeyVersion: tkv,
            itemKeyVersion: 1,
            encryptedItemKey,
            tagIds,
            ...(entry.requireReprompt ? { requireReprompt: true } : {}),
            ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
            ...(folderId ? { teamFolderId: folderId } : {}),
          });
        } catch {
          // Encryption failed for this entry — skip it
          continue;
        }
      } else {
        const { fullBlob, overviewBlob } = buildPersonalImportBlobs(entry);
        const entryId = crypto.randomUUID();
        const aad = buildPersonalEntryAAD(userId!, entryId);
        const encryptedBlob = await encryptData(fullBlob, encryptionKey!, aad);
        const encryptedOverview = await encryptData(overviewBlob, encryptionKey!, aad);

        const folderId = resolveEntryFolderId(entry, folderPathToId);
        encryptedEntries.push({
          id: entryId,
          encryptedBlob,
          encryptedOverview,
          entryType: entry.entryType,
          keyVersion: 1,
          aadVersion: AAD_VERSION,
          tagIds,
          ...(entry.requireReprompt ? { requireReprompt: true } : {}),
          ...(entry.isFavorite ? { isFavorite: true } : {}),
          ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
          ...(folderId ? { folderId } : {}),
        });
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
          const delayMs = Math.min(Math.max(Number.isNaN(rawSec) ? 1 : rawSec, 1) * 1000, 60_000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        if (res.ok) {
          const data = await res.json();
          chunkSuccess = typeof data.success === "number" ? data.success : 0;
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
