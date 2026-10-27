// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SESSION_STORAGE_KEY } from "@/lib/constants";

// ── Hoisted mocks ──────────────────────────────────────────
const { mockUnlockWithStoredPrf, mockFetchApi } = vi.hoisted(() => ({
  mockUnlockWithStoredPrf: vi.fn(),
  mockFetchApi: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  Link: "a",
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    unlock: vi.fn(),
    unlockWithPasskey: vi.fn(),
    unlockWithStoredPrf: mockUnlockWithStoredPrf,
  }),
  VaultUnlockError: class VaultUnlockError extends Error {},
}));

vi.mock("@/lib/auth/webauthn/webauthn-client", () => ({
  isWebAuthnSupported: () => true,
}));

vi.mock("@/lib/auth/prf-handoff", () => ({
  hasPrf: () => true,
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
