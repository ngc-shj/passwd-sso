// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { API_PATH } from "@/lib/constants";
import {
  computeRecoveryVerifierHash,
  formatRecoveryKey,
  unwrapSecretKeyWithRecovery,
  wrapSecretKeyWithRecovery,
  type RecoveryWrappedData,
} from "@/lib/crypto/crypto-recovery";
import { deriveWrappingKey, hexDecode, unwrapSecretKey } from "@/lib/crypto/crypto-client";

const { mockFetchApi, mockHardNavigate, mockSetHasRecoveryKey } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockHardNavigate: vi.fn(),
  mockSetHasRecoveryKey: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "ja",
}));
vi.mock("@/i18n/navigation", async () => {
  const { mockI18nNavigation } = await import("@/__tests__/helpers/mock-app-navigation");
  return mockI18nNavigation();
});
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ setHasRecoveryKey: mockSetHasRecoveryKey }),
}));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
  hardNavigate: mockHardNavigate,
}));

import RecoveryPage from "./page";

// Test-only key material: a fixed recovery key and the vault secret key it wraps.
const RECOVERY_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
const SECRET_KEY = new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff);
const NEW_PASSPHRASE = "correct horse battery staple";

let formattedKey: string;
let wrapped: RecoveryWrappedData;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function verifyResponse(): Response {
  return json({
    encryptedSecretKey: wrapped.encryptedSecretKey,
    iv: wrapped.iv,
    authTag: wrapped.authTag,
    hkdfSalt: wrapped.hkdfSalt,
    accountSalt: "00".repeat(32),
    keyVersion: 1,
  });
}

function submitKey(value: string) {
  fireEvent.change(screen.getByLabelText("recoveryKeyLabel"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "verified" }));
}

async function reachNewPassphraseStep() {
  mockFetchApi.mockResolvedValueOnce(verifyResponse());
  render(<RecoveryPage />);
  submitKey(formattedKey);
  await screen.findByLabelText("newPassphrase");
}

function fillPassphrases(pass: string, confirm: string) {
  fireEvent.change(screen.getByLabelText("newPassphrase"), { target: { value: pass } });
  fireEvent.change(screen.getByLabelText("confirmNewPassphrase"), { target: { value: confirm } });
}

describe("RecoveryPage", () => {
  beforeEach(async () => {
    mockFetchApi.mockReset();
    formattedKey = await formatRecoveryKey(RECOVERY_KEY);
    wrapped = await wrapSecretKeyWithRecovery(SECRET_KEY, RECOVERY_KEY);
  });

  it("disables verification until a key is entered", () => {
    render(<RecoveryPage />);

    expect(screen.getByRole("button", { name: "verified" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("recoveryKeyLabel"), { target: { value: "x" } });
    expect(screen.getByRole("button", { name: "verified" })).toBeEnabled();
  });

  it("rejects a key whose checksum does not match, without calling the server", async () => {
    const last = formattedKey.slice(-1);
    render(<RecoveryPage />);

    submitKey(formattedKey.slice(0, -1) + (last === "A" ? "B" : "A"));

    expect(await screen.findByText("invalidChecksum")).toBeInTheDocument();
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("rejects a key of the wrong length as invalid", async () => {
    render(<RecoveryPage />);

    submitKey("ABCD-EFGH");

    expect(await screen.findByText("invalidRecoveryKey")).toBeInTheDocument();
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("sends the recovery key's verifier hash in the verify step", async () => {
    await reachNewPassphraseStep();

    const [path, init] = mockFetchApi.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(API_PATH.VAULT_RECOVERY_KEY_RECOVER);
    expect(JSON.parse(String(init.body))).toEqual({
      step: "verify",
      verifierHash: await computeRecoveryVerifierHash(RECOVERY_KEY),
    });
    expect(screen.getByText("verified")).toBeInTheDocument();
  });

  it.each([
    ["RECOVERY_KEY_NOT_SET", "recoveryKeyNotSet"],
    ["INVALID_RECOVERY_KEY", "invalidRecoveryKey"],
    ["UNAUTHORIZED", "unauthorized"],
  ])("maps a %s verify error to %s", async (code, message) => {
    mockFetchApi.mockResolvedValueOnce(json({ error: code }, 400));
    render(<RecoveryPage />);

    submitKey(formattedKey);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByLabelText("newPassphrase")).toBeNull();
  });

  it("shows the unknown error for a verify error without a code", async () => {
    mockFetchApi.mockResolvedValueOnce(new Response("", { status: 500 }));
    render(<RecoveryPage />);

    submitKey(formattedKey);

    expect(await screen.findByText("unknownError")).toBeInTheDocument();
  });

  it("shows the unknown error when the verify request throws", async () => {
    mockFetchApi.mockRejectedValueOnce(new Error("offline"));
    render(<RecoveryPage />);

    submitKey(formattedKey);

    expect(await screen.findByText("unknownError")).toBeInTheDocument();
  });

  it("warns about a short passphrase and keeps reset disabled", async () => {
    await reachNewPassphraseStep();

    fillPassphrases("short", "short");

    expect(screen.getByText("passphraseMinLength")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "resetPassphrase" })).toBeDisabled();
  });

  it("warns about a mismatched confirmation and keeps reset disabled", async () => {
    await reachNewPassphraseStep();

    fillPassphrases(NEW_PASSPHRASE, `${NEW_PASSPHRASE}!`);

    expect(screen.getByText("passphraseMismatch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "resetPassphrase" })).toBeDisabled();
  });

  it("re-wraps the same secret key under the new passphrase and the recovery key", async () => {
    await reachNewPassphraseStep();
    mockFetchApi.mockResolvedValueOnce(json({ ok: true }));

    fillPassphrases(NEW_PASSPHRASE, NEW_PASSPHRASE);
    expect(screen.queryByText("passphraseMinLength")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "resetPassphrase" }));

    await waitFor(() => expect(mockHardNavigate).toHaveBeenCalledWith("/ja/dashboard"), { timeout: 8000 });
    expect(mockSetHasRecoveryKey).toHaveBeenCalledWith(true);
    const body = JSON.parse(String((mockFetchApi.mock.calls[1] as [string, RequestInit])[1].body));
    expect(body.step).toBe("reset");
    expect(body.verifierHash).toBe(await computeRecoveryVerifierHash(RECOVERY_KEY));

    const wrappingKey = await deriveWrappingKey(NEW_PASSPHRASE, hexDecode(body.accountSalt));
    const viaPassphrase = await unwrapSecretKey(
      { ciphertext: body.encryptedSecretKey, iv: body.secretKeyIv, authTag: body.secretKeyAuthTag },
      wrappingKey,
    );
    expect(viaPassphrase).toEqual(SECRET_KEY);

    const viaRecovery = await unwrapSecretKeyWithRecovery(
      {
        encryptedSecretKey: body.recoveryEncryptedSecretKey,
        iv: body.recoverySecretKeyIv,
        authTag: body.recoverySecretKeyAuthTag,
      },
      RECOVERY_KEY,
      body.recoveryHkdfSalt,
    );
    expect(viaRecovery).toEqual(SECRET_KEY);
  }, 15_000);

  it("shows the mapped error when the reset step is refused", async () => {
    await reachNewPassphraseStep();
    mockFetchApi.mockResolvedValueOnce(json({ error: "UNAUTHORIZED" }, 401));

    fillPassphrases(NEW_PASSPHRASE, NEW_PASSPHRASE);
    fireEvent.click(screen.getByRole("button", { name: "resetPassphrase" }));

    expect(await screen.findByText("unauthorized", {}, { timeout: 8000 })).toBeInTheDocument();
    expect(mockHardNavigate).not.toHaveBeenCalled();
    expect(mockSetHasRecoveryKey).not.toHaveBeenCalled();
  }, 15_000);

  it("shows the unknown error when the wrapped key cannot be unwrapped", async () => {
    mockFetchApi.mockResolvedValueOnce(
      json({ ...JSON.parse(await verifyResponse().text()), authTag: "00".repeat(16) }),
    );
    render(<RecoveryPage />);
    submitKey(formattedKey);
    await screen.findByLabelText("newPassphrase");

    fillPassphrases(NEW_PASSPHRASE, NEW_PASSPHRASE);
    fireEvent.click(screen.getByRole("button", { name: "resetPassphrase" }));

    expect(await screen.findByText("unknownError")).toBeInTheDocument();
    expect(mockFetchApi).toHaveBeenCalledTimes(1);
  });
});
