import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---
vi.mock("../../commands/unlock.js", () => ({
  readPassphrase: vi.fn(),
  unlockWithPassphrase: vi.fn(),
}));

vi.mock("../../lib/vault-state.js", () => ({
  getEncryptionKey: vi.fn(),
  getUserId: vi.fn(),
  getSecretKeyBytes: vi.fn(),
  setEncryptionKey: vi.fn(),
  isUnlocked: vi.fn(),
}));

vi.mock("../../lib/api-client.js", () => ({
  apiRequest: vi.fn(),
  startBackgroundRefresh: vi.fn(),
}));

vi.mock("../../lib/crypto.js", () => ({
  decryptData: vi.fn(),
  hexEncode: vi.fn(),
  hexDecode: vi.fn(),
  deriveEncryptionKey: vi.fn(),
}));

vi.mock("../../lib/output.js", () => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

// Mock fs and net to prevent actual socket/file operations
vi.mock("node:net", () => ({
  createServer: vi.fn(() => ({
    listen: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  lstatSync: vi.fn(() => ({
    isDirectory: () => true,
    uid: process.getuid?.() ?? 1000,
  })),
  chmodSync: vi.fn(),
  unlinkSync: vi.fn(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const { readPassphrase, unlockWithPassphrase } = await import(
  "../../commands/unlock.js"
);
const { decryptAgentCommand } = await import("../../commands/agent-decrypt.js");

describe("decryptAgentCommand", () => {
  let stderrOutput: string;
  let exitCode: number | undefined;
  let originalPlatform: PropertyDescriptor | undefined;
  let originalIsTTY: PropertyDescriptor | undefined;

  beforeEach(() => {
    stderrOutput = "";
    exitCode = undefined;
    vi.clearAllMocks();

    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrOutput += String(msg);
      return true;
    });

    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    });

    // Save original descriptors
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    }
    // Clean up daemon env
    delete process.env._PSSO_DAEMON;
    delete process.env.XDG_RUNTIME_DIR;
  });

  it("exits with error on Windows", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    await expect(decryptAgentCommand({})).rejects.toThrow("process.exit(1)");
    expect(stderrOutput).toContain("not supported on Windows");
    expect(exitCode).toBe(1);
  });

  it("exits when no TTY available", async () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";

    await expect(decryptAgentCommand({})).rejects.toThrow("process.exit(1)");
    expect(stderrOutput).toContain("No TTY available");
    expect(exitCode).toBe(1);
  });

  it("exits when empty passphrase is entered", async () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";

    vi.mocked(readPassphrase).mockResolvedValue("");

    await expect(decryptAgentCommand({})).rejects.toThrow("process.exit(1)");
    expect(stderrOutput).toContain("Passphrase is required");
    expect(exitCode).toBe(1);
  });

  it("exits when unlockWithPassphrase fails", async () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";

    vi.mocked(readPassphrase).mockResolvedValue("wrong-pass");
    vi.mocked(unlockWithPassphrase).mockResolvedValue(false);

    await expect(decryptAgentCommand({})).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });
});
