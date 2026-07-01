// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { VAULT_CONFIRMATION_PHRASE } from "@/lib/constants/vault";

const {
  mockFetch,
  mockCanUsePasskeyRecovery,
  mockReauthenticateWithPasskey,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockCanUsePasskeyRecovery: vi.fn(),
  mockReauthenticateWithPasskey: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
  withBasePath: (p: string) => p,
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import { setupPasskeyReauthDialogMocks } from "@/__tests__/helpers/passkey-reauth-mocks";
setupPasskeyReauthDialogMocks();

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import VaultResetPage from "./page";

const TOKEN = VAULT_CONFIRMATION_PHRASE.DELETE_VAULT;

describe("VaultResetPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true });
  });

  it("disables the submit button until the confirmation phrase is typed", () => {
    render(<VaultResetPage />);
    const submit = screen.getByRole("button", { name: "resetButton" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("confirmationLabel"), {
      target: { value: TOKEN },
    });
    expect(submit).not.toBeDisabled();
  });

  // RT8: a stale-session reset must surface the reauth recovery path, not the
  // inline error string, and must NOT navigate away.
  it("opens the recent-session dialog on a SESSION_STEP_UP_REQUIRED reset (RT8)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
    });

    render(<VaultResetPage />);
    fireEvent.change(screen.getByLabelText("confirmationLabel"), {
      target: { value: TOKEN },
    });
    fireEvent.click(screen.getByRole("button", { name: "resetButton" }));

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    // The inline error string must NOT be shown for a step-up denial.
    expect(screen.queryByText("unknownError")).toBeNull();
  });
});
