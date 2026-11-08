// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetch, mockToast, mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } =
  vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    mockCanUsePasskeyRecovery: vi.fn(),
    mockReauthenticateWithPasskey: vi.fn(),
  }));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

import "@/__tests__/helpers/passkey-reauth-mocks";

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import { TenantMemberPasskeysDialog } from "./tenant-member-passkeys-dialog";

const PASSKEY = {
  id: "cred-1",
  nickname: "YubiKey",
  deviceType: "singleDevice",
  registeredDevice: null,
  registeredInTenant: true,
  createdAt: "2026-01-01T00:00:00Z",
  lastUsedAt: null,
};

function listResponse(passkeys: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ passkeys }) };
}

describe("TenantMemberPasskeysDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  it("disables the trigger when disabled", () => {
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" disabled />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("lists the member's passkeys when opened", async () => {
    mockFetch.mockResolvedValueOnce(listResponse([PASSKEY]));
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("YubiKey")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith("/api/tenant/members/u-1/passkeys");
  });

  it("revokes the chosen passkey after confirmation and reloads the list", async () => {
    mockFetch
      .mockResolvedValueOnce(listResponse([PASSKEY]))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce(listResponse([]));
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("button", { name: "revokePasskey" }));
    // The confirm dialog's own revoke button.
    const confirm = screen.getAllByRole("button", { name: "revokePasskey" }).at(-1)!;
    fireEvent.click(confirm);

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("revokePasskeySuccess"));
    expect(mockFetch).toHaveBeenCalledWith("/api/tenant/members/u-1/passkeys/cred-1", { method: "DELETE" });
    expect(await screen.findByText("memberPasskeysEmpty")).toBeInTheDocument();
  });

  it("shows an error on a refused revoke and reloads the list (the passkey may be gone already)", async () => {
    mockFetch
      .mockResolvedValueOnce(listResponse([PASSKEY]))
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: "NOT_FOUND" }) })
      .mockResolvedValueOnce(listResponse([PASSKEY]));
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("button", { name: "revokePasskey" }));
    fireEvent.click(screen.getAllByRole("button", { name: "revokePasskey" }).at(-1)!);

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("revokePasskeyFailed"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("YubiKey")).toBeInTheDocument();
  });

  it("opens the recent-session dialog on a SESSION_STEP_UP_REQUIRED response, with no toast", async () => {
    mockFetch
      .mockResolvedValueOnce(listResponse([PASSKEY]))
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "SESSION_STEP_UP_REQUIRED" }) });
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("button", { name: "revokePasskey" }));
    fireEvent.click(screen.getAllByRole("button", { name: "revokePasskey" }).at(-1)!);

    await waitFor(() => expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument());
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("revokes all of the member's passkeys after confirmation and reloads the list", async () => {
    mockFetch
      .mockResolvedValueOnce(listResponse([PASSKEY, { ...PASSKEY, id: "cred-2", nickname: "Phone" }]))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, cacheTombstoneFailures: 0 }) })
      .mockResolvedValueOnce(listResponse([]));
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("button", { name: "revokeAllPasskeys" }));
    expect(screen.getByText("revokeAllPasskeysTitle")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("revokeAllPasskeysSuccess"));
    expect(mockFetch).toHaveBeenCalledWith("/api/tenant/members/u-1/passkeys", { method: "DELETE" });
    expect(await screen.findByText("memberPasskeysEmpty")).toBeInTheDocument();
  });

  it("offers no revoke-all when the member has no passkeys", async () => {
    mockFetch.mockResolvedValueOnce(listResponse([]));
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("memberPasskeysEmpty")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "revokeAllPasskeys" })).not.toBeInTheDocument();
  });

  it("says so when the list cannot be loaded", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("memberPasskeysLoadFailed")).toBeInTheDocument();
  });

  it("marks a passkey registered in another tenant", async () => {
    mockFetch.mockResolvedValueOnce(listResponse([{ ...PASSKEY, registeredInTenant: false }]));
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("memberPasskeyOtherTenant")).toBeInTheDocument();
  });
});
