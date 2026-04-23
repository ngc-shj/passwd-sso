import { encryptData } from "@/lib/crypto/crypto-client";
import { fetchApi } from "@/lib/url-helpers";

interface BuildEncryptedBodyParams {
  mode: "create" | "edit";
  entryId: string;
  encryptionKey: CryptoKey;
  fullBlob: string;
  overviewBlob: string;
  blobAAD?: Uint8Array;
  overviewAAD?: Uint8Array;
  tagIds: string[];
  /** Extra fields merged into the body (scope-specific: keyVersion, aadVersion, team fields, etc.) */
  extra: Record<string, unknown>;
  /** Optional fields set only when defined */
  optionals?: Record<string, unknown>;
}

/**
 * Shared mechanics for personal and team entry save:
 * 1. Encrypt blob + overview with scope-specific AAD
 * 2. Build request body with common + scope-specific fields
 */
export async function buildEncryptedEntryBody({
  mode,
  entryId,
  encryptionKey,
  fullBlob,
  overviewBlob,
  blobAAD,
  overviewAAD,
  tagIds,
  extra,
  optionals,
}: BuildEncryptedBodyParams): Promise<Record<string, unknown>> {
  const encryptedBlob = await encryptData(fullBlob, encryptionKey, blobAAD);
  const encryptedOverview = await encryptData(overviewBlob, encryptionKey, overviewAAD);

  const body: Record<string, unknown> = {
    ...(mode === "create" ? { id: entryId } : {}),
    encryptedBlob,
    encryptedOverview,
    tagIds,
    ...extra,
  };

  if (optionals) {
    for (const [key, value] of Object.entries(optionals)) {
      if (value !== undefined) body[key] = value;
    }
  }

  return body;
}

/**
 * Send the built body to the API endpoint.
 */
export function submitEntry(
  endpoint: string,
  method: "POST" | "PUT",
  body: Record<string, unknown>,
): Promise<Response> {
  return fetchApi(endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
