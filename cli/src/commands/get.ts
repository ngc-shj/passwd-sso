/**
 * `passwd-sso get <id>` — Show a single entry (decrypted blob).
 */

import { apiRequest } from "../lib/api-client.js";
import { getEncryptionKey } from "../lib/vault-state.js";
import { decryptData } from "../lib/crypto.js";
import { copyToClipboard } from "../lib/clipboard.js";
import * as output from "../lib/output.js";

interface PasswordEntryDetail {
  id: string;
  encryptedBlob: string;
  blobIv: string;
  blobAuthTag: string;
  entryType: string;
}

interface EntryBlob {
  title?: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  totp?: string;
  totpAlgorithm?: string;
  totpDigits?: number;
  totpPeriod?: number;
  [key: string]: unknown;
}

function buildAad(entryId: string): Uint8Array {
  return new TextEncoder().encode(`blob:${entryId}`);
}

export async function getCommand(
  id: string,
  options: { copy?: boolean; json?: boolean; field?: string },
): Promise<void> {
  const key = getEncryptionKey();
  if (!key) {
    output.error("Vault is locked. Run `unlock` first.");
    return;
  }

  const res = await apiRequest<PasswordEntryDetail>(`/api/passwords/${id}`);
  if (!res.ok) {
    output.error(`Entry not found: ${res.status}`);
    return;
  }

  const entry = res.data;

  try {
    const plaintext = await decryptData(
      {
        ciphertext: entry.encryptedBlob,
        iv: entry.blobIv,
        authTag: entry.blobAuthTag,
      },
      key,
      buildAad(entry.id),
    );
    const blob: EntryBlob = JSON.parse(plaintext);

    if (options.field) {
      const value = blob[options.field];
      if (value === undefined) {
        output.error(`Field "${options.field}" not found.`);
        return;
      }
      const str = String(value);
      if (options.copy) {
        await copyToClipboard(str);
        output.success(`Copied ${options.field} to clipboard (auto-clears in 30s).`);
      } else {
        console.log(str);
      }
      return;
    }

    if (options.json) {
      output.json(blob);
      return;
    }

    // Formatted display
    if (blob.title) console.log(`Title:    ${blob.title}`);
    if (blob.username) console.log(`Username: ${blob.username}`);
    if (blob.password) console.log(`Password: ${output.masked(blob.password)}`);
    if (blob.url) console.log(`URL:      ${blob.url}`);
    if (blob.notes) console.log(`Notes:    ${blob.notes}`);
    if (blob.totp) console.log(`TOTP:     (configured)`);

    if (options.copy && blob.password) {
      await copyToClipboard(blob.password);
      output.success("Password copied to clipboard (auto-clears in 30s).");
    }
  } catch {
    output.error("Failed to decrypt entry.");
  }
}
