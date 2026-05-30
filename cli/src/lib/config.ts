/**
 * Configuration management for the CLI tool.
 *
 * Config file:  $XDG_CONFIG_HOME/passwd-sso/config.json
 * Credentials:  $XDG_DATA_HOME/passwd-sso/credentials  (mode 0o600, JSON)
 *
 * Legacy ~/.passwd-sso/ is auto-migrated on first access.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import {
  getConfigDir,
  getDataDir,
  getConfigFilePath,
  getCredentialsFilePath,
} from "./paths.js";
import { writeSecretFile, readSecretFile } from "./secure-file.js";
import { migrateIfNeeded } from "./migrate.js";

export interface CliConfig {
  serverUrl: string;
  locale: string;
}

const DEFAULT_CONFIG: CliConfig = {
  serverUrl: "",
  locale: "en",
};

function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
  }
}

function ensureDataDir(): void {
  const dir = getDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
  }
}

export function loadConfig(): CliConfig {
  migrateIfNeeded();
  try {
    const raw = readFileSync(getConfigFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: CliConfig): void {
  ensureConfigDir();
  writeFileSync(getConfigFilePath(), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

// ─── Credential Storage ───────────────────────────────────────────────────────

export interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  expiresAt: string; // ISO 8601
}

/**
 * Write credentials to the data directory using O_NOFOLLOW to prevent
 * symlink attacks. File is created with mode 0o600 (owner read/write only).
 */
export function saveCredentials(creds: StoredCredentials): void {
  ensureDataDir();
  const dataDir = getDataDir();
  if (lstatSync(dataDir).isSymbolicLink()) {
    throw new Error("Data directory is a symlink — refusing to write credentials.");
  }
  writeSecretFile(getCredentialsFilePath(), JSON.stringify(creds));
}

/**
 * Load stored credentials. Returns null if the file does not exist,
 * cannot be parsed as JSON, or is missing required fields (e.g. legacy
 * plaintext token format written by older CLI versions).
 */
export function loadCredentials(): StoredCredentials | null {
  migrateIfNeeded();
  try {
    // Mirror saveCredentials' symlink hardening on the read side: refuse a
    // symlinked data dir, and open the file with O_NOFOLLOW so a pre-planted
    // symlink at the credentials path cannot redirect the read elsewhere.
    const dataDir = getDataDir();
    if (existsSync(dataDir) && lstatSync(dataDir).isSymbolicLink()) {
      return null;
    }
    const raw = readSecretFile(getCredentialsFilePath()).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Legacy plaintext token — prompt user to re-login
      return null;
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.accessToken !== "string" ||
      typeof obj.refreshToken !== "string" ||
      typeof obj.clientId !== "string" ||
      typeof obj.expiresAt !== "string"
    ) {
      return null;
    }

    return {
      accessToken: obj.accessToken,
      refreshToken: obj.refreshToken,
      clientId: obj.clientId,
      expiresAt: obj.expiresAt,
    };
  } catch {
    return null;
  }
}

/** Remove the stored credentials file. Silently ignores missing-file errors. */
export function deleteCredentials(): void {
  try {
    unlinkSync(getCredentialsFilePath());
  } catch {
    // file may not exist
  }
}
