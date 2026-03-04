/**
 * Configuration management for the CLI tool.
 *
 * Config file: ~/.passwd-sso/config.json (non-sensitive settings only)
 * Credentials: OS keychain (via keytar) or ~/.passwd-sso/credentials (fallback)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".passwd-sso");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials");

const KEYCHAIN_SERVICE = "passwd-sso-cli";
const KEYCHAIN_ACCOUNT = "bearer-token";

export interface CliConfig {
  serverUrl: string;
  locale: string;
}

const DEFAULT_CONFIG: CliConfig = {
  serverUrl: "",
  locale: "en",
};

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

export function loadConfig(): CliConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: CliConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ─── Credential Storage ───────────────────────────────────────

async function tryKeytar(): Promise<typeof import("keytar") | null> {
  if (process.env.PSSO_NO_KEYCHAIN === "1") return null;
  try {
    return await import("keytar");
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

  // File fallback
  ensureConfigDir();
  // Verify config dir is not a symlink
  const stat = lstatSync(CONFIG_DIR);
  if (stat.isSymbolicLink()) {
    throw new Error("Config directory is a symlink — refusing to write credentials.");
  }
  writeFileSync(CREDENTIALS_FILE, token, { mode: 0o600 });
  return "file";
}

export async function loadToken(): Promise<string | null> {
  const kt = await tryKeytar();
  if (kt) {
    const token = await kt.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (token) return token;
  }

  // File fallback
  try {
    return readFileSync(CREDENTIALS_FILE, "utf-8").trim();
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
    unlinkSync(CREDENTIALS_FILE);
  } catch {
    // file may not exist
  }
}
