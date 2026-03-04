import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Override the config dir for testing
const testDir = mkdtempSync(join(tmpdir(), "psso-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => testDir,
  };
});

// Must import AFTER mock is set up
const { loadConfig, saveConfig } = await import("../../lib/config.js");

describe("config", () => {
  afterEach(() => {
    try {
      rmSync(join(testDir, ".passwd-sso"), { recursive: true, force: true });
    } catch {
      // ok
    }
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig();
    expect(config.serverUrl).toBe("");
    expect(config.locale).toBe("en");
  });

  it("saves and loads config", () => {
    saveConfig({ serverUrl: "https://example.com", locale: "ja" });
    const config = loadConfig();
    expect(config.serverUrl).toBe("https://example.com");
    expect(config.locale).toBe("ja");
  });

  it("creates config file with restricted permissions", () => {
    saveConfig({ serverUrl: "https://test.com", locale: "en" });
    const configPath = join(testDir, ".passwd-sso", "config.json");
    const content = readFileSync(configPath, "utf-8");
    expect(JSON.parse(content).serverUrl).toBe("https://test.com");
    const stat = statSync(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
