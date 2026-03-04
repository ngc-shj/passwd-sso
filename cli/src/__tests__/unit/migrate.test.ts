import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const origEnv = { ...process.env };
let testHome: string;

describe("migrate", () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "psso-migrate-"));
    vi.resetModules();

    // Point XDG dirs to test locations
    process.env.XDG_CONFIG_HOME = join(testHome, ".config");
    process.env.XDG_DATA_HOME = join(testHome, ".local", "share");

    // Mock homedir for legacy path detection
    vi.mock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => testHome };
    });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  it("migrates config.json to XDG_CONFIG_HOME", async () => {
    const legacyDir = join(testHome, ".passwd-sso");
    mkdirSync(legacyDir, { mode: 0o700 });
    writeFileSync(join(legacyDir, "config.json"), '{"serverUrl":"https://x.com"}');

    const { migrateIfNeeded, _resetMigrationState } = await import("../../lib/migrate.js");
    _resetMigrationState();
    migrateIfNeeded();

    const target = join(testHome, ".config", "passwd-sso", "config.json");
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf-8")).serverUrl).toBe("https://x.com");
    // Legacy dir should be removed (was empty after migration)
    expect(existsSync(legacyDir)).toBe(false);
  });

  it("migrates credentials to XDG_DATA_HOME", async () => {
    const legacyDir = join(testHome, ".passwd-sso");
    mkdirSync(legacyDir, { mode: 0o700 });
    writeFileSync(join(legacyDir, "credentials"), "secret-token");

    const { migrateIfNeeded, _resetMigrationState } = await import("../../lib/migrate.js");
    _resetMigrationState();
    migrateIfNeeded();

    const target = join(testHome, ".local", "share", "passwd-sso", "credentials");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("secret-token");
  });

  it("does not overwrite existing XDG files", async () => {
    const legacyDir = join(testHome, ".passwd-sso");
    mkdirSync(legacyDir, { mode: 0o700 });
    writeFileSync(join(legacyDir, "config.json"), '{"serverUrl":"old"}');

    // Pre-existing XDG file
    const xdgConfigDir = join(testHome, ".config", "passwd-sso");
    mkdirSync(xdgConfigDir, { recursive: true });
    writeFileSync(join(xdgConfigDir, "config.json"), '{"serverUrl":"new"}');

    const { migrateIfNeeded, _resetMigrationState } = await import("../../lib/migrate.js");
    _resetMigrationState();
    migrateIfNeeded();

    expect(
      JSON.parse(readFileSync(join(xdgConfigDir, "config.json"), "utf-8")).serverUrl,
    ).toBe("new");
  });

  it("skips migration if legacy dir is a symlink", async () => {
    const realDir = join(testHome, "real-dir");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "config.json"), '{"serverUrl":"trap"}');
    symlinkSync(realDir, join(testHome, ".passwd-sso"));

    const { migrateIfNeeded, _resetMigrationState } = await import("../../lib/migrate.js");
    _resetMigrationState();
    migrateIfNeeded();

    const target = join(testHome, ".config", "passwd-sso", "config.json");
    expect(existsSync(target)).toBe(false);
  });

  it("preserves legacy dir if non-empty after migration", async () => {
    const legacyDir = join(testHome, ".passwd-sso");
    mkdirSync(legacyDir, { mode: 0o700 });
    writeFileSync(join(legacyDir, "config.json"), '{"serverUrl":"x"}');
    writeFileSync(join(legacyDir, "custom-file.txt"), "user data");

    const { migrateIfNeeded, _resetMigrationState } = await import("../../lib/migrate.js");
    _resetMigrationState();
    migrateIfNeeded();

    // Legacy dir kept because custom-file.txt remains
    expect(existsSync(legacyDir)).toBe(true);
    expect(existsSync(join(legacyDir, "custom-file.txt"))).toBe(true);
    // config.json was migrated out
    expect(existsSync(join(legacyDir, "config.json"))).toBe(false);
  });

  it("is idempotent (second call is a no-op)", async () => {
    const legacyDir = join(testHome, ".passwd-sso");
    mkdirSync(legacyDir, { mode: 0o700 });
    writeFileSync(join(legacyDir, "config.json"), '{"serverUrl":"x"}');

    const { migrateIfNeeded, _resetMigrationState } = await import("../../lib/migrate.js");
    _resetMigrationState();
    migrateIfNeeded();
    // Second call should not throw even though legacy is gone
    migrateIfNeeded();

    const target = join(testHome, ".config", "passwd-sso", "config.json");
    expect(existsSync(target)).toBe(true);
  });
});
