import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  statSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testHome: string;

// Mock homedir for legacy path detection; read lazily so each test's testHome applies
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

describe("migrate", () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "psso-migrate-"));
    vi.resetModules();

    // Point XDG dirs to test locations
    vi.stubEnv("XDG_CONFIG_HOME", join(testHome, ".config"));
    vi.stubEnv("XDG_DATA_HOME", join(testHome, ".local", "share"));
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
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

  it("migrated legacy files with 0644 end up 0600", async () => {
    const legacyDir = join(testHome, ".passwd-sso");
    mkdirSync(legacyDir, { mode: 0o700 });
    for (const name of ["config.json", "credentials"]) {
      const p = join(legacyDir, name);
      writeFileSync(p, "{}", { mode: 0o644 });
      chmodSync(p, 0o644);
    }

    const { migrateIfNeeded, _resetMigrationState } = await import("../../lib/migrate.js");
    _resetMigrationState();
    migrateIfNeeded();

    const config = join(testHome, ".config", "passwd-sso", "config.json");
    const creds = join(testHome, ".local", "share", "passwd-sso", "credentials");
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(statSync(creds).mode & 0o777).toBe(0o600);
  });

  it("leaves a legacy file in place, not moved at its old mode, when tightening it fails", async () => {
    const legacyDir = join(testHome, ".passwd-sso");
    mkdirSync(legacyDir, { mode: 0o700 });
    const legacyCreds = join(legacyDir, "credentials");
    writeFileSync(legacyCreds, "{}", { mode: 0o644 });
    chmodSync(legacyCreds, 0o644);

    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        fchmodSync: () => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      };
    });
    try {
      const { migrateIfNeeded, _resetMigrationState } = await import("../../lib/migrate.js");
      _resetMigrationState();
      migrateIfNeeded();
    } finally {
      vi.doUnmock("node:fs");
    }

    expect(existsSync(join(testHome, ".local", "share", "passwd-sso", "credentials"))).toBe(false);
    expect(existsSync(legacyCreds)).toBe(true);
  });

  it("does not follow a symlinked legacy file: the link target's mode is untouched and nothing is migrated", async () => {
    const legacyDir = join(testHome, ".passwd-sso");
    mkdirSync(legacyDir, { mode: 0o700 });
    const outside = join(testHome, "outside-target");
    writeFileSync(outside, "not ours");
    chmodSync(outside, 0o644);
    symlinkSync(outside, join(legacyDir, "credentials"));

    const { migrateIfNeeded, _resetMigrationState } = await import("../../lib/migrate.js");
    _resetMigrationState();
    migrateIfNeeded();

    expect(statSync(outside).mode & 0o777).toBe(0o644);
    expect(existsSync(join(testHome, ".local", "share", "passwd-sso", "credentials"))).toBe(false);
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
