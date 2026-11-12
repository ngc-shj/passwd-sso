import { describe, it, expect, vi, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MS_PER_HOUR } from "../../lib/time.js";

// Override dirs for testing
const testDir = mkdtempSync(join(tmpdir(), "psso-test-"));
const testXdgConfig = join(testDir, "xdg-config");
const testXdgData = join(testDir, "xdg-data");

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

// paths.ts reads XDG_* on every call; unstubEnvs restores them after each test.
beforeEach(() => {
  vi.stubEnv("XDG_CONFIG_HOME", testXdgConfig);
  vi.stubEnv("XDG_DATA_HOME", testXdgData);
});

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

  it("saveConfig tightens a pre-existing 0644 config.json to 0600", () => {
    const dir = join(testXdgConfig, "passwd-sso");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, "{}", { mode: 0o644 });
    chmodSync(configPath, 0o644);

    saveConfig({ serverUrl: "https://example.com", locale: "en" });

    expect(JSON.parse(readFileSync(configPath, "utf-8")).serverUrl).toBe("https://example.com");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("saveConfig tightens a pre-existing 0755 config dir to 0700", () => {
    const dir = join(testXdgConfig, "passwd-sso");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);

    saveConfig({ serverUrl: "https://example.com", locale: "en" });

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("saveCredentials tightens a pre-existing 0755 data dir to 0700 and 0644 file to 0600", () => {
    const credPath = getCredentialsFilePath();
    const dir = join(credPath, "..");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    writeFileSync(credPath, "x", { mode: 0o644 });
    chmodSync(credPath, 0o644);

    saveCredentials({
      accessToken: "a",
      refreshToken: "r",
      clientId: "c",
      expiresAt: new Date(Date.now() + MS_PER_HOUR).toISOString(),
      serverUrl: "https://issuer.example.com",
    });

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(credPath).mode & 0o777).toBe(0o600);
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
    expiresAt: new Date(Date.now() + MS_PER_HOUR).toISOString(),
    serverUrl: "https://issuer.example.com",
  };

  function writeRawCreds(obj: unknown): void {
    const credPath = getCredentialsFilePath();
    mkdirSync(join(credPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(credPath, JSON.stringify(obj), { mode: 0o600 });
    _resetMigrationState();
  }

  it("saves and loads credentials with all 5 fields", () => {
    saveCredentials(validCreds);
    _resetMigrationState();
    const loaded = loadCredentials();
    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe(validCreds.accessToken);
    expect(loaded!.refreshToken).toBe(validCreds.refreshToken);
    expect(loaded!.clientId).toBe(validCreds.clientId);
    expect(loaded!.expiresAt).toBe(validCreds.expiresAt);
    expect(loaded!.serverUrl).toBe(validCreds.serverUrl);
  });

  it("returns null for legacy credentials without serverUrl", () => {
    const { serverUrl: _omit, ...legacy } = validCreds;
    writeRawCreds(legacy);
    expect(loadCredentials()).toBeNull();
  });

  it("returns null when serverUrl is empty", () => {
    writeRawCreds({ ...validCreds, serverUrl: "" });
    expect(loadCredentials()).toBeNull();
  });

  it("returns null when serverUrl is non-https and non-loopback", () => {
    writeRawCreds({ ...validCreds, serverUrl: "http://evil.example.com" });
    expect(loadCredentials()).toBeNull();
  });

  it("loads credentials whose serverUrl is loopback http", () => {
    writeRawCreds({ ...validCreds, serverUrl: "http://localhost:3000" });
    expect(loadCredentials()?.serverUrl).toBe("http://localhost:3000");
  });

  it("strips a trailing slash from a hand-edited serverUrl", () => {
    writeRawCreds({ ...validCreds, serverUrl: "https://issuer.example.com/" });
    expect(loadCredentials()?.serverUrl).toBe("https://issuer.example.com");
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
