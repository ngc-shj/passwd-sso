// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const {
  mockUseVault,
  mockUsePathname,
  mockUseSearchParams,
  mockVaultSetupWizard,
  mockAutoExtensionConnect,
} = vi.hoisted(() => ({
  mockUseVault: vi.fn(),
  mockUsePathname: vi.fn(),
  mockUseSearchParams: vi.fn(),
  mockVaultSetupWizard: vi.fn(),
  mockAutoExtensionConnect: vi.fn(),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mockUseVault,
}));

vi.mock("next/navigation", () => ({
  usePathname: mockUsePathname,
  useSearchParams: mockUseSearchParams,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("./vault-setup-wizard", () => ({
  VaultSetupWizard: (props: { contextMessage?: string }) => {
    mockVaultSetupWizard(props);
    return (
      <div data-testid="vault-setup-wizard">
        {props.contextMessage && (
          <span data-testid="context-message">{props.contextMessage}</span>
        )}
      </div>
    );
  },
}));

vi.mock("./vault-lock-screen", () => ({
  VaultLockScreen: () => <div data-testid="vault-lock-screen" />,
}));

vi.mock("@/components/extension/auto-extension-connect", () => ({
  AutoExtensionConnect: (props: { onActiveChange?: (active: boolean) => void }) => {
    mockAutoExtensionConnect(props);
    return <div data-testid="auto-extension-connect" />;
  },
}));

vi.mock("@/lib/constants", () => ({
  EXT_CONNECT_PARAM: "ext_connect",
  VAULT_STATUS: {
    LOADING: "LOADING",
    LOCKED: "LOCKED",
    UNLOCKED: "UNLOCKED",
    SETUP_REQUIRED: "SETUP_REQUIRED",
  },
}));

import { VaultGate } from "./vault-gate";

// ── Tests ───────────────────────────────────────────────────

describe("VaultGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue("/en/dashboard");
    // Default: no ext_connect param.
    mockUseSearchParams.mockReturnValue(new URLSearchParams());
  });

  describe("ext_connect", () => {
    it("shows the connect overlay ahead of the vault lock screen (no passphrase prompt)", () => {
      mockUseVault.mockReturnValue({ status: "LOCKED" });
      mockUseSearchParams.mockReturnValue(new URLSearchParams("ext_connect=1"));

      render(<VaultGate><div data-testid="child-content">hello</div></VaultGate>);

      // Connect overlay shows; the lock screen / passphrase prompt does NOT.
      expect(screen.getByTestId("auto-extension-connect")).toBeInTheDocument();
      expect(screen.queryByTestId("vault-lock-screen")).not.toBeInTheDocument();
      expect(screen.queryByTestId("child-content")).not.toBeInTheDocument();
    });

    it("shows the connect overlay even while the vault status is still LOADING", () => {
      mockUseVault.mockReturnValue({ status: "LOADING" });
      mockUseSearchParams.mockReturnValue(new URLSearchParams("ext_connect=1"));

      const { container } = render(<VaultGate><div>children</div></VaultGate>);

      expect(screen.getByTestId("auto-extension-connect")).toBeInTheDocument();
      // No loading spinner — the overlay takes precedence.
      expect(container.querySelector("svg")).not.toBeInTheDocument();
    });

    it("does NOT bypass the setup wizard when the vault is not yet initialized", () => {
      // SETUP_REQUIRED must win over the connect overlay: an uninitialized vault
      // has nothing for the extension to use, and bypassing setup would let the
      // connect flow mint an extension token before the vault exists.
      mockUseVault.mockReturnValue({ status: "SETUP_REQUIRED" });
      mockUseSearchParams.mockReturnValue(new URLSearchParams("ext_connect=1"));

      render(<VaultGate><div>children</div></VaultGate>);

      expect(screen.getByTestId("vault-setup-wizard")).toBeInTheDocument();
      expect(screen.queryByTestId("auto-extension-connect")).not.toBeInTheDocument();
    });

    it("falls back to the normal gate once the connect flow reports idle", () => {
      mockUseVault.mockReturnValue({ status: "LOCKED" });
      mockUseSearchParams.mockReturnValue(new URLSearchParams("ext_connect=1"));

      render(<VaultGate><div>children</div></VaultGate>);

      // The overlay reports idle (dismissed / done) via onActiveChange(false).
      const { onActiveChange } = mockAutoExtensionConnect.mock.calls[0][0];
      React.act(() => onActiveChange(false));

      // Now the normal vault gate takes over — lock screen shows.
      expect(screen.getByTestId("vault-lock-screen")).toBeInTheDocument();
      expect(screen.queryByTestId("auto-extension-connect")).not.toBeInTheDocument();
    });
  });

  describe("SETUP_REQUIRED status", () => {
    it("passes contextMessage to VaultSetupWizard when pathname is a teams invite route", () => {
      mockUseVault.mockReturnValue({ status: "SETUP_REQUIRED" });
      mockUsePathname.mockReturnValue("/en/dashboard/teams/invite/abc123");

      render(<VaultGate><div>children</div></VaultGate>);

      expect(screen.getByTestId("vault-setup-wizard")).toBeInTheDocument();
      expect(mockVaultSetupWizard).toHaveBeenCalledWith(
        expect.objectContaining({ contextMessage: "setupInviteContext" }),
      );
      expect(screen.getByTestId("context-message")).toBeInTheDocument();
    });

    it("passes contextMessage to VaultSetupWizard when pathname is an emergency-access invite route", () => {
      mockUseVault.mockReturnValue({ status: "SETUP_REQUIRED" });
      mockUsePathname.mockReturnValue("/en/dashboard/emergency-access/invite/tok-xyz");

      render(<VaultGate><div>children</div></VaultGate>);

      expect(screen.getByTestId("vault-setup-wizard")).toBeInTheDocument();
      expect(mockVaultSetupWizard).toHaveBeenCalledWith(
        expect.objectContaining({ contextMessage: "setupInviteContext" }),
      );
    });

    it("does NOT pass contextMessage when pathname is not an invite route", () => {
      mockUseVault.mockReturnValue({ status: "SETUP_REQUIRED" });
      mockUsePathname.mockReturnValue("/en/dashboard/passwords");

      render(<VaultGate><div>children</div></VaultGate>);

      expect(screen.getByTestId("vault-setup-wizard")).toBeInTheDocument();
      expect(mockVaultSetupWizard).toHaveBeenCalledWith(
        expect.objectContaining({ contextMessage: undefined }),
      );
      expect(screen.queryByTestId("context-message")).not.toBeInTheDocument();
    });

    it("does NOT pass contextMessage for a teams route that is not an invite", () => {
      mockUseVault.mockReturnValue({ status: "SETUP_REQUIRED" });
      mockUsePathname.mockReturnValue("/en/dashboard/teams/team-id-123");

      render(<VaultGate><div>children</div></VaultGate>);

      expect(mockVaultSetupWizard).toHaveBeenCalledWith(
        expect.objectContaining({ contextMessage: undefined }),
      );
    });
  });

  describe("UNLOCKED status", () => {
    it("renders children when vault is UNLOCKED", () => {
      mockUseVault.mockReturnValue({ status: "UNLOCKED" });

      render(<VaultGate><div data-testid="child-content">hello</div></VaultGate>);

      expect(screen.getByTestId("child-content")).toBeInTheDocument();
      expect(screen.queryByTestId("vault-setup-wizard")).not.toBeInTheDocument();
      expect(screen.queryByTestId("vault-lock-screen")).not.toBeInTheDocument();
    });
  });

  describe("LOCKED status", () => {
    it("renders VaultLockScreen when vault is LOCKED", () => {
      mockUseVault.mockReturnValue({ status: "LOCKED" });

      render(<VaultGate><div>children</div></VaultGate>);

      expect(screen.getByTestId("vault-lock-screen")).toBeInTheDocument();
      expect(screen.queryByTestId("vault-setup-wizard")).not.toBeInTheDocument();
    });
  });

  describe("LOADING status", () => {
    it("renders loading spinner when vault is LOADING", () => {
      mockUseVault.mockReturnValue({ status: "LOADING" });

      const { container } = render(<VaultGate><div>children</div></VaultGate>);

      // Loading state renders a Loader2 spinner — no wizard or lock screen
      expect(screen.queryByTestId("vault-setup-wizard")).not.toBeInTheDocument();
      expect(screen.queryByTestId("vault-lock-screen")).not.toBeInTheDocument();
      expect(container.querySelector("svg")).toBeInTheDocument();
    });
  });
});
