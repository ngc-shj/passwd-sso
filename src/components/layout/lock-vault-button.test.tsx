// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────
const { mockUseVault, mockLock } = vi.hoisted(() => ({
  mockUseVault: vi.fn(),
  mockLock: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mockUseVault,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...rest }: React.ComponentProps<"button">) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { LockVaultButton } from "./lock-vault-button";
import { VAULT_STATUS } from "@/lib/constants";

describe("LockVaultButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLock.mockReset();
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.UNLOCKED,
      lock: mockLock,
    });
  });

  it("renders when vault is UNLOCKED", () => {
    render(<LockVaultButton />);

    expect(screen.getByRole("button", { name: "lockVault" })).toBeInTheDocument();
  });

  it("does not render when vault is LOCKED", () => {
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.LOCKED,
      lock: mockLock,
    });

    render(<LockVaultButton />);

    expect(screen.queryByRole("button", { name: "lockVault" })).not.toBeInTheDocument();
  });

  it("does not render when vault is SETUP_REQUIRED", () => {
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.SETUP_REQUIRED,
      lock: mockLock,
    });

    render(<LockVaultButton />);

    expect(screen.queryByRole("button", { name: "lockVault" })).not.toBeInTheDocument();
  });

  it("does not render when vault is LOADING", () => {
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.LOADING,
      lock: mockLock,
    });

    render(<LockVaultButton />);

    expect(screen.queryByRole("button", { name: "lockVault" })).not.toBeInTheDocument();
  });

  it("calls lock() on click when vault is UNLOCKED", async () => {
    render(<LockVaultButton />);

    fireEvent.click(screen.getByRole("button", { name: "lockVault" }));

    expect(mockLock).toHaveBeenCalledTimes(1);
  });

  it("shows success toast on click when vault is UNLOCKED", async () => {
    const { toast } = await import("sonner");

    render(<LockVaultButton />);

    fireEvent.click(screen.getByRole("button", { name: "lockVault" }));

    expect(toast.success).toHaveBeenCalledWith("lockVault");
  });

  it("hides the button after vaultStatus transitions from UNLOCKED to LOCKED (auto-lock during session)", () => {
    // Initial render with UNLOCKED — button visible
    const { rerender } = render(<LockVaultButton />);
    expect(screen.getByRole("button", { name: "lockVault" })).toBeInTheDocument();

    // Auto-lock fires: status becomes LOCKED. Re-render to propagate.
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.LOCKED,
      lock: mockLock,
    });
    rerender(<LockVaultButton />);

    // Button is no longer rendered — clicking is impossible (the gate
    // returns null before any handler is attached).
    expect(screen.queryByRole("button", { name: "lockVault" })).not.toBeInTheDocument();
    expect(mockLock).not.toHaveBeenCalled();
  });
});
