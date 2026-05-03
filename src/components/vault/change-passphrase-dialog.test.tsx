// @vitest-environment jsdom
/**
 * ChangePassphraseDialog tests
 *
 * §Sec-2: type sentinel as new passphrase, simulate error, assert sentinel never in DOM
 * R26: disabled-state cue on submit button (consumed via underlying ui/button.test.tsx;
 *      here we assert `disabled` prop wiring)
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const SENTINEL = "SENTINEL_NOT_A_SECRET_ZJYK";

// ── Hoisted mocks ──────────────────────────────────────────

const { mockChangePassphrase } = vi.hoisted(() => ({
  mockChangePassphrase: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ changePassphrase: mockChangePassphrase }),
}));

vi.mock("@/lib/http/api-error-codes", () => ({
  apiErrorToI18nKey: (code: string) => `apiErr:${code}`,
}));

vi.mock("@/lib/ui/ime-guard", () => ({
  preventIMESubmit: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

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
  Button: ({ children, disabled, onClick, type, ...rest }: React.ComponentProps<"button">) => (
    <button type={type} disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({ id, value, onChange, type, ...rest }: React.ComponentProps<"input">) => (
    <input id={id} value={value} onChange={onChange} type={type} {...rest} />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

import { ChangePassphraseDialog } from "./change-passphrase-dialog";

describe("ChangePassphraseDialog", () => {
  let onOpenChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onOpenChange = vi.fn();
  });

  function fillForm(current: string, next: string, confirm: string) {
    fireEvent.change(screen.getByLabelText("currentPassphrase"), { target: { value: current } });
    fireEvent.change(screen.getByLabelText("newPassphrase"), { target: { value: next } });
    fireEvent.change(screen.getByLabelText("confirmNewPassphrase"), { target: { value: confirm } });
  }

  it("renders title when open", () => {
    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByText("changePassphrase")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(<ChangePassphraseDialog open={false} onOpenChange={onOpenChange} />);
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("disables submit when fields are empty (R26 disabled wiring)", () => {
    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    const submitBtn = screen.getByRole("button", { name: "changePassphraseButton" });
    expect(submitBtn).toBeDisabled();
  });

  it("disables submit when newPassphrase is shorter than PASSPHRASE_MIN_LENGTH", () => {
    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "short", "short");
    const submitBtn = screen.getByRole("button", { name: "changePassphraseButton" });
    expect(submitBtn).toBeDisabled();
  });

  it("disables submit when newPassphrase != confirmPassphrase", () => {
    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "differentpass");
    const submitBtn = screen.getByRole("button", { name: "changePassphraseButton" });
    expect(submitBtn).toBeDisabled();
  });

  it("enables submit when all fields valid", () => {
    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    const submitBtn = screen.getByRole("button", { name: "changePassphraseButton" });
    expect(submitBtn).not.toBeDisabled();
  });

  it("calls changePassphrase with correct args and closes on success", async () => {
    mockChangePassphrase.mockResolvedValue(undefined);
    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));

    await waitFor(() => {
      expect(mockChangePassphrase).toHaveBeenCalledWith("oldpass", "longenoughpass");
    });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("renders mapped error message on INVALID_PASSPHRASE without leaking sentinel (§Sec-2)", async () => {
    mockChangePassphrase.mockRejectedValue({ error: "INVALID_PASSPHRASE" });

    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    // Use sentinel in NEW passphrase (long enough)
    const longSentinel = `${SENTINEL}1234567890`;
    fillForm("oldpass", longSentinel, longSentinel);
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));

    await waitFor(() => {
      expect(screen.getByText("invalidPassphrase")).toBeInTheDocument();
    });

    // Sentinel value is held in input.value (which is acceptable — the input
    // is the user's own typing buffer); but it MUST NOT appear as rendered
    // body text (e.g. an error message containing the secret).
    expect(screen.queryByText(new RegExp(SENTINEL))).toBeNull();
  });

  it("falls back to apiErrorToI18nKey for unknown error codes", async () => {
    mockChangePassphrase.mockRejectedValue({ error: "WEIRD_CODE" });

    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));

    await waitFor(() => {
      expect(screen.getByText("apiErr:WEIRD_CODE")).toBeInTheDocument();
    });
  });

  it("falls back to generic failure when error has no error code", async () => {
    mockChangePassphrase.mockRejectedValue(new Error("network down"));

    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));

    await waitFor(() => {
      expect(screen.getByText("changePassphraseFailed")).toBeInTheDocument();
    });
  });

  it("does not call changePassphrase when form is invalid (submit gate)", async () => {
    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "short", "short");

    // Submit the form directly (bypasses disabled button via form submit event)
    const form = screen.getByLabelText("currentPassphrase").closest("form")!;
    fireEvent.submit(form);

    // Give the microtask queue a chance
    await new Promise((r) => setTimeout(r, 10));
    expect(mockChangePassphrase).not.toHaveBeenCalled();
  });
});
