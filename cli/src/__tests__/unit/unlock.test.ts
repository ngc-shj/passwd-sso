import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks (must be hoisted before imports) ---
vi.mock("../../lib/api-client.js", () => ({
  apiRequest: vi.fn(),
}));

vi.mock("../../lib/crypto.js", () => ({
  hexDecode: vi.fn((hex: string) => new Uint8Array(Buffer.from(hex, "hex"))),
  deriveWrappingKey: vi.fn(),
  unwrapSecretKey: vi.fn(),
  deriveEncryptionKey: vi.fn(),
  verifyKey: vi.fn(),
}));

vi.mock("../../lib/vault-state.js", () => ({
  setEncryptionKey: vi.fn(),
  setSecretKeyBytes: vi.fn(),
  isUnlocked: vi.fn(),
}));

vi.mock("../../lib/output.js", () => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

const { apiRequest } = await import("../../lib/api-client.js");
const { deriveWrappingKey, unwrapSecretKey, deriveEncryptionKey, verifyKey } =
  await import("../../lib/crypto.js");
const { setEncryptionKey, setSecretKeyBytes, isUnlocked } =
  await import("../../lib/vault-state.js");
const output = await import("../../lib/output.js");

const {
  unlockWithPassphrase,
  unlockCommand,
  autoUnlockIfNeeded,
} = await import("../../commands/unlock.js");

// Helper: build a mock CryptoKey-like object
function makeMockKey(): CryptoKey {
  return { type: "secret", algorithm: { name: "AES-GCM" } } as unknown as CryptoKey;
}

describe("unlockWithPassphrase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when API request fails", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ok: false, status: 500, data: {} });

    const result = await unlockWithPassphrase("passphrase");

    expect(result).toBe(false);
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("Failed to fetch vault data"));
  });

  it("returns false when accountSalt is missing", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        userId: "user-1",
        encryptedSecretKey: "aabbcc",
        secretKeyIv: "aabbcc",
        secretKeyAuthTag: "aabbcc",
        verificationArtifact: null,
        accountSalt: "", // empty = missing
      },
    });

    const result = await unlockWithPassphrase("passphrase");

    expect(result).toBe(false);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("not set up"),
    );
  });

  it("returns false when verificationArtifact check fails", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        userId: "user-1",
        encryptedSecretKey: "aabbcc",
        secretKeyIv: "aabbcc",
        secretKeyAuthTag: "aabbcc",
        verificationArtifact: { ciphertext: "cc", iv: "dd", authTag: "ee" },
        accountSalt: "aabbcc",
      },
    });

    const mockWrappingKey = makeMockKey();
    const mockSecretKey = new Uint8Array([1, 2, 3]);
    const mockEncKey = makeMockKey();

    vi.mocked(deriveWrappingKey).mockResolvedValue(mockWrappingKey);
    vi.mocked(unwrapSecretKey).mockResolvedValue(mockSecretKey);
    vi.mocked(deriveEncryptionKey).mockResolvedValue(mockEncKey);
    vi.mocked(verifyKey).mockResolvedValue(false); // verification fails

    const result = await unlockWithPassphrase("wrongpassphrase");

    expect(result).toBe(false);
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining("Incorrect passphrase"));
  });

  it("returns true and calls setEncryptionKey on success", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        userId: "user-1",
        encryptedSecretKey: "aabbcc",
        secretKeyIv: "aabbcc",
        secretKeyAuthTag: "aabbcc",
        verificationArtifact: { ciphertext: "cc", iv: "dd", authTag: "ee" },
        accountSalt: "aabbcc",
      },
    });

    const mockWrappingKey = makeMockKey();
    const mockSecretKey = new Uint8Array([1, 2, 3]);
    const mockEncKey = makeMockKey();

    vi.mocked(deriveWrappingKey).mockResolvedValue(mockWrappingKey);
    vi.mocked(unwrapSecretKey).mockResolvedValue(mockSecretKey);
    vi.mocked(deriveEncryptionKey).mockResolvedValue(mockEncKey);
    vi.mocked(verifyKey).mockResolvedValue(true);

    const result = await unlockWithPassphrase("correctpassphrase");

    expect(result).toBe(true);
    expect(setEncryptionKey).toHaveBeenCalledWith(mockEncKey, "user-1");
    expect(setSecretKeyBytes).toHaveBeenCalledWith(mockSecretKey);
  });

  it("handles crypto derivation errors gracefully", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        userId: "user-1",
        encryptedSecretKey: "aabbcc",
        secretKeyIv: "aabbcc",
        secretKeyAuthTag: "aabbcc",
        verificationArtifact: null,
        accountSalt: "aabbcc",
      },
    });

    vi.mocked(deriveWrappingKey).mockRejectedValue(new Error("Crypto failure"));

    const result = await unlockWithPassphrase("passphrase");

    expect(result).toBe(false);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to unlock vault"),
    );
  });

  it("returns true without calling verifyKey when verificationArtifact is null", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        userId: "user-2",
        encryptedSecretKey: "aabbcc",
        secretKeyIv: "aabbcc",
        secretKeyAuthTag: "aabbcc",
        verificationArtifact: null,
        accountSalt: "aabbcc",
      },
    });

    const mockWrappingKey = makeMockKey();
    const mockSecretKey = new Uint8Array([4, 5, 6]);
    const mockEncKey = makeMockKey();

    vi.mocked(deriveWrappingKey).mockResolvedValue(mockWrappingKey);
    vi.mocked(unwrapSecretKey).mockResolvedValue(mockSecretKey);
    vi.mocked(deriveEncryptionKey).mockResolvedValue(mockEncKey);

    const result = await unlockWithPassphrase("passphrase");

    expect(result).toBe(true);
    expect(verifyKey).not.toHaveBeenCalled();
    expect(setEncryptionKey).toHaveBeenCalledWith(mockEncKey, "user-2");
  });
});

describe("autoUnlockIfNeeded", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns true when vault is already unlocked", async () => {
    vi.mocked(isUnlocked).mockReturnValue(true);

    const result = await autoUnlockIfNeeded();

    expect(result).toBe(true);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(output.warn).not.toHaveBeenCalled();
  });

  it("does not warn when vault is already unlocked even if PSSO_PASSPHRASE is set", async () => {
    vi.mocked(isUnlocked).mockReturnValue(true);
    process.env.PSSO_PASSPHRASE = "env-passphrase";

    const result = await autoUnlockIfNeeded();

    expect(result).toBe(true);
    expect(output.warn).not.toHaveBeenCalled();
  });

  it("returns false when vault is locked and no PSSO_PASSPHRASE env", async () => {
    vi.mocked(isUnlocked).mockReturnValue(false);
    delete process.env.PSSO_PASSPHRASE;

    const result = await autoUnlockIfNeeded();

    expect(result).toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(output.warn).not.toHaveBeenCalled();
  });

  it("calls unlockWithPassphrase when PSSO_PASSPHRASE is set and vault is locked", async () => {
    vi.mocked(isUnlocked).mockReturnValue(false);
    process.env.PSSO_PASSPHRASE = "env-passphrase";

    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        userId: "user-1",
        encryptedSecretKey: "aabbcc",
        secretKeyIv: "aabbcc",
        secretKeyAuthTag: "aabbcc",
        verificationArtifact: null,
        accountSalt: "aabbcc",
      },
    });

    const mockEncKey = makeMockKey();
    vi.mocked(deriveWrappingKey).mockResolvedValue(makeMockKey());
    vi.mocked(unwrapSecretKey).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(deriveEncryptionKey).mockResolvedValue(mockEncKey);

    const result = await autoUnlockIfNeeded();

    expect(result).toBe(true);
    expect(apiRequest).toHaveBeenCalledWith("/api/vault/unlock/data");
    expect(output.warn).toHaveBeenCalledTimes(1);
    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining("PSSO_PASSPHRASE"));
    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining("CI/automation"));
    // Verify passphrase value is NOT leaked in the warning message
    expect(output.warn).not.toHaveBeenCalledWith(expect.stringContaining("env-passphrase"));
  });

  it("returns false when PSSO_PASSPHRASE is set but unlock fails", async () => {
    vi.mocked(isUnlocked).mockReturnValue(false);
    process.env.PSSO_PASSPHRASE = "wrong-passphrase";

    vi.mocked(apiRequest).mockResolvedValue({ ok: false, status: 401, data: {} });

    const result = await autoUnlockIfNeeded();

    expect(result).toBe(false);
    expect(output.warn).toHaveBeenCalledTimes(1);
    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining("PSSO_PASSPHRASE"));
    // Verify passphrase value is NOT leaked in the warning message
    expect(output.warn).not.toHaveBeenCalledWith(expect.stringContaining("wrong-passphrase"));
  });
});

describe("unlockCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows 'already unlocked' when vault is already unlocked", async () => {
    vi.mocked(isUnlocked).mockReturnValue(true);

    await unlockCommand();

    expect(output.info).toHaveBeenCalledWith(
      expect.stringContaining("already unlocked"),
    );
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("shows error when passphrase is empty", async () => {
    vi.mocked(isUnlocked).mockReturnValue(false);

    // Mock readPassphrase to return empty string
    // We need to simulate stdin ending immediately with empty input
    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);

    // We test readPassphrase indirectly — trigger "end" event with no data accumulated
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // Simulate stdin ending without data
    const stdinEmitter = process.stdin as NodeJS.ReadStream & { isTTY: boolean };
    const origIsTTY = stdinEmitter.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    // The readPassphrase will wait for stdin data — we emit "end" immediately
    setTimeout(() => {
      process.stdin.emit("end");
    }, 0);

    await unlockCommand();

    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining("Passphrase is required"),
    );

    Object.defineProperty(process.stdin, "isTTY", {
      value: origIsTTY,
      configurable: true,
    });
  });

  it("calls output.success after valid passphrase and successful API unlock", async () => {
    // unlockCommand calls readPassphrase internally (same module — not externally mockable).
    // We stub resume() so that after registering listeners readPassphrase immediately
    // receives the passphrase data, avoiding timer/microtask race conditions.

    vi.mocked(isUnlocked).mockReturnValue(false);

    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        userId: "user-1",
        encryptedSecretKey: "aabbcc",
        secretKeyIv: "aabbcc",
        secretKeyAuthTag: "aabbcc",
        verificationArtifact: null,
        accountSalt: "aabbcc",
      },
    });

    vi.mocked(deriveWrappingKey).mockResolvedValue(makeMockKey());
    vi.mocked(unwrapSecretKey).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(deriveEncryptionKey).mockResolvedValue(makeMockKey());

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    // readPassphrase processes one character per "data" event — emit chars individually.
    // resume() is stubbed to no-op; listeners are registered synchronously after it returns.
    vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);

    setTimeout(() => {
      // Send each character as a separate "data" event so readPassphrase's char-by-char
      // parser handles them correctly.  The final "\n" triggers resolve().
      for (const char of "secret\n") {
        process.stdin.emit("data", Buffer.from(char));
      }
    }, 0);

    await unlockCommand();

    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining("unlocked"),
    );
  });
});
