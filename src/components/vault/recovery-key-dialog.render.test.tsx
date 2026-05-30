// @vitest-environment jsdom
/**
 * RecoveryKeyDialog render tests
 *
 * Regression: the passphrase-step warning banner must reflect the actual
 * vault state. When the recovery key is already invalidated, the dialog must
 * NOT claim that generating a new key "will invalidate" the existing one.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { vault } = vi.hoisted(() => ({
  vault: {
    hasRecoveryKey: false,
    recoveryKeyInvalidated: false,
    getSecretKey: vi.fn(),
    getAccountSalt: vi.fn(),
    setHasRecoveryKey: vi.fn(),
  },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => vault,
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  computePassphraseVerifier: vi.fn(),
}));

vi.mock("@/lib/crypto/crypto-recovery", () => ({
  generateRecoveryKey: vi.fn(),
  formatRecoveryKey: vi.fn(),
  wrapSecretKeyWithRecovery: vi.fn(),
}));

vi.mock("@/lib/http/api-error-codes", () => ({
  apiErrorToI18nKey: (code: string) => `apiErr:${code}`,
}));

vi.mock("@/lib/http/read-api-error-body", () => ({
  readApiErrorBody: vi.fn(),
}));

vi.mock("@/lib/ui/ime-guard", () => ({
  preventIMESubmit: vi.fn(),
}));

vi.mock("@/lib/constants", () => ({
  API_PATH: { VAULT_RECOVERY_KEY_GENERATE: "/api/vault/recovery-key/generate" },
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: vi.fn(),
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

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ id }: { id?: string }) => <input id={id} type="checkbox" />,
}));

import { RecoveryKeyDialog } from "./recovery-key-dialog";

describe("RecoveryKeyDialog passphrase-step warning", () => {
  beforeEach(() => {
    vault.hasRecoveryKey = false;
    vault.recoveryKeyInvalidated = false;
    vi.clearAllMocks();
  });

  it("shows the invalidated warning (not the regenerate warning) when recovery key is invalidated", () => {
    vault.recoveryKeyInvalidated = true;

    render(<RecoveryKeyDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("recoveryKeyRegenerateInvalidatedWarning")).toBeInTheDocument();
    expect(screen.queryByText("recoveryKeyRegenerateWarning")).toBeNull();
  });

  it("shows the regenerate warning when a recovery key already exists and is not invalidated", () => {
    vault.hasRecoveryKey = true;

    render(<RecoveryKeyDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("recoveryKeyRegenerateWarning")).toBeInTheDocument();
  });

  it("shows no warning when there is no recovery key and it is not invalidated", () => {
    render(<RecoveryKeyDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.queryByText("recoveryKeyRegenerateInvalidatedWarning")).toBeNull();
    expect(screen.queryByText("recoveryKeyRegenerateWarning")).toBeNull();
  });
});
