/**
 * `passwd-sso export` — Export vault entries to JSON or CSV.
 */

import { apiRequest } from "../lib/api-client.js";
import { getEncryptionKey } from "../lib/vault-state.js";
import { decryptData } from "../lib/crypto.js";
import * as output from "../lib/output.js";

interface PasswordEntry {
  id: string;
  encryptedBlob: string;
  blobIv: string;
  blobAuthTag: string;
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
  totp?: string;
  [key: string]: unknown;
}

function buildAad(entryId: string): Uint8Array {
  return new TextEncoder().encode(`blob:${entryId}`);
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

  const res = await apiRequest<PasswordEntry[]>("/api/passwords");
  if (!res.ok) {
    output.error(`Failed to fetch entries: ${res.status}`);
    return;
  }

  const entries = res.data;
  if (!Array.isArray(entries) || entries.length === 0) {
    output.info("No entries to export.");
    return;
  }

  const decrypted: EntryBlob[] = [];

  for (const entry of entries) {
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
      decrypted.push(JSON.parse(plaintext));
    } catch {
      decrypted.push({ title: "(decryption failed)" });
    }
  }

  if (format === "json") {
    const out = JSON.stringify(decrypted, null, 2);
    if (options.output) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(options.output, out, "utf-8");
      output.success(`Exported ${decrypted.length} entries to ${options.output}`);
    } else {
      console.log(out);
    }
  } else {
    const headers = ["title", "username", "password", "url", "notes", "totp"];
    const csvRows = [headers.join(",")];
    for (const entry of decrypted) {
      csvRows.push(
        headers.map((h) => escapeCSV(String(entry[h] ?? ""))).join(","),
      );
    }
    const csvOut = csvRows.join("\n");

    if (options.output) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(options.output, csvOut, "utf-8");
      output.success(`Exported ${decrypted.length} entries to ${options.output}`);
    } else {
      console.log(csvOut);
    }
  }
}
