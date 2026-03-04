/**
 * Auto-migration from legacy ~/.passwd-sso/ to XDG directories.
 *
 * Called once on first access. Idempotent — safe to call multiple times.
 */

import {
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { getLegacyDir, getConfigDir, getDataDir } from "./paths.js";

let migrationDone = false;

/**
 * Move a single file from `src` to `dest`, creating `destDir` if needed.
 * Handles cross-device moves (EXDEV) by falling back to copy + delete.
 */
function moveFile(src: string, dest: string, destDir: string): boolean {
  try {
    mkdirSync(destDir, { mode: 0o700, recursive: true });
    renameSync(src, dest);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      try {
        copyFileSync(src, dest);
        chmodSync(dest, 0o600);
        unlinkSync(src);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function migrateIfNeeded(): void {
  if (migrationDone) return;
  migrationDone = true;

  const legacyDir = getLegacyDir();
  if (!existsSync(legacyDir)) return;

  // Safety: refuse to follow symlinks
  const stat = lstatSync(legacyDir);
  if (stat.isSymbolicLink()) return;

  const legacyConfig = join(legacyDir, "config.json");
  const legacyCredentials = join(legacyDir, "credentials");
  let migratedAny = false;

  // Migrate config.json → XDG_CONFIG_HOME/passwd-sso/config.json
  if (existsSync(legacyConfig)) {
    const configDir = getConfigDir();
    const target = join(configDir, "config.json");
    if (!existsSync(target)) {
      if (moveFile(legacyConfig, target, configDir)) {
        migratedAny = true;
      }
    }
  }

  // Migrate credentials → XDG_DATA_HOME/passwd-sso/credentials
  if (existsSync(legacyCredentials)) {
    const dataDir = getDataDir();
    const target = join(dataDir, "credentials");
    if (!existsSync(target)) {
      if (moveFile(legacyCredentials, target, dataDir)) {
        migratedAny = true;
      }
    }
  }

  // Remove legacy directory if empty
  if (migratedAny) {
    try {
      const remaining = readdirSync(legacyDir);
      if (remaining.length === 0) {
        rmSync(legacyDir, { recursive: true });
      }
    } catch {
      // Best effort — leave it if removal fails
    }

    console.error(
      `[passwd-sso] Migrated config to XDG directories. Config: ${getConfigDir()}, Data: ${getDataDir()}`,
    );
  }
}

/** Reset migration state (for testing only). */
export function _resetMigrationState(): void {
  migrationDone = false;
}
