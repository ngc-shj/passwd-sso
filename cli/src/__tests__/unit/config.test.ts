import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const origEnv = { ...process.env };

// Override dirs for testing
const testDir = mkdtempSync(join(tmpdir(), "psso-test-"));
const testXdgConfig = join(testDir, "xdg-config");
const testXdgData = join(testDir, "xdg-data");

process.env.XDG_CONFIG_HOME = testXdgConfig;
process.env.XDG_DATA_HOME = testXdgData;

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => testDir,
  };
});

// Must import AFTER mock is set up
const { loadConfig, saveConfig, saveCredentials, loadCredentials, deleteCredentials } = await import("../../lib/config.js");
const { getCredentialsFilePath } = await import("../../lib/paths.js");
const { _resetMigrationState } = await import("../../lib/migrate.js");

describe("config", () => {
  afterEach(() => {
    _resetMigrationState();
    try {
      rmSync(testXdgConfig, { recursive: true, force: true });
      rmSync(testXdgData, { recursive: true, force: true });
      rmSync(join(testDir, ".passwd-sso"), { recursive: true, force: true });
    } catch {
      // ok
    }
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    process.env = { ...origEnv };
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig();
    expect(config.serverUrl).toBe("");
    expect(config.locale).toBe("en");
  });

  it("saves and loads config", () => {
    saveConfig({ serverUrl: "https://example.com", locale: "ja" });
    _resetMigrationState();
    const config = loadConfig();
    expect(config.serverUrl).toBe("https://example.com");
    expect(config.locale).toBe("ja");
  });

  it("creates config file with restricted permissions", () => {
    saveConfig({ serverUrl: "https://test.com", locale: "en" });
    const configPath = join(testXdgConfig, "passwd-sso", "config.json");
    const content = readFileSync(configPath, "utf-8");
    expect(JSON.parse(content).serverUrl).toBe("https://test.com");
    const stat = statSync(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("credentials", () => {
  afterEach(() => {
    _resetMigrationState();
    try {
      rmSync(testXdgData, { recursive: true, force: true });
      rmSync(join(testDir, ".passwd-sso"), { recursive: true, force: true });
    } catch {
      // ok
    }
  });

  const validCreds = {
    accessToken: "mcp_test_access",
    refreshToken: "mcpr_test_refresh",
    clientId: "mcpc_test_client",
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  };

  it("saves and loads credentials with all 4 fields", () => {
    saveCredentials(validCreds);
    _resetMigrationState();
    const loaded = loadCredentials();
    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe(validCreds.accessToken);
    expect(loaded!.refreshToken).toBe(validCreds.refreshToken);
    expect(loaded!.clientId).toBe(validCreds.clientId);
    expect(loaded!.expiresAt).toBe(validCreds.expiresAt);
  });

  it("creates credentials file with 0o600 permissions", () => {
    saveCredentials(validCreds);
    const credPath = getCredentialsFilePath();
    const stat = statSync(credPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns null for legacy plaintext token format", () => {
    // Simulate legacy format: write a plain string instead of JSON
    const credPath = getCredentialsFilePath();
    const dir = join(credPath, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(credPath, "some-old-plaintext-token", { mode: 0o600 });
    _resetMigrationState();
    const loaded = loadCredentials();
    expect(loaded).toBeNull();
  });

  it("returns null for JSON missing required fields", () => {
    const credPath = getCredentialsFilePath();
    const dir = join(credPath, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(credPath, JSON.stringify({ accessToken: "tok" }), { mode: 0o600 });
    _resetMigrationState();
    const loaded = loadCredentials();
    expect(loaded).toBeNull();
  });

  it("returns null when credentials file does not exist", () => {
    _resetMigrationState();
    const loaded = loadCredentials();
    expect(loaded).toBeNull();
  });

  it("deleteCredentials removes the file", () => {
    saveCredentials(validCreds);
    deleteCredentials();
    _resetMigrationState();
    const loaded = loadCredentials();
    expect(loaded).toBeNull();
  });

  it("deleteCredentials does not throw when file does not exist", () => {
    expect(() => deleteCredentials()).not.toThrow();
  });
});
