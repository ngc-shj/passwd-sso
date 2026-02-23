import { encryptData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD, buildOrgEntryAAD, AAD_VERSION } from "@/lib/crypto-aad";
import {
  buildPersonalImportBlobs,
  resolveEntryTagIds,
  resolveTagNameToIdForImport,
  type ParsedEntry,
} from "@/components/passwords/password-import-utils";

interface RunImportParams {
  entries: ParsedEntry[];
  isOrgImport: boolean;
  tagsPath: string;
  passwordsPath: string;
  sourceFilename: string;
  userId?: string;
  encryptionKey?: CryptoKey;
  orgEncryptionKey?: CryptoKey;
  orgKeyVersion?: number;
  orgId?: string;
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
  isOrgImport,
  tagsPath,
  passwordsPath,
  sourceFilename,
  userId,
  encryptionKey,
  orgEncryptionKey,
  orgKeyVersion,
  orgId,
  onProgress,
}: RunImportParams): Promise<RunImportResult> {
  if (!isOrgImport && !encryptionKey) {
    throw new Error("encryptionKey is required for personal import");
  }
  if (isOrgImport && (!orgEncryptionKey || !orgId)) {
    throw new Error("orgEncryptionKey and orgId are required for org import");
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

      if (isOrgImport) {
        const { fullBlob, overviewBlob } = buildPersonalImportBlobs(entry);
        const entryId = crypto.randomUUID();
        const blobAad = buildOrgEntryAAD(orgId!, entryId, "blob");
        const overviewAad = buildOrgEntryAAD(orgId!, entryId, "overview");
        const encryptedBlob = await encryptData(fullBlob, orgEncryptionKey!, blobAad);
        const encryptedOverview = await encryptData(overviewBlob, orgEncryptionKey!, overviewAad);

        res = await fetch(passwordsPath, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: entryId,
            encryptedBlob,
            encryptedOverview,
            entryType: entry.entryType,
            aadVersion: AAD_VERSION,
            orgKeyVersion: orgKeyVersion ?? 1,
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
