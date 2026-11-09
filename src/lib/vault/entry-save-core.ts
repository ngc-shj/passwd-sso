import type { EncryptedData } from "@/lib/crypto/crypto-client";
import { VAULT_TYPE, type VaultType } from "@/lib/crypto/crypto-aad";
import { fetchApi } from "@/lib/url-helpers";

/** Seals one entry field; the scope's own sealer binds its AAD (personal "PV", team "OV"). */
export type SealEntryField = (plaintext: string, vaultType: VaultType) => Promise<EncryptedData>;

interface BuildEncryptedBodyParams {
  mode: "create" | "edit";
  entryId: string;
  seal: SealEntryField;
  fullBlob: string;
  overviewBlob: string;
  tagIds: string[];
  /** Extra fields merged into the body (scope-specific: keyVersion, aadVersion, team fields, etc.) */
  extra: Record<string, unknown>;
  /** Optional fields set only when defined */
  optionals?: Record<string, unknown>;
}

/**
 * Shared mechanics for personal and team entry save:
 * 1. Seal blob + overview with the scope's sealer
 * 2. Build request body with common + scope-specific fields
 */
export async function buildEncryptedEntryBody({
  mode,
  entryId,
  seal,
  fullBlob,
  overviewBlob,
  tagIds,
  extra,
  optionals,
}: BuildEncryptedBodyParams): Promise<Record<string, unknown>> {
  const encryptedBlob = await seal(fullBlob, VAULT_TYPE.BLOB);
  const encryptedOverview = await seal(overviewBlob, VAULT_TYPE.OVERVIEW);

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
