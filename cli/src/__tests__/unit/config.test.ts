import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
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
const { loadConfig, saveConfig } = await import("../../lib/config.js");
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
