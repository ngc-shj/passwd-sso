// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const { mockUseVault, mockUsePathname, mockVaultSetupWizard } = vi.hoisted(() => ({
  mockUseVault: vi.fn(),
  mockUsePathname: vi.fn(),
  mockVaultSetupWizard: vi.fn(),
}));

vi.mock("@/lib/vault-context", () => ({
  useVault: mockUseVault,
}));

vi.mock("next/navigation", () => ({
  usePathname: mockUsePathname,
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
  AutoExtensionConnect: () => null,
}));

vi.mock("@/lib/constants", () => ({
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
