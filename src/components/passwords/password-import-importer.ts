import { encryptData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD, buildTeamEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
import {
  buildPersonalImportBlobs,
  resolveEntryTagIds,
  resolveTagNameToIdForImport,
  type ParsedEntry,
} from "@/components/passwords/password-import-utils";

interface RunImportParams {
  entries: ParsedEntry[];
  isTeamImport: boolean;
  tagsPath: string;
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
  const tagNameToId = await resolveTagNameToIdForImport(entries, tagsPath);
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
        const blobAad = buildTeamEntryAAD(teamId!, entryId, "blob");
        const overviewAad = buildTeamEntryAAD(teamId!, entryId, "overview");
        const encryptedBlob = await encryptData(fullBlob, teamEncryptionKey!, blobAad);
        const encryptedOverview = await encryptData(overviewBlob, teamEncryptionKey!, overviewAad);

        res = await fetch(passwordsPath, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: entryId,
            encryptedBlob,
            encryptedOverview,
            entryType: entry.entryType,
            aadVersion: AAD_VERSION,
            orgKeyVersion: teamKeyVersion ?? 1,
            tagIds,
          }),
        });
      } else {
        const { fullBlob, overviewBlob } = buildPersonalImportBlobs(entry);
        const entryId = crypto.randomUUID();
        const aad = userId ? buildPersonalEntryAAD(userId, entryId) : undefined;
        const encryptedBlob = await encryptData(fullBlob, encryptionKey!, aad);
        const encryptedOverview = await encryptData(overviewBlob, encryptionKey!, aad);

        res = await fetch(passwordsPath, {
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
