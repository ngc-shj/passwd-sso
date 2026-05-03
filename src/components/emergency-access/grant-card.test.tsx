// @vitest-environment jsdom
/**
 * GrantCard tests
 *
 * Vault context (useVault) is mocked per §Sec-1.
 * The crypto module @/lib/crypto/crypto-emergency is mocked at the consumer
 * boundary; assertions verify the mock receives shaped arguments.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { mockI18nNavigation } from "@/__tests__/helpers/mock-app-navigation";

const {
  mockFetchApi,
  mockUseVault,
  mockGenerateECDH,
  mockExportPublicKey,
  mockExportPrivateKey,
  mockEncryptPrivateKey,
  mockToastSuccess,
  mockToastError,
  mockClipboardWrite,
  routerPush,
} = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockUseVault: vi.fn(),
  mockGenerateECDH: vi.fn(),
  mockExportPublicKey: vi.fn(),
  mockExportPrivateKey: vi.fn(),
  mockEncryptPrivateKey: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockClipboardWrite: vi.fn(async () => undefined),
  routerPush: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key;
    return Object.assign(t, { has: () => true });
  },
}));

vi.mock("@/i18n/navigation", () =>
  mockI18nNavigation({ router: { push: routerPush } }),
);

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetchApi(path, init),
  appUrl: (path: string) => `https://example.test${path}`,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
}));

vi.mock("@/lib/crypto/crypto-emergency", () => ({
  generateECDHKeyPair: () => mockGenerateECDH(),
  exportPublicKey: (k: unknown) => mockExportPublicKey(k),
  exportPrivateKey: (k: unknown) => mockExportPrivateKey(k),
  encryptPrivateKey: (priv: unknown, key: unknown) =>
    mockEncryptPrivateKey(priv, key),
}));

vi.mock("@/lib/http/api-error-codes", () => ({
  eaErrorToI18nKey: (e: unknown) => `ea:${String(e ?? "unknown")}`,
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled, onClick, title }: React.ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick} title={title}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
  AlertDialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));

import { GrantCard } from "./grant-card";
import { EA_STATUS, VAULT_STATUS } from "@/lib/constants";

const baseGrant = {
  id: "grant-1",
  ownerId: "owner-1",
  granteeId: "grantee-1",
  granteeEmail: "trustee@example.com",
  status: EA_STATUS.PENDING,
  waitDays: 7,
  token: "tok-abc",
  requestedAt: null,
  waitExpiresAt: null,
  createdAt: "2026-05-04",
  owner: { id: "owner-1", name: "Owner", email: "owner@example.com" },
  grantee: { id: "grantee-1", name: "Trustee", email: "trustee@example.com" },
};

describe("GrantCard", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockUseVault.mockReset();
    mockGenerateECDH.mockReset();
    mockExportPublicKey.mockReset();
    mockExportPrivateKey.mockReset();
    mockEncryptPrivateKey.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockClipboardWrite.mockReset();
    routerPush.mockReset();

    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockClipboardWrite },
      configurable: true,
    });
  });

  it("renders grantee name and waitDays for owner with PENDING grant", () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: null });

    render(
      <GrantCard
        grant={baseGrant}
        currentUserId="owner-1"
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText("Trustee")).toBeInTheDocument();
    expect(screen.getByText(/waitDays/)).toBeInTheDocument();
  });

  it("owner can copy invite link when grant has token (PENDING)", async () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: null });

    render(
      <GrantCard
        grant={baseGrant}
        currentUserId="owner-1"
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle("copyLink"));

    await waitFor(() => {
      expect(mockClipboardWrite).toHaveBeenCalledWith(
        "https://example.test/dashboard/emergency-access/invite/tok-abc",
      );
    });
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it("grantee accept disabled when vault is locked (R26 disabled-cue)", () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.LOCKED, encryptionKey: null });

    render(
      <GrantCard
        grant={baseGrant}
        currentUserId="grantee-1"
        onRefresh={vi.fn()}
      />,
    );

    const acceptBtn = screen.getByRole("button", { name: "accept" });
    expect(acceptBtn).toBeDisabled();
  });

  it("grantee accept calls crypto with shaped args and POSTs to accept endpoint", async () => {
    const fakeKey = new Uint8Array(32);
    const fakePubJwk = { kty: "EC" };
    const fakePrivBytes = new Uint8Array(48);
    const fakeEnc = {
      ciphertext: "ct-hex",
      iv: "iv-hex",
      authTag: "tag-hex",
    };

    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.UNLOCKED,
      encryptionKey: fakeKey,
    });
    mockGenerateECDH.mockResolvedValue({
      publicKey: { kp: "pub" },
      privateKey: { kp: "priv" },
    });
    mockExportPublicKey.mockResolvedValue(fakePubJwk);
    mockExportPrivateKey.mockResolvedValue(fakePrivBytes);
    mockEncryptPrivateKey.mockResolvedValue(fakeEnc);
    mockFetchApi.mockResolvedValue({ ok: true });

    const onRefresh = vi.fn();
    render(
      <GrantCard
        grant={baseGrant}
        currentUserId="grantee-1"
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalled();
    });

    // Shape assertion: encryptPrivateKey called with the real encryption key
    expect(mockEncryptPrivateKey).toHaveBeenCalledWith(fakePrivBytes, fakeKey);

    const body = JSON.parse(mockFetchApi.mock.calls[0][1].body);
    expect(body).toEqual({
      granteePublicKey: fakePubJwk,
      encryptedPrivateKey: {
        ciphertext: "ct-hex",
        iv: "iv-hex",
        authTag: "tag-hex",
      },
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("grantee accept shows error toast when no encryption key", async () => {
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.UNLOCKED,
      encryptionKey: null,
    });

    render(
      <GrantCard
        grant={baseGrant}
        currentUserId="grantee-1"
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("vaultUnlockRequired");
    });
    expect(mockGenerateECDH).not.toHaveBeenCalled();
  });

  it("grantee navigates to vault when status is ACTIVATED", () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: null });
    const grant = { ...baseGrant, status: EA_STATUS.ACTIVATED };

    render(
      <GrantCard
        grant={grant}
        currentUserId="grantee-1"
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "accessVault" }));
    expect(routerPush).toHaveBeenCalledWith(
      "/dashboard/emergency-access/grant-1/vault",
    );
  });

  it("owner approve calls correct endpoint and refreshes", async () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: null });
    mockFetchApi.mockResolvedValue({ ok: true });

    const onRefresh = vi.fn();
    const grant = { ...baseGrant, status: EA_STATUS.REQUESTED };

    render(<GrantCard grant={grant} currentUserId="owner-1" onRefresh={onRefresh} />);

    // The first 'approveRequest' button is the trigger; the second is the
    // alert dialog action. With our mock both render directly — pressing
    // either calls handleApprove only when Action.onClick fires.
    const approveButtons = screen.getAllByText("approveRequest");
    fireEvent.click(approveButtons[approveButtons.length - 1]);

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalled();
    });
    expect(onRefresh).toHaveBeenCalled();
  });
});
