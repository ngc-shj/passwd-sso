/**
 * Configuration management for the CLI tool.
 *
 * Config file: $XDG_CONFIG_HOME/passwd-sso/config.json
 * Credentials: OS keychain (via keytar) or $XDG_DATA_HOME/passwd-sso/credentials
 *
 * Legacy ~/.passwd-sso/ is auto-migrated on first access.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, openSync, writeSync, closeSync, constants as fsConstants } from "node:fs";
import {
  getConfigDir,
  getDataDir,
  getConfigFilePath,
  getCredentialsFilePath,
} from "./paths.js";
import { migrateIfNeeded } from "./migrate.js";

const KEYCHAIN_SERVICE = "passwd-sso-cli";
const KEYCHAIN_ACCOUNT = "bearer-token";

export interface CliConfig {
  serverUrl: string;
  locale: string;
  tokenExpiresAt?: string; // ISO 8601
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
  writeFileSync(getConfigFilePath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ─── Credential Storage ───────────────────────────────────────

async function tryKeytar(): Promise<typeof import("keytar") | null> {
  if (process.env.PSSO_NO_KEYCHAIN === "1") return null;
  try {
    const mod = await import("keytar");
    // Dynamic import may wrap the CJS module in { default: ... }
    return (mod.default ?? mod) as typeof import("keytar");
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<"keychain" | "file"> {
  const kt = await tryKeytar();
  if (kt) {
    await kt.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token);
    return "keychain";
  }

  // File fallback — use O_NOFOLLOW to prevent symlink attacks (TOCTOU-safe)
  ensureDataDir();
  const dataDir = getDataDir();
  const stat = lstatSync(dataDir);
  if (stat.isSymbolicLink()) {
    throw new Error("Data directory is a symlink — refusing to write credentials.");
  }
  const credPath = getCredentialsFilePath();
  const fd = openSync(
    credPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return "file";
}

export async function loadToken(): Promise<string | null> {
  migrateIfNeeded();
  const kt = await tryKeytar();
  if (kt) {
    const token = await kt.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (token) return token;
  }

  // File fallback
  try {
    return readFileSync(getCredentialsFilePath(), "utf-8").trim();
  } catch {
    return null;
  }
}

export async function deleteToken(): Promise<void> {
  const kt = await tryKeytar();
  if (kt) {
    await kt.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  }
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(getCredentialsFilePath());
  } catch {
    // file may not exist
  }
}
