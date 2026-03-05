/**
 * `passwd-sso env` — Output vault secrets as environment variables.
 *
 * Reads .passwd-sso-env.json, fetches & decrypts entries, then outputs
 * env vars in the requested format (shell, dotenv, json).
 *
 * Requires the vault to be unlocked (encryption key in memory) OR
 * an apiKey + PSSO_PASSPHRASE env var for non-interactive mode.
 */

import { loadSecretsConfig, getPasswordPath } from "../lib/secrets-config.js";
import { getEncryptionKey, getUserId, isUnlocked } from "../lib/vault-state.js";
import { getToken } from "../lib/api-client.js";
import { loadConfig } from "../lib/config.js";
import { decryptData } from "../lib/crypto.js";
import { buildPersonalEntryAAD } from "../lib/crypto-aad.js";
import * as output from "../lib/output.js";

interface EnvOptions {
  config?: string;
  format: string;
}

export async function envCommand(opts: EnvOptions): Promise<void> {
  const config = loadSecretsConfig(opts.config);
  const useV1 = !!config.apiKey;
  const baseUrl = config.server.replace(/\/$/, "");

  // Determine auth header
  let authHeader: string;
  if (config.apiKey) {
    authHeader = `Bearer ${config.apiKey}`;
  } else {
    const token = await getToken();
    if (!token) {
      throw new Error("Not logged in. Run `passwd-sso login` first, or set apiKey in config.");
    }
    authHeader = `Bearer ${token}`;
  }

  // Check vault unlock
  if (!isUnlocked()) {
    throw new Error("Vault is not unlocked. Run `passwd-sso unlock` first, or set PSSO_PASSPHRASE.");
  }

  const encryptionKey = getEncryptionKey()!;
  const userId = getUserId();

  const result: Record<string, string> = {};
  const entries = Object.entries(config.secrets);

  for (const [envName, mapping] of entries) {
    const path = getPasswordPath(mapping.entry, useV1);
    const url = `${baseUrl}${path}`;

    const res = await fetch(url, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) {
      output.error(`Failed to fetch entry ${mapping.entry}: HTTP ${res.status}`);
      continue;
    }

    const data = (await res.json()) as {
      encryptedBlob: { ciphertext: string; iv: string; authTag: string };
      aadVersion?: number;
      id: string;
    };

    let additionalData: Uint8Array | undefined;
    if (data.aadVersion && data.aadVersion >= 1 && userId) {
      additionalData = buildPersonalEntryAAD(userId, data.id);
    }

    const decrypted = await decryptData(
      encryptionKey,
      data.encryptedBlob,
      additionalData,
    );

    const blob = JSON.parse(decrypted) as Record<string, unknown>;
    const value = blob[mapping.field];

    if (value === undefined || value === null) {
      output.warn(`Field '${mapping.field}' not found in entry ${mapping.entry}`);
      continue;
    }

    result[envName] = String(value);
  }

  // Output
  switch (opts.format) {
    case "json":
      console.log(JSON.stringify(result, null, 2));
      break;
    case "dotenv":
      for (const [k, v] of Object.entries(result)) {
        console.log(`${k}=${shellEscape(v)}`);
      }
      break;
    case "shell":
    default:
      for (const [k, v] of Object.entries(result)) {
        console.log(`export ${k}=${shellEscape(v)}`);
      }
      break;
  }
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9._\-/:@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
