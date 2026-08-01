import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  assertLoggedIn: vi.fn(),
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
const { assertLoggedIn } = await import("../../lib/api-client.js");
const { getSecretKeyBytes, getUserId } = await import("../../lib/vault-state.js");
const { hexEncode } = await import("../../lib/crypto.js");
const { spawn } = await import("node:child_process");
const { decryptAgentCommand, foregroundHintLines } = await import(
  "../../commands/agent-decrypt.js"
);

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
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");

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
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");

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
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");

    vi.mocked(readPassphrase).mockResolvedValue("wrong-pass");
    vi.mocked(unlockWithPassphrase).mockResolvedValue(false);

    await expect(decryptAgentCommand({})).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  describe("shell quoting of the eval-mode output (C3)", () => {
    it("foregroundHintLines quotes an awkward socket path so it round-trips through a real shell", async () => {
      const { execFileSync } = await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
      const socketPath = "/tmp/a'b c.sock";
      const [exportLine] = foregroundHintLines(socketPath);

      const out = execFileSync(
        "/bin/sh",
        ["-c", `${exportLine}; printf '%s' "$PSSO_AGENT_SOCK"`],
        { encoding: "utf-8" },
      );
      expect(out).toBe(socketPath);
    });

    it("daemon-mode eval output for a socket path with a space and a single quote is eval-able and sets $PSSO_AGENT_SOCK exactly", async () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      // XDG_RUNTIME_DIR flows straight into the socket path forkDaemon emits —
      // the awkward characters land there without a separate injection point.
      vi.stubEnv("XDG_RUNTIME_DIR", "/tmp/a'b c");

      vi.mocked(readPassphrase).mockResolvedValue("correct-pass");
      vi.mocked(unlockWithPassphrase).mockResolvedValue(true);
      vi.mocked(getSecretKeyBytes).mockReturnValue(new Uint8Array([1, 2, 3]));
      vi.mocked(getUserId).mockReturnValue("user-1");
      vi.mocked(hexEncode).mockReturnValue("deadbeef");

      const handlers: Record<string, (arg?: unknown) => void> = {};
      const fakeChild = {
        pid: 4242,
        send: vi.fn(),
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          handlers[event] = cb;
        }),
        unref: vi.fn(),
        disconnect: vi.fn(),
        kill: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess);

      let stdout = "";
      const logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
        stdout += String(msg) + "\n";
      });

      try {
        await decryptAgentCommand({ eval: true });

        const socketPath = join("/tmp/a'b c", "passwd-sso", "decrypt.sock");
        expect(() => handlers["message"]()).toThrow("process.exit(0)");

        const { execFileSync } = await vi.importActual<typeof import("node:child_process")>(
          "node:child_process",
        );
        const out = execFileSync("/bin/sh", ["-c", `${stdout}printf '%s' "$PSSO_AGENT_SOCK"`], {
          encoding: "utf-8",
        });
        expect(out).toBe(socketPath);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("firing the emitted trap removes exactly the reported socket and leaves a decoy file intact", async () => {
      const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

      const dir = realFs.mkdtempSync(join(tmpdir(), "psso-decrypt-trap-"));
      const xdgDir = join(dir, "a'b c");
      realFs.mkdirSync(join(xdgDir, "passwd-sso"), { recursive: true });
      vi.stubEnv("XDG_RUNTIME_DIR", xdgDir);

      const socketPath = join(xdgDir, "passwd-sso", "decrypt.sock");
      const decoyPath = join(xdgDir, "passwd-sso", "decoy.txt");
      realFs.writeFileSync(socketPath, "");
      realFs.writeFileSync(decoyPath, "keep me");

      vi.mocked(readPassphrase).mockResolvedValue("correct-pass");
      vi.mocked(unlockWithPassphrase).mockResolvedValue(true);
      vi.mocked(getSecretKeyBytes).mockReturnValue(new Uint8Array([1, 2, 3]));
      vi.mocked(getUserId).mockReturnValue("user-1");
      vi.mocked(hexEncode).mockReturnValue("deadbeef");

      const handlers: Record<string, (arg?: unknown) => void> = {};
      const fakeChild = {
        pid: 4242,
        send: vi.fn(),
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          handlers[event] = cb;
        }),
        unref: vi.fn(),
        disconnect: vi.fn(),
        kill: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess);

      let stdout = "";
      const logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
        stdout += String(msg) + "\n";
      });

      try {
        await decryptAgentCommand({ eval: true });
        expect(() => handlers["message"]()).toThrow("process.exit(0)");

        const trapLine = stdout.split("\n").find((line) => line.startsWith("trap "));
        expect(trapLine).toBeDefined();

        const { execFileSync } = await vi.importActual<typeof import("node:child_process")>(
          "node:child_process",
        );
        execFileSync("/bin/sh", ["-c", `${trapLine} exit`], { encoding: "utf-8" });

        expect(realFs.existsSync(socketPath)).toBe(false);
        expect(realFs.existsSync(decoyPath)).toBe(true);
      } finally {
        logSpy.mockRestore();
        realFs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // Keep this the LAST test in this describe: an unconsumed mockImplementationOnce
  // survives clearAllMocks, so last position guarantees no later test can inherit it.
  it("rejects with 'Not logged in' before prompting when not logged in", async () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");

    vi.mocked(assertLoggedIn).mockImplementationOnce(() => {
      throw new Error("Not logged in. Run `passwd-sso login` first.");
    });

    await expect(decryptAgentCommand({})).rejects.toThrow("Not logged in");

    expect(readPassphrase).not.toHaveBeenCalled();
  });
});
