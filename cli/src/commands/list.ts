/**
 * `passwd-sso list` — List vault entries (decrypted overview).
 */

import { apiRequest } from "../lib/api-client.js";
import { getEncryptionKey } from "../lib/vault-state.js";
import { decryptData } from "../lib/crypto.js";
import * as output from "../lib/output.js";

interface PasswordEntry {
  id: string;
  encryptedOverview: string;
  overviewIv: string;
  overviewAuthTag: string;
  entryType: string;
  createdAt: string;
  updatedAt: string;
}

interface Overview {
  title?: string;
  username?: string;
  urlHost?: string;
}

function buildAad(entryId: string): Uint8Array {
  return new TextEncoder().encode(`overview:${entryId}`);
}

export async function listCommand(options: { json?: boolean }): Promise<void> {
  const key = getEncryptionKey();
  if (!key) {
    output.error("Vault is locked. Run `unlock` first.");
    return;
  }

  const res = await apiRequest<PasswordEntry[]>("/api/passwords");
  if (!res.ok) {
    output.error(`Failed to fetch entries: ${res.status}`);
    return;
  }

  const entries = res.data;
  if (!Array.isArray(entries) || entries.length === 0) {
    output.info("No entries found.");
    return;
  }

  const decrypted: Array<{ id: string; title: string; username: string; url: string; type: string }> = [];

  for (const entry of entries) {
    try {
      const plaintext = await decryptData(
        {
          ciphertext: entry.encryptedOverview,
          iv: entry.overviewIv,
          authTag: entry.overviewAuthTag,
        },
        key,
        buildAad(entry.id),
      );
      const overview: Overview = JSON.parse(plaintext);
      decrypted.push({
        id: entry.id,
        title: overview.title ?? "(untitled)",
        username: overview.username ?? "",
        url: overview.urlHost ?? "",
        type: entry.entryType ?? "LOGIN",
      });
    } catch {
      decrypted.push({
        id: entry.id,
        title: "(decryption failed)",
        username: "",
        url: "",
        type: entry.entryType ?? "?",
      });
    }
  }

  if (options.json) {
    output.json(decrypted);
  } else {
    output.table(
      ["ID", "Type", "Title", "Username", "URL"],
      decrypted.map((d) => [
        d.id.slice(0, 8) + "…",
        d.type,
        d.title,
        d.username,
        d.url,
      ]),
    );
    output.info(`${decrypted.length} entries`);
  }
}
