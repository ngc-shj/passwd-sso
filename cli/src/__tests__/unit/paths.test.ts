import { describe, it, expect, vi, afterEach } from "vitest";

const origEnv = { ...process.env };

describe("paths", () => {
  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("uses XDG_CONFIG_HOME when set", async () => {
    vi.resetModules();
    process.env.XDG_CONFIG_HOME = "/tmp/test-xdg-config";
    const { getConfigDir } = await import("../../lib/paths.js");
    expect(getConfigDir()).toBe("/tmp/test-xdg-config/passwd-sso");
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME unset", async () => {
    vi.resetModules();
    delete process.env.XDG_CONFIG_HOME;
    vi.mock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => "/home/testuser" };
    });
    const { getConfigDir } = await import("../../lib/paths.js");
    expect(getConfigDir()).toBe("/home/testuser/.config/passwd-sso");
  });

  it("falls back to default when XDG_CONFIG_HOME is relative", async () => {
    vi.resetModules();
    process.env.XDG_CONFIG_HOME = "relative/path";
    vi.mock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => "/home/testuser" };
    });
    const { getConfigDir } = await import("../../lib/paths.js");
    expect(getConfigDir()).toBe("/home/testuser/.config/passwd-sso");
  });

  it("uses XDG_DATA_HOME when set", async () => {
    vi.resetModules();
    process.env.XDG_DATA_HOME = "/tmp/test-xdg-data";
    const { getDataDir } = await import("../../lib/paths.js");
    expect(getDataDir()).toBe("/tmp/test-xdg-data/passwd-sso");
  });

  it("falls back to ~/.local/share when XDG_DATA_HOME unset", async () => {
    vi.resetModules();
    delete process.env.XDG_DATA_HOME;
    vi.mock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => "/home/testuser" };
    });
    const { getDataDir } = await import("../../lib/paths.js");
    expect(getDataDir()).toBe("/home/testuser/.local/share/passwd-sso");
  });

  it("returns legacy dir under homedir", async () => {
    vi.resetModules();
    vi.mock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => "/home/testuser" };
    });
    const { getLegacyDir } = await import("../../lib/paths.js");
    expect(getLegacyDir()).toBe("/home/testuser/.passwd-sso");
  });
});
