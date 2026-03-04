/**
 * `passwd-sso export` — Export vault entries to JSON or CSV.
 */

import { apiRequest } from "../lib/api-client.js";
import { getEncryptionKey, getUserId } from "../lib/vault-state.js";
import { decryptData } from "../lib/crypto.js";
import { buildPersonalEntryAAD } from "../lib/crypto-aad.js";
import * as output from "../lib/output.js";

interface PasswordEntry {
  id: string;
  encryptedBlob: {
    ciphertext: string;
    iv: string;
    authTag: string;
  };
  aadVersion: number;
  entryType: string;
  createdAt: string;
  updatedAt: string;
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

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function exportCommand(options: {
  format?: string;
  output?: string;
}): Promise<void> {
  const key = getEncryptionKey();
  if (!key) {
    output.error("Vault is locked. Run `unlock` first.");
    return;
  }

  const format = options.format ?? "json";
  if (format !== "json" && format !== "csv") {
    output.error("Format must be 'json' or 'csv'.");
    return;
  }

  const res = await apiRequest<PasswordEntry[]>("/api/passwords?include=blob");
  if (!res.ok) {
    output.error(`Failed to fetch entries: ${res.status}`);
    return;
  }

  const entries = res.data;
  if (!Array.isArray(entries) || entries.length === 0) {
    output.info("No entries to export.");
    return;
  }

  const userId = getUserId();
  const decrypted: EntryBlob[] = [];

  for (const entry of entries) {
    try {
      const aad = entry.aadVersion >= 1 && userId
        ? buildPersonalEntryAAD(userId, entry.id)
        : undefined;
      const plaintext = await decryptData(
        entry.encryptedBlob,
        key,
        aad,
      );
      decrypted.push(JSON.parse(plaintext));
    } catch {
      decrypted.push({ title: "(decryption failed)" });
    }
  }

  if (format === "json") {
    const out = JSON.stringify(decrypted, null, 2);
    if (options.output) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(options.output, out, { encoding: "utf-8", mode: 0o600 });
      output.success(`Exported ${decrypted.length} entries to ${options.output}`);
    } else {
      console.log(out);
    }
  } else {
    const headers = ["title", "username", "password", "url", "notes", "totp"];
    const csvRows = [headers.join(",")];
    for (const entry of decrypted) {
      csvRows.push(
        headers.map((h) => {
          const val = entry[h];
          if (h === "totp" && val && typeof val === "object") {
            return escapeCSV((val as { secret: string }).secret ?? "");
          }
          return escapeCSV(String(val ?? ""));
        }).join(","),
      );
    }
    const csvOut = csvRows.join("\n");

    if (options.output) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(options.output, csvOut, { encoding: "utf-8", mode: 0o600 });
      output.success(`Exported ${decrypted.length} entries to ${options.output}`);
    } else {
      console.log(csvOut);
    }
  }
}
