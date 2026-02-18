// @vitest-environment jsdom
/**
 * RepromptDialog — IME composition guard tests
 *
 * Covers:
 *   - Enter during IME composition does NOT trigger verify
 *   - Enter after IME composition triggers verify
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted mocks ──────────────────────────────────────────

const { mockVerifyPassphrase } = vi.hoisted(() => ({
  mockVerifyPassphrase: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault-context", () => ({
  useVault: () => ({
    verifyPassphrase: mockVerifyPassphrase,
  }),
}));

// Simplified Dialog — render content directly when open
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled, onClick, ...rest }: React.ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick} {...rest}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({ id, value, onChange, onKeyDown, ...rest }: React.ComponentProps<"input">) => (
    <input id={id} value={value} onChange={onChange} onKeyDown={onKeyDown} {...rest} />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...rest }: React.ComponentProps<"label">) => (
    <label {...rest}>{children}</label>
  ),
}));

import { RepromptDialog } from "./reprompt-dialog";

// ── Tests ──────────────────────────────────────────────────

describe("RepromptDialog IME composition", () => {
  let mockOnVerified: ReturnType<typeof vi.fn>;
  let mockOnCancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnVerified = vi.fn();
    mockOnCancel = vi.fn();
    mockVerifyPassphrase.mockResolvedValue(true);
  });

  it("does not trigger verify when Enter is pressed during IME composition", async () => {
    render(
      <RepromptDialog
        open={true}
        onVerified={mockOnVerified}
        onCancel={mockOnCancel}
      />,
    );

    const input = screen.getByLabelText("label");
    fireEvent.change(input, { target: { value: "パスフレーズ" } });

    // Simulate Enter during IME composition (isComposing: true)
    await act(async () => {
      const composingEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      input.dispatchEvent(composingEnter);
    });

    expect(mockVerifyPassphrase).not.toHaveBeenCalled();
  });

  it("triggers verify when Enter is pressed after IME composition is done", async () => {
    render(
      <RepromptDialog
        open={true}
        onVerified={mockOnVerified}
        onCancel={mockOnCancel}
      />,
    );

    const input = screen.getByLabelText("label");
    fireEvent.change(input, { target: { value: "パスフレーズ" } });

    // Normal Enter (isComposing defaults to false)
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => {
      expect(mockVerifyPassphrase).toHaveBeenCalledWith("パスフレーズ");
    });
  });
});
