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

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('revokeAllPasskeysDone:{"name":"Alice"}'));
    expect(mockFetch).toHaveBeenCalledWith("/api/tenant/members/u-1/passkeys", { method: "DELETE" });
    expect(await screen.findByText("memberPasskeysEmpty")).toBeInTheDocument();
  });

  it("shows the revoke-all error on a refused revoke-all and reloads the list", async () => {
    mockFetch
      .mockResolvedValueOnce(listResponse([PASSKEY]))
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: "NOT_FOUND" }) })
      .mockResolvedValueOnce(listResponse([PASSKEY]));
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("button", { name: "revokeAllPasskeys" }));
    fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("revokeAllPasskeysFailed"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("opens the recent-session dialog when revoke-all needs a step-up, with no toast", async () => {
    mockFetch
      .mockResolvedValueOnce(listResponse([PASSKEY]))
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "SESSION_STEP_UP_REQUIRED" }) });
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("button", { name: "revokeAllPasskeys" }));
    fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);

    await waitFor(() => expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument());
    expect(mockFetch).toHaveBeenLastCalledWith("/api/tenant/members/u-1/passkeys", { method: "DELETE" });
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("offers revoke-all for a member with no passkeys (an SSO-only member), sending no body", async () => {
    mockFetch
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce(listResponse([]));
    render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("memberPasskeysEmpty")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "revokeAllPasskeys" }));
    fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('revokeAllPasskeysDone:{"name":"Alice"}'));
    expect(mockFetch).toHaveBeenCalledWith("/api/tenant/members/u-1/passkeys", { method: "DELETE" });
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

  describe("containment", () => {
    const LISTING = {
      passkeys: [PASSKEY],
      linkedAccounts: [
        { id: "acc-1", provider: "google", linkedInTenant: true },
        { id: "acc-2", provider: "saml-jackson", linkedInTenant: false },
      ],
      createdFootholds: {
        scimTokens: [{ id: "scim-1", description: "Okta provisioning", createdAt: "2026-01-01T00:00:00Z" }],
        serviceAccounts: [{ id: "sa-1", name: "deploy-bot" }],
        serviceAccountTokens: [{ id: "sat-1", name: "ci-token", serviceAccount: { name: "prod-sa" } }],
        mcpClients: [{ id: "mcp-1", name: "agent-client" }],
        breakglassGrants: [{ id: "bg-1", reason: "incident 42", expiresAt: "2026-02-01T00:00:00Z" }],
        emergencyAccessGrants: [{ id: "ea-1", granteeEmail: "unknown@example.net", status: "ACCEPTED", hasEscrow: true }],
      },
    };

    function open() {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => LISTING });
      render(<TenantMemberPasskeysDialog userId="u-1" memberName="Alice" />);
      fireEvent.click(screen.getByRole("button"));
    }

    it("lists linked accounts and every foothold kind with an unchecked checkbox each", async () => {
      open();
      expect(await screen.findByText("google")).toBeInTheDocument();
      for (const label of ["saml-jackson", "Okta provisioning", "deploy-bot", "ci-token", "agent-client", "incident 42", "unknown@example.net"]) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      expect(screen.getByText("containmentLinkedAccountOtherTenant")).toBeInTheDocument();
      expect(screen.getByText("containmentEscrowed")).toBeInTheDocument();
      const boxes = screen.getAllByRole("checkbox");
      expect(boxes).toHaveLength(8);
      for (const box of boxes) expect(box).not.toBeChecked();
      expect(screen.getByText("containmentDeactivateNote")).toBeInTheDocument();
      expect(screen.getByText("containmentScope")).toBeInTheDocument();
    });

    it("sends no body when nothing is ticked, and the confirm lists nothing more", async () => {
      open();
      fireEvent.click(await screen.findByRole("button", { name: "revokeAllPasskeys" }));
      expect(screen.queryByTestId("containment-chosen")).not.toBeInTheDocument();
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => LISTING });
      fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);

      await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
      expect(mockFetch).toHaveBeenNthCalledWith(2, "/api/tenant/members/u-1/passkeys", { method: "DELETE" });
    });

    it("posts exactly the ticked ids, lists them in the confirm, and shows each chosen kind's warning", async () => {
      open();
      fireEvent.click(await screen.findByLabelText("google"));
      fireEvent.click(screen.getByLabelText(/ci-token/));
      fireEvent.click(screen.getByLabelText(/unknown@example.net/));
      fireEvent.click(screen.getByLabelText("agent-client"));
      fireEvent.click(screen.getByRole("button", { name: "revokeAllPasskeys" }));

      const chosen = screen.getByTestId("containment-chosen");
      expect([...chosen.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
        "google",
        "ci-token",
        "agent-client",
        "unknown@example.net",
      ]);
      expect(screen.getByText(/^containmentUnlinkWarning/)).toBeInTheDocument();
      expect(screen.getByText("containmentIntegrationsWarning")).toBeInTheDocument();
      expect(screen.getByText("containmentEmergencyWarning")).toBeInTheDocument();

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => LISTING });
      fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
      const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(url).toBe("/api/tenant/members/u-1/passkeys");
      expect(init.method).toBe("DELETE");
      expect(JSON.parse(init.body as string)).toEqual({
        unlinkAccountIds: ["acc-1"],
        revoke: { serviceAccountTokenIds: ["sat-1"], mcpClientIds: ["mcp-1"], emergencyAccessGrantIds: ["ea-1"] },
      });
    });

    it("warns naming each kind the server skipped, after the success toast", async () => {
      open();
      fireEvent.click(await screen.findByLabelText("google"));
      fireEvent.click(screen.getByLabelText("deploy-bot"));
      fireEvent.click(screen.getByLabelText(/ci-token/));
      fireEvent.click(screen.getByRole("button", { name: "revokeAllPasskeys" }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          contained: {
            accounts: { revoked: 1, skipped: 0 },
            serviceAccounts: { revoked: 0, skipped: 1 },
            serviceAccountTokens: { revoked: 0, skipped: 1 },
          },
        }),
      });
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => LISTING });
      fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);

      await waitFor(() => expect(mockToast.warning).toHaveBeenCalledTimes(1));
      expect(mockToast.warning).toHaveBeenCalledWith(
        'containmentSkipped:{"kinds":"containmentNameServiceAccounts and containmentNameServiceAccountTokens"}',
        expect.anything(),
      );
      expect(mockToast.success).toHaveBeenCalledWith('revokeAllPasskeysDone:{"name":"Alice"}');
    });

    it("does not warn when nothing was skipped", async () => {
      open();
      fireEvent.click(await screen.findByLabelText("deploy-bot"));
      fireEvent.click(screen.getByRole("button", { name: "revokeAllPasskeys" }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, contained: { serviceAccounts: { revoked: 1, skipped: 0 } } }),
      });
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => LISTING });
      fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);

      await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
      expect(mockToast.warning).not.toHaveBeenCalled();
    });

    it("keeps the ticked rows still listed after a failed revoke-all, dropping only ones no longer listed", async () => {
      open();
      fireEvent.click(await screen.findByLabelText("google"));
      fireEvent.click(screen.getByLabelText("deploy-bot"));
      fireEvent.click(screen.getByRole("button", { name: "revokeAllPasskeys" }));
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "INTERNAL_ERROR" }) });
      // The reloaded list no longer has the service account.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...LISTING, createdFootholds: { ...LISTING.createdFootholds, serviceAccounts: [] } }),
      });
      fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("revokeAllPasskeysFailed"));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(screen.queryByText("deploy-bot")).not.toBeInTheDocument());
      expect(screen.getByLabelText("google")).toBeChecked();
      expect(screen.getAllByRole("checkbox").filter((box) => box.getAttribute("aria-checked") === "true")).toHaveLength(1);

      // The retry sends only what is still ticked.
      fireEvent.click(screen.getByRole("button", { name: "revokeAllPasskeys" }));
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => LISTING });
      fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(5));
      expect(JSON.parse((mockFetch.mock.calls[3][1] as RequestInit).body as string)).toEqual({ unlinkAccountIds: ["acc-1"] });
    });

    it("clears the selection after a successful revoke-all", async () => {
      open();
      fireEvent.click(await screen.findByLabelText("google"));
      fireEvent.click(screen.getByRole("button", { name: "revokeAllPasskeys" }));
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => LISTING });
      fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(screen.getByLabelText("google")).not.toBeChecked());
    });

    it("an unticked box is not sent", async () => {
      open();
      const box = await screen.findByLabelText("google");
      fireEvent.click(box);
      fireEvent.click(box);
      fireEvent.click(screen.getByLabelText("deploy-bot"));
      fireEvent.click(screen.getByRole("button", { name: "revokeAllPasskeys" }));
      expect(screen.queryByText(/^containmentUnlinkWarning/)).not.toBeInTheDocument();
      expect(screen.getByText("containmentIntegrationsWarning")).toBeInTheDocument();
      expect(screen.queryByText("containmentEmergencyWarning")).not.toBeInTheDocument();

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => LISTING });
      fireEvent.click(screen.getAllByRole("button", { name: "revokeAllPasskeys" }).at(-1)!);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
      expect(JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string)).toEqual({
        revoke: { serviceAccountIds: ["sa-1"] },
      });
    });
  });
});
