// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SESSION_STORAGE_KEY } from "@/lib/constants";
import { API_ERROR } from "@/lib/http/api-error-codes";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const {
  mockUnlock,
  mockUnlockWithPasskey,
  mockUnlockWithStoredPrf,
  mockFetchApi,
  mockPush,
  mockHasPrf,
  mockIsWebAuthnSupported,
  MockVaultUnlockError,
} = vi.hoisted(() => ({
  mockUnlock: vi.fn(),
  mockUnlockWithPasskey: vi.fn(),
  mockUnlockWithStoredPrf: vi.fn(),
  mockFetchApi: vi.fn(),
  mockPush: vi.fn(),
  mockHasPrf: vi.fn(),
  mockIsWebAuthnSupported: vi.fn(),
  MockVaultUnlockError: class VaultUnlockError extends Error {
    constructor(
      public readonly code: string,
      public readonly lockedUntil?: string | null,
    ) {
      super(code);
    }
  },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  Link: "a",
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    unlock: mockUnlock,
    unlockWithPasskey: mockUnlockWithPasskey,
    unlockWithStoredPrf: mockUnlockWithStoredPrf,
  }),
  VaultUnlockError: MockVaultUnlockError,
}));

vi.mock("@/lib/auth/webauthn/webauthn-client", () => ({
  isWebAuthnSupported: mockIsWebAuthnSupported,
}));

vi.mock("@/lib/auth/prf-handoff", () => ({
  hasPrf: mockHasPrf,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: mockFetchApi,
}));

vi.mock("@/components/extension/ext-connect-banner", () => ({
  ExtConnectBanner: () => null,
}));

import { VaultLockScreen } from "./vault-lock-screen";

function pendingCredentialsCheck() {
  let resolve!: () => void;
  mockFetchApi.mockReturnValue(
    new Promise((r) => {
      resolve = () => r({ ok: true, json: async () => [{ prfSupported: true, prfWrappingPresent: true }] });
    }),
  );
  return () => resolve();
}

describe("VaultLockScreen auto-unlock after WebAuthn sign-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasPrf.mockReturnValue(true);
    mockIsWebAuthnSupported.mockReturnValue(true);
    sessionStorage.clear();
    sessionStorage.setItem(SESSION_STORAGE_KEY.WEBAUTHN_SIGNIN, "1");
    mockUnlockWithStoredPrf.mockResolvedValue(true);
  });

  it("unlocks with the stored PRF output once the passkey check settles", async () => {
    const settle = pendingCredentialsCheck();
    render(<VaultLockScreen />);
    expect(mockUnlockWithStoredPrf).not.toHaveBeenCalled();

    settle();

    await waitFor(() => expect(mockUnlockWithStoredPrf).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY.WEBAUTHN_SIGNIN)).toBeNull();
  });

  it("leaves the one-shot sign-in flag for the next mount when unmounted before the check settles", async () => {
    const settle = pendingCredentialsCheck();
    const { unmount } = render(<VaultLockScreen />);
    unmount();

    settle();
    // Let the settled check's .finally() run.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockUnlockWithStoredPrf).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY.WEBAUTHN_SIGNIN)).toBe("1");
  });
});

describe("VaultLockScreen passkey unlock button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasPrf.mockReturnValue(true);
    mockIsWebAuthnSupported.mockReturnValue(true);
    sessionStorage.clear();
  });

  // Resolves the credentials check and reports when the screen has read it.
  function credentialsCheck(creds: Array<{ prfSupported: boolean; prfWrappingPresent: boolean }>) {
    const json = vi.fn(async () => creds);
    mockFetchApi.mockResolvedValue({ ok: true, json });
    return json;
  }

  it("offers passkey unlock for a PRF credential that holds the wrapping", async () => {
    credentialsCheck([{ prfSupported: true, prfWrappingPresent: true }]);
    render(<VaultLockScreen />);
    expect(await screen.findByText("unlockWithPasskey")).toBeTruthy();
  });

  it("hides passkey unlock for a PRF credential without the wrapping", async () => {
    const json = credentialsCheck([{ prfSupported: true, prfWrappingPresent: false }]);
    render(<VaultLockScreen />);
    await waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    // Let the state update from the settled check render.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("unlockWithPasskey")).toBeNull();
  });
});

function noPasskeys() {
  mockFetchApi.mockResolvedValue({ ok: true, json: async () => [] });
}

function withUnlockablePasskey() {
  mockFetchApi.mockResolvedValue({
    ok: true,
    json: async () => [{ prfSupported: true, prfWrappingPresent: true }],
  });
}

function passphraseInput(): HTMLInputElement {
  const input = screen.getByLabelText("passphrase");
  if (!(input instanceof HTMLInputElement)) throw new Error("passphrase input not rendered");
  return input;
}

function submitPassphrase(value: string) {
  fireEvent.change(passphraseInput(), { target: { value } });
  fireEvent.click(screen.getByText("unlock"));
}

describe("VaultLockScreen passphrase unlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasPrf.mockReturnValue(true);
    mockIsWebAuthnSupported.mockReturnValue(true);
    sessionStorage.clear();
    noPasskeys();
  });

  it("unlocks with the typed passphrase and shows no error on success", async () => {
    mockUnlock.mockResolvedValue(true);
    render(<VaultLockScreen />);

    submitPassphrase("my passphrase");

    await waitFor(() => expect(mockUnlock).toHaveBeenCalledWith("my passphrase"));
    expect(screen.queryByText("wrongPassphrase")).toBeNull();
    expect(passphraseInput().value).toBe("my passphrase");
  });

  it("shows the wrong-passphrase error and clears the input when unlock returns false", async () => {
    mockUnlock.mockResolvedValue(false);
    render(<VaultLockScreen />);

    submitPassphrase("bad passphrase");

    expect(await screen.findByText("wrongPassphrase")).toBeInTheDocument();
    expect(passphraseInput().value).toBe("");
  });

  it("clears the shown error when the user types again", async () => {
    mockUnlock.mockResolvedValue(false);
    render(<VaultLockScreen />);
    submitPassphrase("bad passphrase");
    await screen.findByText("wrongPassphrase");

    fireEvent.change(passphraseInput(), { target: { value: "x" } });

    expect(screen.queryByText("wrongPassphrase")).toBeNull();
  });

  it.each([
    [API_ERROR.ACCOUNT_LOCKED, "accountLocked"],
    [API_ERROR.RATE_LIMIT_EXCEEDED, "rateLimited"],
    [API_ERROR.SERVICE_UNAVAILABLE, "retryLater"],
    ["SOMETHING_ELSE", "unlockError"],
  ])("maps a %s unlock error to the %s message", async (code, message) => {
    mockUnlock.mockRejectedValue(new MockVaultUnlockError(code, null));
    render(<VaultLockScreen />);

    submitPassphrase("my passphrase");

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(passphraseInput().value).toBe("");
  });

  it("shows the generic unlock error for a non-VaultUnlockError failure", async () => {
    mockUnlock.mockRejectedValue(new Error("network"));
    render(<VaultLockScreen />);

    submitPassphrase("my passphrase");

    expect(await screen.findByText("unlockError")).toBeInTheDocument();
  });

  it("replaces the passphrase form with the session-expired card on UNAUTHORIZED", async () => {
    mockUnlock.mockRejectedValue(new MockVaultUnlockError(API_ERROR.UNAUTHORIZED));
    render(<VaultLockScreen />);
    expect(passphraseInput()).toBeInTheDocument();

    submitPassphrase("my passphrase");

    expect(await screen.findByText("sessionExpired")).toBeInTheDocument();
    expect(screen.queryByLabelText("passphrase")).toBeNull();
  });

  it("switches to the session-expired screen on UNAUTHORIZED and links to sign-in", async () => {
    mockUnlock.mockRejectedValue(new MockVaultUnlockError(API_ERROR.UNAUTHORIZED));
    render(<VaultLockScreen />);

    submitPassphrase("my passphrase");

    fireEvent.click(await screen.findByText("goToSignIn"));
    expect(screen.getByText("sessionExpired")).toBeInTheDocument();
    expect(mockPush).toHaveBeenCalledWith("/auth/signin");
  });

  it("toggles the passphrase input between hidden and visible", () => {
    render(<VaultLockScreen />);
    const input = passphraseInput();
    expect(input).toHaveAttribute("type", "password");

    const toggle = input.parentElement?.querySelector("button");
    if (!toggle) throw new Error("toggle not rendered");
    fireEvent.click(toggle);

    expect(input).toHaveAttribute("type", "text");
  });
});

describe("VaultLockScreen passkey unlock click", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasPrf.mockReturnValue(true);
    mockIsWebAuthnSupported.mockReturnValue(true);
    sessionStorage.clear();
    withUnlockablePasskey();
  });

  it("calls unlockWithPasskey and shows no error when it succeeds", async () => {
    mockUnlockWithPasskey.mockResolvedValue(true);
    render(<VaultLockScreen />);

    fireEvent.click(await screen.findByText("unlockWithPasskey"));

    await waitFor(() => expect(mockUnlockWithPasskey).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("unlockWithPasskey")).toBeInTheDocument();
    expect(screen.queryByText("unlockError")).toBeNull();
  });

  it("shows the passkey unlock error when unlockWithPasskey returns false", async () => {
    mockUnlockWithPasskey.mockResolvedValue(false);
    render(<VaultLockScreen />);

    fireEvent.click(await screen.findByText("unlockWithPasskey"));

    expect(await screen.findByText("unlockError")).toBeInTheDocument();
  });

  it.each([
    [API_ERROR.ACCOUNT_LOCKED, "accountLocked"],
    [API_ERROR.RATE_LIMIT_EXCEEDED, "rateLimited"],
    [API_ERROR.SERVICE_UNAVAILABLE, "serviceUnavailable"],
    ["SOMETHING_ELSE", "unlockError"],
  ])("maps a %s passkey error to the %s message", async (code, message) => {
    mockUnlockWithPasskey.mockRejectedValue(new MockVaultUnlockError(code, null));
    render(<VaultLockScreen />);

    fireEvent.click(await screen.findByText("unlockWithPasskey"));

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("shows the passkey unlock error for a non-VaultUnlockError failure", async () => {
    mockUnlockWithPasskey.mockRejectedValue(new Error("aborted"));
    render(<VaultLockScreen />);

    fireEvent.click(await screen.findByText("unlockWithPasskey"));

    expect(await screen.findByText("unlockError")).toBeInTheDocument();
  });

  it("switches to the session-expired screen when passkey unlock is UNAUTHORIZED", async () => {
    mockUnlockWithPasskey.mockRejectedValue(new MockVaultUnlockError(API_ERROR.UNAUTHORIZED));
    render(<VaultLockScreen />);

    fireEvent.click(await screen.findByText("unlockWithPasskey"));

    expect(await screen.findByText("sessionExpired")).toBeInTheDocument();
  });
});

describe("VaultLockScreen auto-unlock outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasPrf.mockReturnValue(true);
    mockIsWebAuthnSupported.mockReturnValue(true);
    sessionStorage.clear();
    sessionStorage.setItem(SESSION_STORAGE_KEY.WEBAUTHN_SIGNIN, "1");
    noPasskeys();
  });

  it("shows the unlock error when the stored-PRF unlock returns false", async () => {
    mockUnlockWithStoredPrf.mockResolvedValue(false);
    render(<VaultLockScreen />);

    expect(await screen.findByText("unlockError")).toBeInTheDocument();
  });

  it("shows the lockout message when the stored-PRF unlock is ACCOUNT_LOCKED", async () => {
    mockUnlockWithStoredPrf.mockRejectedValue(
      new MockVaultUnlockError(API_ERROR.ACCOUNT_LOCKED, null),
    );
    render(<VaultLockScreen />);

    expect(await screen.findByText("accountLocked")).toBeInTheDocument();
  });

  it.each([
    [API_ERROR.RATE_LIMIT_EXCEEDED, "rateLimited"],
    [API_ERROR.SERVICE_UNAVAILABLE, "serviceUnavailable"],
    ["SOMETHING_ELSE", "unlockError"],
  ])("maps a %s stored-PRF unlock error to the %s message, not the lockout", async (code, message) => {
    mockUnlockWithStoredPrf.mockRejectedValue(new MockVaultUnlockError(code, null));
    render(<VaultLockScreen />);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText("accountLocked")).toBeNull();
  });

  it("switches to the session-expired screen when the stored-PRF unlock is UNAUTHORIZED", async () => {
    mockUnlockWithStoredPrf.mockRejectedValue(new MockVaultUnlockError(API_ERROR.UNAUTHORIZED));
    render(<VaultLockScreen />);

    expect(await screen.findByText("sessionExpired")).toBeInTheDocument();
  });

  it("shows the unlock error when the stored-PRF unlock throws a non-VaultUnlockError", async () => {
    mockUnlockWithStoredPrf.mockRejectedValue(new Error("boom"));
    render(<VaultLockScreen />);

    expect(await screen.findByText("unlockError")).toBeInTheDocument();
  });

  it("consumes the sign-in flag without unlocking when no PRF output was handed off", async () => {
    mockHasPrf.mockReturnValue(false);
    render(<VaultLockScreen />);

    await waitFor(() =>
      expect(sessionStorage.getItem(SESSION_STORAGE_KEY.WEBAUTHN_SIGNIN)).toBeNull(),
    );
    expect(mockUnlockWithStoredPrf).not.toHaveBeenCalled();
  });

  it("still auto-unlocks when the passkey credentials check fails", async () => {
    mockFetchApi.mockRejectedValue(new Error("offline"));
    mockUnlockWithStoredPrf.mockResolvedValue(true);
    render(<VaultLockScreen />);

    await waitFor(() => expect(mockUnlockWithStoredPrf).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("unlockWithPasskey")).toBeNull();
  });

  it("skips the credentials check but still auto-unlocks when WebAuthn is unsupported", async () => {
    mockIsWebAuthnSupported.mockReturnValue(false);
    mockUnlockWithStoredPrf.mockResolvedValue(true);
    render(<VaultLockScreen />);

    await waitFor(() => expect(mockUnlockWithStoredPrf).toHaveBeenCalledTimes(1));
    expect(mockFetchApi).not.toHaveBeenCalled();
  });
});

describe("VaultLockScreen with blocked sessionStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasPrf.mockReturnValue(true);
    mockIsWebAuthnSupported.mockReturnValue(true);
    noPasskeys();
    // A sandboxed iframe or disabled site data makes every storage access throw.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still renders the passphrase form", () => {
    render(<VaultLockScreen />);
    expect(passphraseInput()).toBeInTheDocument();
  });

  it("unlocks with the passphrase and does not auto-unlock", async () => {
    mockUnlock.mockResolvedValue(true);
    render(<VaultLockScreen />);

    submitPassphrase("my passphrase");

    await waitFor(() => expect(mockUnlock).toHaveBeenCalledWith("my passphrase"));
    expect(mockUnlockWithStoredPrf).not.toHaveBeenCalled();
  });
});
