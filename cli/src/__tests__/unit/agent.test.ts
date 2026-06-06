import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// --- Mocks ---
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("./agent-decrypt.js", () => ({
  decryptAgentCommand: vi.fn(),
}));

vi.mock("../../commands/agent-decrypt.js", () => ({
  decryptAgentCommand: vi.fn(),
}));

vi.mock("../../commands/unlock.js", () => ({
  autoUnlockIfNeeded: vi.fn(),
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
}));

vi.mock("../../lib/crypto.js", () => ({
  decryptData: vi.fn(),
  hexEncode: vi.fn(() => "deadbeef"),
  hexDecode: vi.fn(() => new Uint8Array(0)),
  deriveEncryptionKey: vi.fn(),
}));

vi.mock("../../lib/crypto-aad.js", () => ({
  buildPersonalEntryAAD: vi.fn(() => new Uint8Array(0)),
}));

vi.mock("../../lib/ssh-key-agent.js", () => ({
  loadKey: vi.fn(),
  clearKeys: vi.fn(),
}));

vi.mock("../../lib/ssh-agent-socket.js", () => ({
  startAgent: vi.fn(() => "/tmp/test-ssh.sock"),
  stopAgent: vi.fn(),
  setAgentDeps: vi.fn(),
}));

vi.mock("../../lib/ssh-sign-authorizer.js", () => ({
  authorizeSign: vi.fn(),
}));

vi.mock("../../lib/ssh-confirm.js", () => ({
  confirmSign: vi.fn(),
}));

vi.mock("../../lib/output.js", () => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

const { spawn } = await import("node:child_process");
const { decryptAgentCommand } = await import("../../commands/agent-decrypt.js");
const { autoUnlockIfNeeded } = await import("../../commands/unlock.js");
const { getEncryptionKey, getUserId, getSecretKeyBytes } = await import("../../lib/vault-state.js");
const { apiRequest } = await import("../../lib/api-client.js");
const { decryptData } = await import("../../lib/crypto.js");
const { loadKey } = await import("../../lib/ssh-key-agent.js");
const { startAgent } = await import("../../lib/ssh-agent-socket.js");
const output = await import("../../lib/output.js");

const { agentCommand } = await import("../../commands/agent.js");

describe("agentCommand", () => {
  let stdoutOutput: string;
  let exitCode: number | undefined;

  beforeEach(() => {
    stdoutOutput = "";
    exitCode = undefined;
    vi.clearAllMocks();

    vi.spyOn(process.stdout, "write").mockImplementation((msg) => {
      stdoutOutput += String(msg);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      stdoutOutput += String(msg) + "\n";
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to decryptAgentCommand when opts.decrypt is true", async () => {
    vi.mocked(decryptAgentCommand).mockResolvedValue(undefined);

    await agentCommand({ decrypt: true, eval: true });

    expect(decryptAgentCommand).toHaveBeenCalledWith({ eval: true });
    expect(autoUnlockIfNeeded).not.toHaveBeenCalled();
  });

  it("exits when autoUnlockIfNeeded returns false", async () => {
    vi.mocked(autoUnlockIfNeeded).mockResolvedValue(false);

    await expect(agentCommand({})).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("Vault is locked"),
    );
  });

  it("exits when getEncryptionKey returns null", async () => {
    vi.mocked(autoUnlockIfNeeded).mockResolvedValue(true);
    vi.mocked(getEncryptionKey).mockReturnValue(null);

    await expect(agentCommand({})).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("Encryption key not available"),
    );
  });

  it("exits when API returns error fetching SSH keys", async () => {
    const mockKey = { type: "secret" } as unknown as CryptoKey;
    vi.mocked(autoUnlockIfNeeded).mockResolvedValue(true);
    vi.mocked(getEncryptionKey).mockReturnValue(mockKey);
    vi.mocked(getUserId).mockReturnValue("user-1");
    vi.mocked(apiRequest).mockResolvedValue({ ok: false, status: 500, data: [] });

    await expect(agentCommand({})).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch SSH keys"),
    );
  });

  it("exits when no SSH keys found (empty array)", async () => {
    const mockKey = { type: "secret" } as unknown as CryptoKey;
    vi.mocked(autoUnlockIfNeeded).mockResolvedValue(true);
    vi.mocked(getEncryptionKey).mockReturnValue(mockKey);
    vi.mocked(getUserId).mockReturnValue("user-1");
    vi.mocked(apiRequest).mockResolvedValue({ ok: true, status: 200, data: [] });

    await expect(agentCommand({})).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("No SSH keys found"),
    );
  });

  it("exits when no valid SSH keys could be loaded (all fail to decrypt)", async () => {
    const mockKey = { type: "secret" } as unknown as CryptoKey;
    vi.mocked(autoUnlockIfNeeded).mockResolvedValue(true);
    vi.mocked(getEncryptionKey).mockReturnValue(mockKey);
    vi.mocked(getUserId).mockReturnValue("user-1");
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: [
        {
          id: "entry-1",
          entryType: "SSH_KEY",
          encryptedBlob: { ciphertext: "aa", iv: "bb", authTag: "cc" },
          aadVersion: 1,
        },
      ],
    });

    // decryptData throws → key not loaded
    vi.mocked(decryptData).mockRejectedValue(new Error("Decrypt failed"));

    await expect(agentCommand({})).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("No valid SSH keys could be loaded"),
    );
  });

  it("exits when decrypted blob has no privateKey or publicKey", async () => {
    const mockKey = { type: "secret" } as unknown as CryptoKey;
    vi.mocked(autoUnlockIfNeeded).mockResolvedValue(true);
    vi.mocked(getEncryptionKey).mockReturnValue(mockKey);
    vi.mocked(getUserId).mockReturnValue("user-1");
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: [
        {
          id: "entry-1",
          entryType: "SSH_KEY",
          encryptedBlob: { ciphertext: "aa", iv: "bb", authTag: "cc" },
          aadVersion: 0,
        },
      ],
    });

    // Blob with no privateKey/publicKey — loadKey should not be called
    vi.mocked(decryptData).mockResolvedValue(JSON.stringify({ title: "My Key" }));

    await expect(agentCommand({})).rejects.toThrow("process.exit(1)");

    expect(loadKey).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("No valid SSH keys could be loaded"),
    );
  });

  it("in eval mode, forks a detached daemon and prints SSH_AUTH_SOCK on the child's socketPath", async () => {
    vi.mocked(autoUnlockIfNeeded).mockResolvedValue(true);
    vi.mocked(getSecretKeyBytes).mockReturnValue(new Uint8Array([1, 2, 3]));
    vi.mocked(getUserId).mockReturnValue("user-1");

    // Fake detached child: capture event handlers so the test can drive them.
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

    // forkDaemon registers handlers and returns (no infinite wait in the parent).
    await agentCommand({ eval: true });

    // Spawned detached with the daemon env flag and the vault secret sent via IPC.
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ _PSSO_SSH_DAEMON: "1" }),
      }),
    );
    expect(fakeChild.send).toHaveBeenCalledWith({ secretHex: "deadbeef", userId: "user-1" });

    // When the child reports its socket path, the parent prints the export
    // lines and exits(0) so `eval $(...)` returns.
    expect(() => handlers["message"]({ socketPath: "/tmp/eval.sock" })).toThrow(
      "process.exit(0)",
    );
    expect(stdoutOutput).toContain("SSH_AUTH_SOCK='/tmp/eval.sock'");
    expect(stdoutOutput).toContain("SSH_AGENT_PID='4242'");
    expect(fakeChild.unref).toHaveBeenCalled();
    expect(fakeChild.disconnect).toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it("routes to the daemon child when _PSSO_SSH_DAEMON is set (registers IPC handler)", () => {
    // Mock process.on to a no-op so runDaemonChild's listener is NOT registered
    // on the real process — otherwise it would intercept vitest's own IPC.
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation(() => process as unknown as NodeJS.Process);
    process.env._PSSO_SSH_DAEMON = "1";
    try {
      // runDaemonChild waits for an IPC message — do not await it.
      void agentCommand({});
      expect(onSpy).toHaveBeenCalledWith("message", expect.any(Function));
      // It must NOT unlock in the child (the key arrives via IPC).
      expect(autoUnlockIfNeeded).not.toHaveBeenCalled();
    } finally {
      delete process.env._PSSO_SSH_DAEMON;
      onSpy.mockRestore();
    }
  });
});
