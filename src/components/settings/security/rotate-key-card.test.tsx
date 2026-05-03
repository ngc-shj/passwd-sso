// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockUseVault } = vi.hoisted(() => ({
  mockUseVault: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
}));

vi.mock("@/components/vault/rotate-key-dialog", () => ({
  RotateKeyDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-testid="rotate-key-dialog" data-open={String(open)}>
      <button type="button" onClick={() => onOpenChange(false)}>close</button>
    </div>
  ),
}));

import { RotateKeyCard } from "./rotate-key-card";

describe("RotateKeyCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables the rotate button when vault is locked (R26 disabled cue)", () => {
    mockUseVault.mockReturnValue({ status: "locked" });
    render(<RotateKeyCard />);
    const btn = screen.getByRole("button", { name: /rotateKeyButton/ });
    expect(btn).toBeDisabled();
  });

  it("renders vaultMustBeUnlocked hint when locked", () => {
    mockUseVault.mockReturnValue({ status: "locked" });
    render(<RotateKeyCard />);
    expect(screen.getByText("vaultMustBeUnlocked")).toBeInTheDocument();
  });

  it("enables the button and opens the dialog when unlocked", () => {
    mockUseVault.mockReturnValue({ status: "unlocked" });
    render(<RotateKeyCard />);
    const btn = screen.getByRole("button", { name: /rotateKeyButton/ });
    expect(btn).not.toBeDisabled();
    expect(screen.getByTestId("rotate-key-dialog")).toHaveAttribute(
      "data-open",
      "false",
    );
    fireEvent.click(btn);
    expect(screen.getByTestId("rotate-key-dialog")).toHaveAttribute(
      "data-open",
      "true",
    );
  });
});
