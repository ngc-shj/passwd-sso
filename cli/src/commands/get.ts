/**
 * `passwd-sso get <id>` — Show a single entry (decrypted blob).
 */

import { apiRequest } from "../lib/api-client.js";
import { getEncryptionKey, getUserId } from "../lib/vault-state.js";
import { decryptData } from "../lib/crypto.js";
import { buildPersonalEntryAAD } from "../lib/crypto-aad.js";
import { copyToClipboard } from "../lib/clipboard.js";
import * as output from "../lib/output.js";

interface PasswordEntryDetail {
  id: string;
  encryptedBlob: {
    ciphertext: string;
    iv: string;
    authTag: string;
  };
  aadVersion: number;
  entryType: string;
}

interface EntryBlob {
  title?: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  totp?: {
    secret: string;
    algorithm?: string;
    digits?: number;
    period?: number;
  };
  [key: string]: unknown;
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

  const userId = getUserId();

  const res = await apiRequest<PasswordEntryDetail>(`/api/passwords/${id}`);
  if (!res.ok) {
    output.error(`Entry not found: ${res.status}`);
    return;
  }

  const entry = res.data;

  try {
    const aad = entry.aadVersion >= 1 && userId
      ? buildPersonalEntryAAD(userId, entry.id)
      : undefined;
    const plaintext = await decryptData(
      entry.encryptedBlob,
      key,
      aad,
    );
    const blob: EntryBlob = JSON.parse(plaintext);

    if (options.field) {
      const value = blob[options.field];
      if (value === undefined) {
        output.error(`Field "${options.field}" not found.`);
        return;
      }
      const str = typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : String(value);
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
