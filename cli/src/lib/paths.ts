/**
 * XDG Base Directory compliant path resolution.
 *
 * Config:  $XDG_CONFIG_HOME/passwd-sso/  (default: ~/.config/passwd-sso/)
 * Data:    $XDG_DATA_HOME/passwd-sso/    (default: ~/.local/share/passwd-sso/)
 * Legacy:  ~/.passwd-sso/                (auto-migrated on first access)
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const APP_NAME = "passwd-sso";

/** Resolve config directory (lazy — reads env at call time). */
export function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const base =
    xdgConfig && isAbsolute(xdgConfig)
      ? xdgConfig
      : join(homedir(), ".config");
  return join(base, APP_NAME);
}

/** Resolve data directory (lazy — reads env at call time). */
export function getDataDir(): string {
  const xdgData = process.env.XDG_DATA_HOME;
  const base =
    xdgData && isAbsolute(xdgData)
      ? xdgData
      : join(homedir(), ".local", "share");
  return join(base, APP_NAME);
}

/** Legacy directory path (for migration detection). */
export function getLegacyDir(): string {
  return join(homedir(), `.${APP_NAME}`);
}

/** Full path to config.json. */
export function getConfigFilePath(): string {
  return join(getConfigDir(), "config.json");
}

/** Full path to credentials file. */
export function getCredentialsFilePath(): string {
  return join(getDataDir(), "credentials");
}
