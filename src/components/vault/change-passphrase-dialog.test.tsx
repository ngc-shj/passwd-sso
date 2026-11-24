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

const { mockChangePassphrase, mockToast } = vi.hoisted(() => ({
  mockChangePassphrase: vi.fn(),
  mockToast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vault/vault-context")>();
  return {
    useVault: () => ({ changePassphrase: mockChangePassphrase }),
    PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED: actual.PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED,
    // The real classes: the dialog branches on `instanceof`.
    VaultChangeOutcomeUnknownError: actual.VaultChangeOutcomeUnknownError,
    VaultChangedElsewhereError: actual.VaultChangedElsewhereError,
  };
});

vi.mock("@/lib/http/api-error-codes", () => ({
  apiErrorToI18nKey: (code: string) => `apiErr:${code}`,
  API_ERROR: {
    INVALID_PASSPHRASE: "INVALID_PASSPHRASE",
    VERIFIER_NOT_SET: "VERIFIER_NOT_SET",
    RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  },
}));

vi.mock("@/lib/ui/ime-guard", () => ({
  preventIMESubmit: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: mockToast,
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
import { VaultChangedElsewhereError, VaultChangeOutcomeUnknownError } from "@/lib/vault/vault-context";
import { SessionChangedError } from "@/lib/url-helpers";

describe("ChangePassphraseDialog", () => {
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    onOpenChange = vi.fn<(open: boolean) => void>();
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
    mockChangePassphrase.mockResolvedValue({ invalidationFailed: false });
    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));

    await waitFor(() => {
      expect(mockChangePassphrase).toHaveBeenCalledWith("oldpass", "longenoughpass");
    });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(mockToast.success).toHaveBeenCalledWith("passphraseChanged");
    expect(mockToast.warning).not.toHaveBeenCalled();
  });

  it("closes with a persistent sign-out-other-devices warning when the change committed but invalidation failed", async () => {
    mockChangePassphrase.mockResolvedValue({ invalidationFailed: true });
    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(mockToast.warning).toHaveBeenCalledWith("sessionInvalidateFailed", { duration: Infinity });
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(screen.queryByText("apiErr:SESSION_INVALIDATE_FAILED")).toBeNull();
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

  it("keeps the dialog open with the retry-later error when the server is unavailable (SERVICE_UNAVAILABLE)", async () => {
    mockChangePassphrase.mockRejectedValue({ error: "SERVICE_UNAVAILABLE" });

    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));

    expect(await screen.findByText("apiErr:SERVICE_UNAVAILABLE")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(mockToast.warning).not.toHaveBeenCalled();
  });

  it("closes with a persistent locked-vault notice when the change's outcome is unknown", async () => {
    mockChangePassphrase.mockRejectedValue(new VaultChangeOutcomeUnknownError());

    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(mockToast.error).toHaveBeenCalledWith("changePassphraseOutcomeUnknown", { duration: Infinity });
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(screen.queryByText("changePassphraseFailed")).toBeNull();
  });

  // Refused before any route ran: nothing changed, so no locked-vault notice.
  it("shows the changed-session message, not an unknown outcome, when the change is refused for a changed session", async () => {
    mockChangePassphrase.mockRejectedValue(new SessionChangedError());

    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));

    expect(await screen.findByText("sessionChanged")).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(screen.queryByText("changePassphraseFailed")).toBeNull();
  });

  it("closes with a persistent changed-elsewhere notice when another writer moved the wrap", async () => {
    mockChangePassphrase.mockRejectedValue(new VaultChangedElsewhereError("VAULT_WRAP_CONFLICT"));

    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(mockToast.error).toHaveBeenCalledWith("vaultChangedElsewhere", { duration: Infinity });
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("asks to unlock once with the passphrase when the server has no passphrase verifier (VERIFIER_NOT_SET)", async () => {
    mockChangePassphrase.mockRejectedValue({ error: "VERIFIER_NOT_SET" });

    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));

    expect(await screen.findByText("verifierNotSetHint")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  async function submitValidForm() {
    render(<ChangePassphraseDialog open={true} onOpenChange={onOpenChange} />);
    fillForm("oldpass", "longenoughpass", "longenoughpass");
    fireEvent.click(screen.getByRole("button", { name: "changePassphraseButton" }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  }

  it("says the passphrase was not changed when the vault locked before the change was sent", async () => {
    mockChangePassphrase.mockResolvedValue("PASSPHRASE_CHANGE_NOT_STARTED_VAULT_LOCKED");

    await submitValidForm();

    expect(mockToast.warning).toHaveBeenCalledWith("changePassphraseNotStartedVaultLocked", { duration: Infinity });
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("says to unlock with the new passphrase, not that the vault is ready, when it locked while the change committed", async () => {
    mockChangePassphrase.mockResolvedValue({
      outcome: "PASSPHRASE_CHANGE_COMMITTED_VAULT_LOCKED",
      effects: { invalidationFailed: false },
    });

    await submitValidForm();

    expect(mockToast.warning).toHaveBeenCalledWith("changePassphraseCommittedVaultLocked", { duration: Infinity });
    expect(mockToast.warning).not.toHaveBeenCalledWith("sessionInvalidateFailed", expect.anything());
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("still warns that other devices were not signed out when the vault locked while the change committed", async () => {
    mockChangePassphrase.mockResolvedValue({
      outcome: "PASSPHRASE_CHANGE_COMMITTED_VAULT_LOCKED",
      effects: { invalidationFailed: true },
    });

    await submitValidForm();

    expect(mockToast.warning).toHaveBeenCalledWith("changePassphraseCommittedVaultLocked", { duration: Infinity });
    expect(mockToast.warning).toHaveBeenCalledWith("sessionInvalidateFailed", { duration: Infinity });
    expect(mockToast.success).not.toHaveBeenCalled();
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
