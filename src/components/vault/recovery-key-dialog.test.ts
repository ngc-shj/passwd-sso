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

vi.mock("@/lib/crypto/crypto-client", () => ({
  computePassphraseVerifier: mockComputePassphraseVerifier,
}));
vi.mock("@/lib/crypto/crypto-recovery", () => ({
  generateRecoveryKey: mockGenerateRecoveryKey,
  formatRecoveryKey: mockFormatRecoveryKey,
  wrapSecretKeyWithRecovery: mockWrapSecretKeyWithRecovery,
}));
// The real API_ERROR: the flow classifies refusals by those codes.
vi.mock("@/lib/http/api-error-codes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/api-error-codes")>()),
  apiErrorToI18nKey: (code: string) => code,
}));
vi.mock("@/lib/constants", () => ({
  API_PATH: { VAULT_RECOVERY_KEY_GENERATE: "/api/vault/recovery-key/generate" },
}));
// fetchApi has a `typeof window` guard — bypass it so node-env tests work
vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) =>
    init !== undefined ? fetch(path, init) : fetch(path),
  withBasePath: (p: string) => p,
  BASE_PATH: "",
}));
// Unused by generateRecoveryKeyFlow but required for module import
vi.mock("@/lib/vault/vault-context", () => ({
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

const notLocked = () => false;

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

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(result).toEqual({ ok: true, formattedKey: "ABCD-EFGH-IJKL" });
  });

  it("zeros secretKey and recoveryKey after success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(allZero(secretKey)).toBe(true);
    expect(allZero(recoveryKey)).toBe(true);
  });

  it("calls fetch with correct payload", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

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

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(result).toEqual({ ok: false, errorCode: "INVALID_PASSPHRASE" });
  });

  it("zeros secretKey and recoveryKey on API error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "INVALID_PASSPHRASE" }),
    });

    await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(allZero(secretKey)).toBe(true);
    expect(allZero(recoveryKey)).toBe(true);
  });

  it("reports the outcome as unknown when a 502 carries no app error envelope (a proxy's HTML page)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError("Unexpected token '<'")),
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(result).toEqual({ ok: false, outcomeUnknown: true });
  });

  it("reports the outcome as unknown when the POST rejects in transit", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(result).toEqual({ ok: false, outcomeUnknown: true });
    expect(allZero(secretKey)).toBe(true);
    expect(allZero(recoveryKey)).toBe(true);
  });

  it("reports the outcome as unknown on INTERNAL_ERROR, which does not prove nothing was stored", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "INTERNAL_ERROR" }),
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(result).toEqual({ ok: false, outcomeUnknown: true });
  });

  it("returns the code of a refusal the route sends before its write (VERIFIER_NOT_SET)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "VERIFIER_NOT_SET" }),
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(result).toEqual({ ok: false, errorCode: "VERIFIER_NOT_SET" });
  });

  it("returns VAULT_WRAP_CONFLICT as a refusal: the compare-and-swap lost and nothing was stored", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: "VAULT_WRAP_CONFLICT" }),
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(result).toEqual({ ok: false, errorCode: "VAULT_WRAP_CONFLICT" });
  });

  it("treats a 2xx whose body is unreadable as stored and returns the key", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(result).toEqual({ ok: true, formattedKey: "ABCD-EFGH-IJKL" });
  });

  // ── Vault locked during the flow ──────────────────────────

  it("sends nothing and reports not-started when the vault was locked before the POST", async () => {
    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, () => true);

    expect(result).toEqual({ ok: false, notStartedVaultLocked: true });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(allZero(secretKey)).toBe(true);
    expect(allZero(recoveryKey)).toBe(true);
  });

  it("does not return a committed key when the vault was locked after the POST was sent", async () => {
    const lock = { locked: false };
    mockFetch.mockImplementation(async () => {
      lock.locked = true;
      return { ok: true, json: () => Promise.resolve({ success: true }) };
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, () => lock.locked);

    expect(result).toEqual({ ok: false, committedVaultLocked: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFormatRecoveryKey).not.toHaveBeenCalled();
    expect(allZero(recoveryKey)).toBe(true);
  });

  it("does not return a committed key when the vault was locked while it was being formatted", async () => {
    const lock = { locked: false };
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });
    mockFormatRecoveryKey.mockImplementation(async () => {
      lock.locked = true;
      return "ABCD-EFGH-IJKL";
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, () => lock.locked);

    expect(result).toEqual({ ok: false, committedVaultLocked: true });
    expect(allZero(recoveryKey)).toBe(true);
  });

  it("reports a refusal received after the vault was locked as not-started", async () => {
    const lock = { locked: false };
    mockFetch.mockImplementation(async () => {
      lock.locked = true;
      return { ok: false, status: 429, json: () => Promise.resolve({ error: "RATE_LIMIT_EXCEEDED" }) };
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, () => lock.locked);

    expect(result).toEqual({ ok: false, notStartedVaultLocked: true });
  });

  it("reports the outcome as unknown when a committed key cannot be formatted", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });
    mockFormatRecoveryKey.mockRejectedValue(new Error("format failed"));

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(result).toEqual({ ok: false, outcomeUnknown: true });
    expect(allZero(recoveryKey)).toBe(true);
  });

  it("reports a throw before the POST, once the vault was locked, as not-started", async () => {
    const lock = { locked: false };
    mockWrapSecretKeyWithRecovery.mockImplementation(async () => {
      lock.locked = true;
      throw new Error("crypto failure");
    });

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, () => lock.locked);

    expect(result).toEqual({ ok: false, notStartedVaultLocked: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Exception path ────────────────────────────────────────

  it("returns null errorCode on crypto exception", async () => {
    mockWrapSecretKeyWithRecovery.mockRejectedValue(new Error("crypto failure"));

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(result).toEqual({ ok: false, errorCode: null });
  });

  it("zeros secretKey and recoveryKey on crypto exception", async () => {
    mockWrapSecretKeyWithRecovery.mockRejectedValue(new Error("crypto failure"));

    await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(allZero(secretKey)).toBe(true);
    expect(allZero(recoveryKey)).toBe(true);
  });

  it("zeros secretKey even when exception occurs before recoveryKey generation", async () => {
    mockComputePassphraseVerifier.mockRejectedValue(new Error("verifier failure"));

    const result = await generateRecoveryKeyFlow("pass", secretKey, accountSalt, notLocked);

    expect(result).toEqual({ ok: false, errorCode: null });
    expect(allZero(secretKey)).toBe(true);
    // recoveryKey was never generated, so mockGenerateRecoveryKey was not called
    expect(mockGenerateRecoveryKey).not.toHaveBeenCalled();
  });
});
