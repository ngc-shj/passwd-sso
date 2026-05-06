import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/secrets-config.js", () => ({
  loadSecretsConfig: vi.fn(),
  getSecretsServerUrl: vi.fn(),
  getPasswordPath: vi.fn(),
}));

vi.mock("../../lib/api-client.js", () => ({
  getToken: vi.fn(),
}));

vi.mock("../../commands/unlock.js", () => ({
  autoUnlockIfNeeded: vi.fn(),
}));

vi.mock("../../lib/vault-state.js", () => ({
  getEncryptionKey: vi.fn(),
  getUserId: vi.fn(),
}));

vi.mock("../../lib/output.js", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  table: vi.fn(),
  json: vi.fn(),
  masked: vi.fn(),
}));

const { loadSecretsConfig, getSecretsServerUrl } = await import("../../lib/secrets-config.js");
const { getToken } = await import("../../lib/api-client.js");
const { autoUnlockIfNeeded } = await import("../../commands/unlock.js");
const output = await import("../../lib/output.js");
const { runCommand } = await import("../../commands/run.js");

describe("runCommand", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let exitCode: number | undefined;

  beforeEach(() => {
    exitCode = undefined;
    vi.mocked(loadSecretsConfig).mockReset();
    vi.mocked(getSecretsServerUrl).mockReset();
    vi.mocked(getToken).mockReset();
    vi.mocked(autoUnlockIfNeeded).mockReset();
    vi.mocked(output.error).mockReset();

    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("exits with code 1 when no command is supplied", async () => {
    await expect(runCommand({ command: [] })).rejects.toThrow();

    expect(exitCode).toBe(1);
    expect(vi.mocked(output.error)).toHaveBeenCalledWith(
      expect.stringContaining("No command specified"),
    );
  });

  it("exits with code 1 when loadSecretsConfig throws", async () => {
    vi.mocked(loadSecretsConfig).mockImplementation(() => {
      throw new Error("placeholder entry ID");
    });

    await expect(runCommand({ command: ["true"] })).rejects.toThrow();

    expect(exitCode).toBe(1);
    expect(vi.mocked(output.error)).toHaveBeenCalledWith(
      expect.stringContaining("placeholder entry ID"),
    );
  });

  it("exits with code 1 when getSecretsServerUrl throws", async () => {
    vi.mocked(loadSecretsConfig).mockReturnValue({
      apiKey: "api_test",
      secrets: {},
    });
    vi.mocked(getSecretsServerUrl).mockImplementation(() => {
      throw new Error("Server URL not configured. Run `passwd-sso login -s <server-url>` once to configure it.");
    });

    await expect(runCommand({ command: ["true"] })).rejects.toThrow();

    expect(exitCode).toBe(1);
    expect(vi.mocked(output.error)).toHaveBeenCalledWith(
      expect.stringContaining("Server URL not configured"),
    );
  });

  it("exits with code 1 when no token and no apiKey", async () => {
    vi.mocked(loadSecretsConfig).mockReturnValue({ secrets: {} });
    vi.mocked(getSecretsServerUrl).mockReturnValue("https://example.com");
    vi.mocked(getToken).mockResolvedValue(null);

    await expect(runCommand({ command: ["true"] })).rejects.toThrow();

    expect(vi.mocked(getToken)).toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(vi.mocked(output.error)).toHaveBeenCalledWith(
      expect.stringContaining("Not logged in"),
    );
  });

  it("exits with code 1 when vault is not unlocked", async () => {
    vi.mocked(loadSecretsConfig).mockReturnValue({
      apiKey: "api_test",
      secrets: {},
    });
    vi.mocked(getSecretsServerUrl).mockReturnValue("https://example.com");
    vi.mocked(autoUnlockIfNeeded).mockResolvedValue(false);

    await expect(runCommand({ command: ["true"] })).rejects.toThrow();

    expect(vi.mocked(autoUnlockIfNeeded)).toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(vi.mocked(output.error)).toHaveBeenCalledWith(
      expect.stringContaining("Vault is not unlocked"),
    );
  });
});
