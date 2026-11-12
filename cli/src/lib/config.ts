/**
 * Configuration management for the CLI tool.
 *
 * Config file:  $XDG_CONFIG_HOME/passwd-sso/config.json
 * Credentials:  $XDG_DATA_HOME/passwd-sso/credentials  (mode 0o600, JSON)
 *
 * Legacy ~/.passwd-sso/ is auto-migrated on first access.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
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
import { validateServerUrl } from "./oauth.js";

export interface CliConfig {
  serverUrl: string;
  locale: string;
}

const DEFAULT_CONFIG: CliConfig = {
  serverUrl: "",
  locale: "en",
};

/**
 * Create `dir` 0700, or tighten it to 0700 if it already exists: mkdirSync's
 * mode applies only to a freshly created directory. A symlink is left alone
 * (callers refuse to write through one).
 */
function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
    return;
  }
  if (!lstatSync(dir).isSymbolicLink()) {
    chmodSync(dir, 0o700);
  }
}

function ensureConfigDir(): void {
  ensurePrivateDir(getConfigDir());
}

function ensureDataDir(): void {
  ensurePrivateDir(getDataDir());
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
  writeSecretFile(getConfigFilePath(), JSON.stringify(config, null, 2));
}

// ─── Credential Storage ───────────────────────────────────────────────────────

export interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  expiresAt: string; // ISO 8601
  /**
   * The server that issued these tokens (normalised, no trailing slash). Every
   * request carrying them goes here, never to the configured serverUrl, which
   * `login` rewrites before the old tokens are revoked.
   */
  serverUrl: string;
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
 * plaintext token format written by older CLI versions, or credentials
 * saved before the issuing serverUrl was recorded — those must re-login
 * rather than have their tokens sent to whatever server is configured now).
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
      typeof obj.expiresAt !== "string" ||
      typeof obj.serverUrl !== "string" ||
      obj.serverUrl === ""
    ) {
      return null;
    }
    // The tokens are sent to this URL; a hand-edited file must not redirect
    // them to a non-https or credential-bearing URL.
    validateServerUrl(obj.serverUrl);

    return {
      accessToken: obj.accessToken,
      refreshToken: obj.refreshToken,
      clientId: obj.clientId,
      expiresAt: obj.expiresAt,
      // Callers append `/api/...`; `login` writes it without the slash, but a
      // hand-edited file may carry one.
      serverUrl: obj.serverUrl.replace(/\/$/, ""),
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
