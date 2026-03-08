import { encryptData } from "@/lib/crypto-client";
import {
  buildPersonalEntryAAD,
  buildTeamEntryAAD,
  buildItemKeyWrapAAD,
  AAD_VERSION,
} from "@/lib/crypto-aad";
import {
  generateItemKey,
  wrapItemKey,
  deriveItemEncryptionKey,
} from "@/lib/crypto-team";
import {
  buildPersonalImportBlobs,
  resolveEntryTagIds,
  resolveTagNameToIdForImport,
  type ParsedEntry,
} from "@/components/passwords/password-import-utils";
import {
  resolveFolderPathsForImport,
  resolveEntryFolderId,
} from "@/components/passwords/password-import-folders";
import { apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";

interface RunImportParams {
  entries: ParsedEntry[];
  isTeamImport: boolean;
  tagsPath: string;
  foldersPath: string;
  passwordsPath: string;
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
  passwordsPath,
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
  if (isTeamImport && (!teamEncryptionKey || !teamId)) {
    throw new Error("teamEncryptionKey and teamId are required for team import");
  }

  let successCount = 0;
  const [tagNameToId, folderPathToId] = await Promise.all([
    resolveTagNameToIdForImport(entries, tagsPath),
    resolveFolderPathsForImport(entries, foldersPath),
  ]);
  const headers = importRequestHeaders(sourceFilename);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    onProgress?.(i + 1, entries.length);

    try {
      const tagIds = resolveEntryTagIds(entry, tagNameToId);
      let res: Response;

      if (isTeamImport) {
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
        const encryptedBlob = await encryptData(fullBlob, itemEncKey, blobAad);
        const encryptedOverview = await encryptData(overviewBlob, itemEncKey, overviewAad);

        res = await fetchApi(passwordsPath, {
          method: "POST",
          headers,
          body: JSON.stringify({
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
            ...(() => {
              const fid = resolveEntryFolderId(entry, folderPathToId);
              return fid ? { teamFolderId: fid } : {};
            })(),
          }),
        });

        // Set per-user favorite via toggle API (team favorites are a join table).
        // Failure is best-effort: the entry itself is already created and
        // the user can manually toggle the favorite later.
        if (res.ok && entry.isFavorite) {
          await fetchApi(apiPath.teamPasswordFavorite(teamId!, entryId), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          }).catch(() => {
            // Silently ignore — entry is already created
          });
        }
      } else {
        const { fullBlob, overviewBlob } = buildPersonalImportBlobs(entry);
        const entryId = crypto.randomUUID();
        const aad = userId ? buildPersonalEntryAAD(userId, entryId) : undefined;
        const encryptedBlob = await encryptData(fullBlob, encryptionKey!, aad);
        const encryptedOverview = await encryptData(overviewBlob, encryptionKey!, aad);

        res = await fetchApi(passwordsPath, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: entryId,
            encryptedBlob,
            encryptedOverview,
            entryType: entry.entryType,
            keyVersion: 1,
            aadVersion: aad ? AAD_VERSION : 0,
            tagIds,
            ...(entry.requireReprompt ? { requireReprompt: true } : {}),
            ...(entry.isFavorite ? { isFavorite: true } : {}),
            ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
            ...(() => {
              const fid = resolveEntryFolderId(entry, folderPathToId);
              return fid ? { folderId: fid } : {};
            })(),
          }),
        });
      }

      if (res.ok) successCount++;
    } catch {
      // Skip failed entries and continue import loop.
    }
  }

  return {
    successCount,
    failedCount: Math.max(0, entries.length - successCount),
  };
}
