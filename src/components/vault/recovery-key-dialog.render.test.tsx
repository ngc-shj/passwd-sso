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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

const {
  mockComputeVerifier,
  mockGenerateRecoveryKey,
  mockFormatRecoveryKey,
  mockWrap,
  mockReadApiErrorBody,
  mockFetchApi,
  mockCopy,
  mockToast,
} = vi.hoisted(() => ({
  mockComputeVerifier: vi.fn(),
  mockGenerateRecoveryKey: vi.fn(),
  mockFormatRecoveryKey: vi.fn(),
  mockWrap: vi.fn(),
  mockReadApiErrorBody: vi.fn(),
  mockFetchApi: vi.fn(),
  mockCopy: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  computePassphraseVerifier: mockComputeVerifier,
}));

vi.mock("@/lib/crypto/crypto-recovery", () => ({
  generateRecoveryKey: mockGenerateRecoveryKey,
  formatRecoveryKey: mockFormatRecoveryKey,
  wrapSecretKeyWithRecovery: mockWrap,
}));

// The real API_ERROR: the flow classifies refusals by those codes.
vi.mock("@/lib/http/api-error-codes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/api-error-codes")>()),
  apiErrorToI18nKey: (code: string) => `apiErr:${code}`,
}));

vi.mock("@/lib/http/read-api-error-body", () => ({
  readApiErrorBody: mockReadApiErrorBody,
}));

vi.mock("@/lib/clipboard/copy-secret", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clipboard/copy-secret")>()),
  copySecretWithoutClear: mockCopy,
}));

vi.mock("@/lib/ui/ime-guard", () => ({
  preventIMESubmit: vi.fn(),
}));

vi.mock("@/lib/constants", () => ({
  API_PATH: { VAULT_RECOVERY_KEY_GENERATE: "/api/vault/recovery-key/generate" },
  LOCAL_STORAGE_KEY: { RECOVERY_KEY_BANNER_DISMISSED: "psso:recovery-key-banner-dismissed" },
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: mockFetchApi,
}));

vi.mock("sonner", () => ({
  toast: mockToast,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="dialog">
        <button type="button" onClick={() => onOpenChange(false)}>
          dismiss-dialog
        </button>
        {children}
      </div>
    ) : null,
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
  Checkbox: ({
    id,
    checked,
    onCheckedChange,
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}));

import { RecoveryKeyDialog } from "./recovery-key-dialog";
import { COPY_OUTCOME } from "@/lib/clipboard/copy-secret";

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

const FORMATTED_KEY = "ABCD-EFGH-IJKL";
const DISMISS_KEY = "psso:recovery-key-banner-dismissed";

function submitPassphrase(value = "my passphrase") {
  fireEvent.change(screen.getByLabelText("currentPassphrase"), { target: { value } });
  fireEvent.click(screen.getByText("recoveryKey"));
}

async function reachDisplayStep(onOpenChange = vi.fn()) {
  render(<RecoveryKeyDialog open={true} onOpenChange={onOpenChange} />);
  submitPassphrase();
  await screen.findByText(FORMATTED_KEY);
  return onOpenChange;
}

describe("RecoveryKeyDialog generate flow", () => {
  beforeEach(() => {
    vault.hasRecoveryKey = false;
    vault.recoveryKeyInvalidated = false;
    vi.clearAllMocks();
    localStorage.clear();
    vault.getSecretKey.mockReturnValue(new Uint8Array([1, 2, 3]));
    vault.getAccountSalt.mockReturnValue(new Uint8Array([4, 5, 6]));
    mockComputeVerifier.mockResolvedValue("current-verifier");
    mockGenerateRecoveryKey.mockReturnValue(new Uint8Array(32));
    mockWrap.mockResolvedValue({
      encryptedSecretKey: "esk",
      iv: "iv",
      authTag: "tag",
      hkdfSalt: "salt",
      verifierHash: "rk-verifier",
    });
    mockFetchApi.mockResolvedValue({ ok: true });
    mockFormatRecoveryKey.mockResolvedValue(FORMATTED_KEY);
  });

  it("asks to unlock the vault instead of calling the API when no secret key is held", async () => {
    vault.getSecretKey.mockReturnValue(null);
    render(<RecoveryKeyDialog open={true} onOpenChange={vi.fn()} />);

    submitPassphrase();

    expect(await screen.findByText("vaultMustBeUnlocked")).toBeInTheDocument();
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("posts the wrapped key to the generate endpoint and shows the formatted recovery key", async () => {
    await reachDisplayStep();

    expect(mockComputeVerifier).toHaveBeenCalledWith("my passphrase", new Uint8Array([4, 5, 6]));
    const [url, init] = mockFetchApi.mock.calls[0];
    expect(url).toBe("/api/vault/recovery-key/generate");
    expect(JSON.parse(init.body)).toEqual({
      currentVerifierHash: "current-verifier",
      encryptedSecretKey: "esk",
      secretKeyIv: "iv",
      secretKeyAuthTag: "tag",
      hkdfSalt: "salt",
      verifierHash: "rk-verifier",
    });
    expect(screen.getByText("recoveryKeyWarning")).toBeInTheDocument();
  });

  it("shows the invalid-passphrase message when the server rejects the passphrase", async () => {
    mockFetchApi.mockResolvedValue({ ok: false });
    mockReadApiErrorBody.mockResolvedValue({ error: "INVALID_PASSPHRASE" });
    render(<RecoveryKeyDialog open={true} onOpenChange={vi.fn()} />);

    submitPassphrase();

    expect(await screen.findByText("invalidPassphrase")).toBeInTheDocument();
    expect(screen.queryByText(FORMATTED_KEY)).toBeNull();
  });

  it("maps any other server error code through apiErrorToI18nKey", async () => {
    mockFetchApi.mockResolvedValue({ ok: false });
    mockReadApiErrorBody.mockResolvedValue({ error: "RATE_LIMIT_EXCEEDED" });
    render(<RecoveryKeyDialog open={true} onOpenChange={vi.fn()} />);

    submitPassphrase();

    expect(await screen.findByText("apiErr:RATE_LIMIT_EXCEEDED")).toBeInTheDocument();
    expect(screen.queryByText("recoveryKeyOutcomeUnknown")).toBeNull();
  });

  it("tells the user to generate a new key, without showing one, when a 502 carries no app error envelope", async () => {
    mockFetchApi.mockResolvedValue({ ok: false, status: 502 });
    mockReadApiErrorBody.mockResolvedValue(null);
    render(<RecoveryKeyDialog open={true} onOpenChange={vi.fn()} />);

    submitPassphrase();

    expect(await screen.findByText("recoveryKeyOutcomeUnknown")).toBeInTheDocument();
    expect(screen.queryByText(FORMATTED_KEY)).toBeNull();
    expect(screen.queryByText("recoveryKeyWarning")).toBeNull();
    expect(vault.setHasRecoveryKey).not.toHaveBeenCalled();
    expect(screen.getByText("recoveryKey")).not.toBeDisabled();
  });

  it("tells the user to generate a new key, without showing one, when the POST rejects in transit", async () => {
    mockFetchApi.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<RecoveryKeyDialog open={true} onOpenChange={vi.fn()} />);

    submitPassphrase();

    expect(await screen.findByText("recoveryKeyOutcomeUnknown")).toBeInTheDocument();
    expect(screen.queryByText(FORMATTED_KEY)).toBeNull();
    expect(screen.queryByText("unknownError")).toBeNull();
  });

  it("copies the displayed recovery key and confirms with a success toast", async () => {
    mockCopy.mockResolvedValue(COPY_OUTCOME.OK);
    await reachDisplayStep();

    const copyButton = screen.getByText(FORMATTED_KEY).parentElement?.querySelector("button");
    if (!copyButton) throw new Error("copy button not rendered");
    fireEvent.click(copyButton);

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("recoveryKeyCopySuccess"));
    const getter = mockCopy.mock.calls[0][0];
    expect(getter()).toBe(FORMATTED_KEY);
  });

  it("reports a failed copy instead of staying silent", async () => {
    mockCopy.mockResolvedValue(COPY_OUTCOME.WRITE_FAILED);
    await reachDisplayStep();

    const copyButton = screen.getByText(FORMATTED_KEY).parentElement?.querySelector("button");
    if (!copyButton) throw new Error("copy button not rendered");
    fireEvent.click(copyButton);

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("copyWriteFailed"));
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("keeps the close button disabled until the user confirms the key is saved", async () => {
    await reachDisplayStep();

    expect(screen.getByText("recoveryKeyClose")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("recoveryKeySavedConfirm"));
    expect(screen.getByText("recoveryKeyClose")).not.toBeDisabled();
  });

  it("marks the recovery key as set, clears the banner dismissal and closes on confirm", async () => {
    localStorage.setItem(DISMISS_KEY, "123");
    const onOpenChange = await reachDisplayStep();

    fireEvent.click(screen.getByLabelText("recoveryKeySavedConfirm"));
    fireEvent.click(screen.getByText("recoveryKeyClose"));

    expect(vault.setHasRecoveryKey).toHaveBeenCalledWith(true);
    expect(localStorage.getItem(DISMISS_KEY)).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("resets to an empty passphrase step when the dialog is dismissed", async () => {
    const onOpenChange = await reachDisplayStep();

    fireEvent.click(screen.getByText("dismiss-dialog"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText(FORMATTED_KEY)).toBeNull();
    const input = screen.getByLabelText("currentPassphrase");
    expect(input).toHaveValue("");
    expect(vault.setHasRecoveryKey).not.toHaveBeenCalled();
  });
});
