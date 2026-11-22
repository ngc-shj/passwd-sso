// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { API_PATH, VAULT_STATUS } from "@/lib/constants";
import { deriveEncryptionKey } from "@/lib/crypto/crypto-client";
import { decryptPrivateKey, importPrivateKey, importPublicKey } from "@/lib/crypto/crypto-emergency";

const { mockFetchApi, mockUseVault, mockToast, mockPush } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockUseVault: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  mockPush: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "invite-token" }),
}));
vi.mock("@/i18n/navigation", async () => {
  const { mockI18nNavigation } = await import("@/__tests__/helpers/mock-app-navigation");
  return mockI18nNavigation({ router: { push: mockPush } });
});
vi.mock("@/lib/vault/vault-context", () => ({ useVault: mockUseVault }));
vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));

import AcceptEmergencyInvitePage from "./page";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// A fixed test-only secret key: the vault encryption key is derived from it
// exactly as the vault context does after unlock.
const TEST_SECRET_KEY = new Uint8Array(32).fill(7);
let encryptionKey: CryptoKey;

describe("AcceptEmergencyInvitePage", () => {
  beforeEach(async () => {
    mockFetchApi.mockReset();
    encryptionKey = await deriveEncryptionKey(TEST_SECRET_KEY);
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey });
  });

  it("disables accept and shows the unlock notice while the vault is locked", () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.LOCKED, encryptionKey: null });
    render(<AcceptEmergencyInvitePage />);

    expect(screen.getAllByText("vaultUnlockRequired")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "accept" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "decline" })).toBeEnabled();
  });

  it("enables accept without the unlock notice when the vault is unlocked", () => {
    render(<AcceptEmergencyInvitePage />);

    expect(screen.queryByText("vaultUnlockRequired")).toBeNull();
    expect(screen.getByRole("button", { name: "accept" })).toBeEnabled();
  });

  it("refuses to accept without an encryption key", async () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: null });
    render(<AcceptEmergencyInvitePage />);

    fireEvent.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("vaultUnlockRequired"));
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("posts a key pair whose private half is sealed under the vault key", async () => {
    mockFetchApi.mockImplementation(async () => json({}));
    render(<AcceptEmergencyInvitePage />);

    fireEvent.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/dashboard/emergency-access"));
    expect(mockToast.success).toHaveBeenCalledWith("accepted");
    const [path, init] = mockFetchApi.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(API_PATH.EMERGENCY_ACCESS_ACCEPT);
    const body = JSON.parse(String(init.body));
    expect(body.token).toBe("invite-token");
    await expect(importPublicKey(body.granteePublicKey)).resolves.toBeInstanceOf(CryptoKey);
    const privateBytes = await decryptPrivateKey(body.encryptedPrivateKey, encryptionKey);
    await expect(importPrivateKey(privateBytes)).resolves.toBeInstanceOf(CryptoKey);
  });

  it("shows the invalid-invitation message when accept answers NOT_FOUND", async () => {
    mockFetchApi.mockImplementation(async () => json({ error: "NOT_FOUND" }, 404));
    render(<AcceptEmergencyInvitePage />);

    fireEvent.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("invalidInvitation"));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("maps any other accept error through the emergency-access error map", async () => {
    mockFetchApi.mockImplementation(async () => json({ error: "SOMETHING_ELSE" }, 409));
    render(<AcceptEmergencyInvitePage />);

    fireEvent.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("actionFailed"));
  });

  it("shows the network error when accept throws", async () => {
    mockFetchApi.mockRejectedValue(new Error("offline"));
    render(<AcceptEmergencyInvitePage />);

    fireEvent.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("networkError"));
    expect(screen.getByRole("button", { name: "accept" })).toBeEnabled();
  });

  it("declines with the token and returns to the emergency-access page", async () => {
    mockFetchApi.mockImplementation(async () => json({}));
    render(<AcceptEmergencyInvitePage />);

    fireEvent.click(screen.getByRole("button", { name: "decline" }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/dashboard/emergency-access"));
    expect(mockToast.success).toHaveBeenCalledWith("declined");
    const [path, init] = mockFetchApi.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(API_PATH.EMERGENCY_ACCESS_REJECT);
    expect(JSON.parse(String(init.body))).toEqual({ token: "invite-token" });
  });

  it("shows the invalid-invitation message when decline answers NOT_FOUND", async () => {
    mockFetchApi.mockImplementation(async () => json({ error: "NOT_FOUND" }, 404));
    render(<AcceptEmergencyInvitePage />);

    fireEvent.click(screen.getByRole("button", { name: "decline" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("invalidInvitation"));
  });

  it("maps any other decline error through the emergency-access error map", async () => {
    mockFetchApi.mockImplementation(async () => json({}, 500));
    render(<AcceptEmergencyInvitePage />);

    fireEvent.click(screen.getByRole("button", { name: "decline" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("actionFailed"));
  });

  it("shows the network error when decline throws", async () => {
    mockFetchApi.mockRejectedValue(new Error("offline"));
    render(<AcceptEmergencyInvitePage />);

    fireEvent.click(screen.getByRole("button", { name: "decline" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("networkError"));
  });
});
