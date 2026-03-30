import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---
vi.mock("./agent-decrypt.js", () => ({
  decryptAgentCommand: vi.fn(),
}));

vi.mock("../../commands/agent-decrypt.js", () => ({
  decryptAgentCommand: vi.fn(),
}));

vi.mock("../../commands/unlock.js", () => ({
  autoUnlockIfNeeded: vi.fn(),
}));

vi.mock("../../lib/vault-state.js", () => ({
  getEncryptionKey: vi.fn(),
  getUserId: vi.fn(),
  isUnlocked: vi.fn(),
}));

vi.mock("../../lib/api-client.js", () => ({
  apiRequest: vi.fn(),
}));

vi.mock("../../lib/crypto.js", () => ({
  decryptData: vi.fn(),
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
}));

vi.mock("../../lib/output.js", () => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

const { decryptAgentCommand } = await import("../../commands/agent-decrypt.js");
const { autoUnlockIfNeeded } = await import("../../commands/unlock.js");
const { getEncryptionKey, getUserId } = await import("../../lib/vault-state.js");
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

  it("in eval mode, outputs SSH_AUTH_SOCK shell command", async () => {
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

    vi.mocked(decryptData).mockResolvedValue(
      JSON.stringify({
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----",
        publicKey: "ssh-ed25519 AAAA comment",
        comment: "test key",
      }),
    );

    vi.mocked(loadKey).mockResolvedValue(undefined);
    vi.mocked(startAgent).mockReturnValue("/tmp/eval-test.sock");

    // agentCommand never resolves (waits forever) — we just check before the infinite wait
    // by having it throw after setInterval is set. Use a quick timeout to observe output.
    await Promise.race([
      agentCommand({ eval: true }).catch(() => "exited"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timeout"), 100),
      ),
    ]);

    // Should have output SSH_AUTH_SOCK line before waiting
    expect(stdoutOutput).toContain("SSH_AUTH_SOCK=");
    expect(stdoutOutput).toContain("/tmp/eval-test.sock");
  });
});
