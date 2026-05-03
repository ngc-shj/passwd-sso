// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Shield, Plus } from "lucide-react";

const { mockUseVault } = vi.hoisted(() => ({
  mockUseVault: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
}));

import { VaultActionCard } from "./vault-action-card";

function FakeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <div data-testid="fake-dialog" data-open={String(open)}>
      <button type="button" onClick={() => onOpenChange(false)}>close</button>
    </div>
  );
}

describe("VaultActionCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables the action button when vault is not unlocked (R26 disabled cue)", () => {
    mockUseVault.mockReturnValue({ status: "locked" });
    render(
      <VaultActionCard
        icon={Shield}
        title="Recovery"
        description="Set up recovery"
        buttonIcon={Plus}
        buttonLabel="Setup"
        Dialog={FakeDialog}
      />,
    );
    const btn = screen.getByRole("button", { name: /Setup/ });
    expect(btn).toBeDisabled();
  });

  it("renders the locked-vault hint when status is LOCKED", () => {
    mockUseVault.mockReturnValue({ status: "locked" });
    render(
      <VaultActionCard
        icon={Shield}
        title="Recovery"
        description="Set up recovery"
        buttonIcon={Plus}
        buttonLabel="Setup"
        Dialog={FakeDialog}
      />,
    );
    // Translator returns key as-is
    expect(
      screen.getByText("vaultLockedPlaceholder.description"),
    ).toBeInTheDocument();
  });

  it("does not render the locked hint when status is LOADING", () => {
    mockUseVault.mockReturnValue({ status: "loading" });
    render(
      <VaultActionCard
        icon={Shield}
        title="Recovery"
        description="Set up recovery"
        buttonIcon={Plus}
        buttonLabel="Setup"
        Dialog={FakeDialog}
      />,
    );
    expect(
      screen.queryByText("vaultLockedPlaceholder.description"),
    ).toBeNull();
  });

  it("enables button and opens the dialog when status is UNLOCKED and button is clicked", () => {
    mockUseVault.mockReturnValue({ status: "unlocked" });
    render(
      <VaultActionCard
        icon={Shield}
        title="Recovery"
        description="Set up recovery"
        buttonIcon={Plus}
        buttonLabel="Setup"
        Dialog={FakeDialog}
      />,
    );
    const btn = screen.getByRole("button", { name: /Setup/ });
    expect(btn).not.toBeDisabled();
    expect(screen.getByTestId("fake-dialog")).toHaveAttribute(
      "data-open",
      "false",
    );
    fireEvent.click(btn);
    expect(screen.getByTestId("fake-dialog")).toHaveAttribute(
      "data-open",
      "true",
    );
  });
});
