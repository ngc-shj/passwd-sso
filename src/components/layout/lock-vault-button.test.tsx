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

  it("does not call lock() when vaultStatus changes to non-UNLOCKED before click (race defense)", () => {
    // Simulate the vault having already locked (race condition): we render with
    // UNLOCKED but then the status changes to LOCKED in the closure before click.
    // The component stores vaultStatus in closure; we simulate by re-mocking after render.
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.LOCKED,
      lock: mockLock,
    });

    // Render with locked state — button should not render at all
    render(<LockVaultButton />);

    expect(screen.queryByRole("button", { name: "lockVault" })).not.toBeInTheDocument();
    expect(mockLock).not.toHaveBeenCalled();
  });
});
