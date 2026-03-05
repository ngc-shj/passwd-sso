/**
 * `passwd-sso run` — Inject vault secrets into a command's environment.
 *
 * Uses child_process.execFile (NOT shell) for security.
 * Blocks certain dangerous env var names from being overwritten.
 */

import { execFile } from "node:child_process";
import { loadSecretsConfig, getPasswordPath } from "../lib/secrets-config.js";
import { getEncryptionKey, getUserId, isUnlocked } from "../lib/vault-state.js";
import { getToken } from "../lib/api-client.js";
import { decryptData } from "../lib/crypto.js";
import { buildPersonalEntryAAD } from "../lib/crypto-aad.js";
import * as output from "../lib/output.js";

/** Env vars that must never be overwritten (case-insensitive) */
const BLOCKED_KEYS = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS",
  "NODE_PATH",
]);

interface RunOptions {
  config?: string;
  command: string[];
}

export async function runCommand(opts: RunOptions): Promise<void> {
  if (opts.command.length === 0) {
    throw new Error("No command specified. Usage: passwd-sso run -- <command>");
  }

  const config = loadSecretsConfig(opts.config);
  const useV1 = !!config.apiKey;
  const baseUrl = config.server.replace(/\/$/, "");

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

  if (!isUnlocked()) {
    throw new Error("Vault is not unlocked. Run `passwd-sso unlock` first, or set PSSO_PASSPHRASE.");
  }

  const encryptionKey = getEncryptionKey()!;
  const userId = getUserId();

  // Resolve secrets
  const secretEnv: Record<string, string> = {};
  const entries = Object.entries(config.secrets);

  for (const [envName, mapping] of entries) {
    // Block dangerous keys
    if (BLOCKED_KEYS.has(envName.toUpperCase())) {
      output.error(`Blocked: cannot inject '${envName}' (security restriction)`);
      process.exit(1);
    }

    const path = getPasswordPath(mapping.entry, useV1);
    const url = `${baseUrl}${path}`;

    const res = await fetch(url, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) {
      output.error(`Failed to fetch entry ${mapping.entry}: HTTP ${res.status}`);
      process.exit(1);
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
      output.error(`Field '${mapping.field}' not found in entry ${mapping.entry}`);
      process.exit(1);
    }

    secretEnv[envName] = String(value);
  }

  // Execute command with injected env vars (shell-free)
  const [cmd, ...args] = opts.command;
  const child = execFile(cmd, args, {
    env: { ...process.env, ...secretEnv },
    stdio: "inherit",
    maxBuffer: 10 * 1024 * 1024,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });

  child.on("error", (err) => {
    output.error(`Failed to execute: ${err.message}`);
    process.exit(1);
  });
}
