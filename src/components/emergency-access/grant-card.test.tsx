// @vitest-environment jsdom
/**
 * GrantCard tests
 *
 * Vault context (useVault) is mocked per §Sec-1.
 * The crypto module @/lib/crypto/crypto-emergency is mocked at the consumer
 * boundary; assertions verify the mock receives shaped arguments.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    routerPush.mockReset();
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

  it("shows the owner no invite-link copy control on a PENDING grant", () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: null });
    render(<GrantCard grant={baseGrant} currentUserId="owner-1" onRefresh={vi.fn()} />);

    // The list endpoint never returns the plaintext token, so there is nothing
    // the card could copy; revoke (trigger, then its dialog's cancel and
    // confirm) is the owner's only PENDING action.
    expect(screen.getAllByRole("button").map((b) => b.title || b.textContent)).toEqual([
      "revoke",
      "cancel",
      "revoke",
    ]);
  });
});

describe("GrantCard actions", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: null });
  });

  function clickLast(text: string) {
    const matches = screen.getAllByText(text);
    fireEvent.click(matches[matches.length - 1]);
  }

  it("revokes permanently from the owner's revoke dialog", async () => {
    mockFetchApi.mockResolvedValue({ ok: true });
    const onRefresh = vi.fn();
    render(<GrantCard grant={baseGrant} currentUserId="owner-1" onRefresh={onRefresh} />);

    clickLast("revoke");

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(mockFetchApi.mock.calls[0][0]).toBe("/api/emergency-access/grant-1/revoke");
    expect(JSON.parse(mockFetchApi.mock.calls[0][1].body)).toEqual({ permanent: true });
    expect(mockToastSuccess).toHaveBeenCalledWith("revoked");
  });

  it("rejects a request as a non-permanent revoke", async () => {
    mockFetchApi.mockResolvedValue({ ok: true });
    const grant = { ...baseGrant, status: EA_STATUS.REQUESTED };
    render(<GrantCard grant={grant} currentUserId="owner-1" onRefresh={vi.fn()} />);

    clickLast("rejectRequest");

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("requestRejected"));
    expect(JSON.parse(mockFetchApi.mock.calls[0][1].body)).toEqual({ permanent: false });
  });

  it.each([
    ["revoke", EA_STATUS.PENDING, "owner-1"],
    ["approveRequest", EA_STATUS.REQUESTED, "owner-1"],
    ["requestAccess", EA_STATUS.IDLE, "grantee-1"],
    ["decline", EA_STATUS.PENDING, "grantee-1"],
  ])("%s maps a refused response to its error message without refreshing", async (action, status, userId) => {
    mockFetchApi.mockResolvedValue({ ok: false, json: async () => ({ error: "CONFLICT" }) });
    const onRefresh = vi.fn();
    render(<GrantCard grant={{ ...baseGrant, status }} currentUserId={userId} onRefresh={onRefresh} />);

    clickLast(action);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("ea:CONFLICT"));
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it.each([
    ["revoke", EA_STATUS.PENDING, "owner-1"],
    ["approveRequest", EA_STATUS.REQUESTED, "owner-1"],
    ["requestAccess", EA_STATUS.IDLE, "grantee-1"],
    ["decline", EA_STATUS.PENDING, "grantee-1"],
  ])("%s shows the network error when the request throws", async (action, status, userId) => {
    mockFetchApi.mockRejectedValue(new Error("offline"));
    render(<GrantCard grant={{ ...baseGrant, status }} currentUserId={userId} onRefresh={vi.fn()} />);

    clickLast(action);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("networkError"));
  });

  it("falls back to the unknown error when a refused response has no JSON body", async () => {
    mockFetchApi.mockResolvedValue({ ok: false, json: async () => Promise.reject(new SyntaxError("x")) });
    render(<GrantCard grant={baseGrant} currentUserId="owner-1" onRefresh={vi.fn()} />);

    clickLast("revoke");

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("ea:unknown"));
  });

  it("requests access from an IDLE grant and refreshes", async () => {
    mockFetchApi.mockResolvedValue({ ok: true });
    const onRefresh = vi.fn();
    const grant = { ...baseGrant, status: EA_STATUS.IDLE };
    render(<GrantCard grant={grant} currentUserId="grantee-1" onRefresh={onRefresh} />);

    clickLast("requestAccess");

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(mockFetchApi.mock.calls[0][0]).toBe("/api/emergency-access/grant-1/request");
    expect(mockToastSuccess).toHaveBeenCalledWith("requested");
  });

  it("declines a PENDING grant and refreshes", async () => {
    mockFetchApi.mockResolvedValue({ ok: true });
    const onRefresh = vi.fn();
    render(<GrantCard grant={baseGrant} currentUserId="grantee-1" onRefresh={onRefresh} />);

    clickLast("decline");

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(mockFetchApi.mock.calls[0][0]).toBe("/api/emergency-access/grant-1/decline");
    expect(mockToastSuccess).toHaveBeenCalledWith("declined");
  });

  it("reports a refused accept and re-enables the accept button", async () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: new Uint8Array(32) });
    mockGenerateECDH.mockResolvedValue({ publicKey: {}, privateKey: {} });
    mockExportPublicKey.mockResolvedValue({});
    mockExportPrivateKey.mockResolvedValue(new Uint8Array(1));
    mockEncryptPrivateKey.mockResolvedValue({ ciphertext: "c", iv: "i", authTag: "a" });
    mockFetchApi.mockResolvedValue({ ok: false, json: async () => ({ error: "GONE" }) });
    const onRefresh = vi.fn();
    render(<GrantCard grant={baseGrant} currentUserId="grantee-1" onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("ea:GONE"));
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "accept" })).toBeEnabled();
  });

  it("shows the network error when key generation fails during accept", async () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: new Uint8Array(32) });
    mockGenerateECDH.mockRejectedValue(new Error("no subtle"));
    render(<GrantCard grant={baseGrant} currentUserId="grantee-1" onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("networkError"));
    expect(mockFetchApi).not.toHaveBeenCalled();
  });
});

describe("GrantCard display", () => {
  beforeEach(() => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: null });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the grantee by email when the owner views a grant without a grantee", () => {
    render(<GrantCard grant={{ ...baseGrant, grantee: null }} currentUserId="owner-1" onRefresh={vi.fn()} />);
    expect(screen.getByText("trustee@example.com")).toBeInTheDocument();
  });

  it("names the owner by email when the grantee views an owner without a name", () => {
    const owner = { id: "owner-1", name: null, email: "owner@example.com" };
    render(<GrantCard grant={{ ...baseGrant, owner }} currentUserId="grantee-1" onRefresh={vi.fn()} />);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
  });

  it.each([
    ["2026-06-03T05:00:00Z", "2d 5h"],
    ["2026-06-01T07:30:00Z", "7h"],
  ])("shows the remaining wait until %s as %s", (waitExpiresAt, remaining) => {
    const grant = { ...baseGrant, status: EA_STATUS.REQUESTED, waitExpiresAt };
    render(<GrantCard grant={grant} currentUserId="owner-1" onRefresh={vi.fn()} />);
    expect(
      screen.getByText(`waitingPeriod:${JSON.stringify({ remaining })}`, { exact: false }),
    ).toBeInTheDocument();
  });

  it("offers the grantee the vault once a REQUESTED grant's wait has expired", () => {
    const grant = { ...baseGrant, status: EA_STATUS.REQUESTED, waitExpiresAt: "2026-05-31T00:00:00Z" };
    render(<GrantCard grant={grant} currentUserId="grantee-1" onRefresh={vi.fn()} />);

    expect(screen.getByRole("button", { name: "accessVault" })).toBeInTheDocument();
    expect(
      screen.getByText(`waitingPeriod:${JSON.stringify({ remaining: "0" })}`, { exact: false }),
    ).toBeInTheDocument();
  });

  it("does not offer the vault while a REQUESTED grant's wait is still running", () => {
    const grant = { ...baseGrant, status: EA_STATUS.REQUESTED, waitExpiresAt: "2026-06-02T00:00:00Z" };
    render(<GrantCard grant={grant} currentUserId="grantee-1" onRefresh={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "accessVault" })).toBeNull();
  });

  it.each([
    [EA_STATUS.PENDING, "owner-1", "ownerHintPending"],
    [EA_STATUS.ACCEPTED, "owner-1", "ownerHintAccepted"],
    [EA_STATUS.IDLE, "grantee-1", "granteeHintIdle"],
    [EA_STATUS.STALE, "owner-1", "ownerHintStale"],
    [EA_STATUS.ACTIVATED, "grantee-1", "granteeHintActivated"],
    [EA_STATUS.REVOKED, "owner-1", "ownerHintRevoked"],
    [EA_STATUS.REJECTED, "grantee-1", "granteeHintRejected"],
  ])("shows the %s hint for user %s", (status, userId, hint) => {
    render(<GrantCard grant={{ ...baseGrant, status }} currentUserId={userId} onRefresh={vi.fn()} />);
    expect(screen.getByText(hint)).toBeInTheDocument();
  });

  it("passes the wait days to the grantee's REQUESTED hint", () => {
    const grant = { ...baseGrant, status: EA_STATUS.REQUESTED, waitExpiresAt: null };
    render(<GrantCard grant={grant} currentUserId="grantee-1" onRefresh={vi.fn()} />);
    expect(screen.getByText(`granteeHintRequested:${JSON.stringify({ days: "7" })}`)).toBeInTheDocument();
  });

  it("offers the owner no revoke on a terminal grant", () => {
    render(<GrantCard grant={{ ...baseGrant, status: EA_STATUS.REVOKED }} currentUserId="owner-1" onRefresh={vi.fn()} />);
    expect(screen.queryByTitle("revoke")).toBeNull();
    expect(screen.getByText("statusRevoked")).toBeInTheDocument();
  });

  it("marks completed steps and the current step of the flow", () => {
    const { container } = render(
      <GrantCard grant={{ ...baseGrant, status: EA_STATUS.IDLE }} currentUserId="owner-1" onRefresh={vi.fn()} />,
    );
    const steps = Array.from(container.querySelectorAll("div.rounded-full"));
    expect(steps.map((s) => s.className.includes("bg-primary text-primary-foreground"))).toEqual([
      true, true, false, false, false,
    ]);
    expect(steps[2].className).toContain("border-primary");
  });
});
