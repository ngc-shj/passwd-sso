/**
 * Tests for generateRecoveryKeyFlow — the actual function the component calls.
 *
 * Verifies three execution paths (success / API error / exception) and
 * confirms that secretKey AND recoveryKey are always zeroed in finally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────
const {
  mockComputePassphraseVerifier,
  mockGenerateRecoveryKey,
  mockWrapSecretKeyWithRecovery,
  mockFormatRecoveryKey,
  mockFetch,
} = vi.hoisted(() => ({
  mockComputePassphraseVerifier: vi.fn(),
  mockGenerateRecoveryKey: vi.fn(),
  mockWrapSecretKeyWithRecovery: vi.fn(),
  mockFormatRecoveryKey: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("@/lib/crypto-client", () => ({
  computePassphraseVerifier: mockComputePassphraseVerifier,
}));
vi.mock("@/lib/crypto-recovery", () => ({
  generateRecoveryKey: mockGenerateRecoveryKey,
  formatRecoveryKey: mockFormatRecoveryKey,
  wrapSecretKeyWithRecovery: mockWrapSecretKeyWithRecovery,
}));
vi.mock("@/lib/api-error-codes", () => ({
  apiErrorToI18nKey: (code: string) => code,
}));
vi.mock("@/lib/constants", () => ({
  API_PATH: { VAULT_RECOVERY_KEY_GENERATE: "/api/vault/recovery-key/generate" },
}));
// Unused by generateRecoveryKeyFlow but required for module import
vi.mock("@/lib/vault-context", () => ({
  useVault: () => ({}),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

import { generateRecoveryKeyFlow } from "./recovery-key-dialog";

// ── Helpers ────────────────────────────────────────────────────

function allZero(arr: Uint8Array): boolean {
  return arr.every((b) => b === 0);
}

// ── Tests ──────────────────────────────────────────────────────

describe("generateRecoveryKeyFlow", () => {
  let secretKey: Uint8Array;
  let recoveryKey: Uint8Array;
  const accountSalt = new Uint8Array(32);

  beforeEach(() => {
    vi.clearAllMocks();

    // Non-zero bytes so we can verify zeroing
    secretKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    recoveryKey = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]);

    mockComputePassphraseVerifier.mockResolvedValue("verifier-hash");
    mockGenerateRecoveryKey.mockReturnValue(recoveryKey);
    mockWrapSecretKeyWithRecovery.mockResolvedValue({
      encryptedSecretKey: "enc",
      iv: "iv",
      authTag: "tag",
      hkdfSalt: "salt",
      verifierHash: "vhash",
    });
    mockFormatRecoveryKey.mockResolvedValue("ABCD-EFGH-IJKL");

    vi.stubGlobal("fetch", mockFetch);
  });

  // ── Success path ──────────────────────────────────────────

  it("returns formattedKey on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt);

    expect(result).toEqual({ ok: true, formattedKey: "ABCD-EFGH-IJKL" });
  });

  it("zeros secretKey and recoveryKey after success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await generateRecoveryKeyFlow("pass", secretKey, accountSalt);

    expect(allZero(secretKey)).toBe(true);
    expect(allZero(recoveryKey)).toBe(true);
  });

  it("calls fetch with correct payload", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await generateRecoveryKeyFlow("pass", secretKey, accountSalt);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/vault/recovery-key/generate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          currentVerifierHash: "verifier-hash",
          encryptedSecretKey: "enc",
          secretKeyIv: "iv",
          secretKeyAuthTag: "tag",
          hkdfSalt: "salt",
          verifierHash: "vhash",
        }),
      }),
    );
  });

  // ── API error path ────────────────────────────────────────

  it("returns errorCode on API error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "INVALID_PASSPHRASE" }),
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt);

    expect(result).toEqual({ ok: false, errorCode: "INVALID_PASSPHRASE" });
  });

  it("zeros secretKey and recoveryKey on API error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "INVALID_PASSPHRASE" }),
    });

    await generateRecoveryKeyFlow("pass", secretKey, accountSalt);

    expect(allZero(secretKey)).toBe(true);
    expect(allZero(recoveryKey)).toBe(true);
  });

  it("returns null errorCode when API error body is unparseable", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.reject(new Error("invalid json")),
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt);

    expect(result).toEqual({ ok: false, errorCode: null });
  });

  // ── Exception path ────────────────────────────────────────

  it("returns null errorCode on crypto exception", async () => {
    mockWrapSecretKeyWithRecovery.mockRejectedValue(new Error("crypto failure"));

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt);

    expect(result).toEqual({ ok: false, errorCode: null });
  });

  it("zeros secretKey and recoveryKey on crypto exception", async () => {
    mockWrapSecretKeyWithRecovery.mockRejectedValue(new Error("crypto failure"));

    await generateRecoveryKeyFlow("pass", secretKey, accountSalt);

    expect(allZero(secretKey)).toBe(true);
    expect(allZero(recoveryKey)).toBe(true);
  });

  it("zeros secretKey even when exception occurs before recoveryKey generation", async () => {
    mockComputePassphraseVerifier.mockRejectedValue(new Error("verifier failure"));

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt);

    expect(result).toEqual({ ok: false, errorCode: null });
    expect(allZero(secretKey)).toBe(true);
    // recoveryKey was never generated, so mockGenerateRecoveryKey was not called
    expect(mockGenerateRecoveryKey).not.toHaveBeenCalled();
  });
});
