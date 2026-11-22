// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const SENTINEL_NOT_A_SECRET_ZJYK = "SENTINEL_NOT_A_SECRET_ZJYK";

const { mockUseTravelMode, mockUseVault, mockSignOut, mockToast } = vi.hoisted(() => ({
  mockUseTravelMode: vi.fn(),
  mockUseVault: vi.fn(),
  mockSignOut: vi.fn(),
  mockToast: { error: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("next-auth/react", () => ({
  signOut: mockSignOut,
}));

// formatLockedUntil's module (the vault lock screen) imports the locale router.
vi.mock("@/i18n/navigation", async () => {
  const { mockI18nNavigation } = await import("@/__tests__/helpers/mock-app-navigation");
  return mockI18nNavigation();
});

vi.mock("@/hooks/use-travel-mode", () => ({
  useTravelMode: () => mockUseTravelMode(),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
}));

import { TravelModeCard } from "./travel-mode-card";
import { computePassphraseVerifier } from "@/lib/crypto/crypto-client";

const ACCOUNT_SALT = new Uint8Array(32).fill(7);

describe("TravelModeCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseVault.mockReturnValue({
      getAccountSalt: () => ACCOUNT_SALT,
    });
  });

  it("renders nothing while travel-mode hook is loading", () => {
    mockUseTravelMode.mockReturnValue({
      active: false,
      loading: true,
      enable: vi.fn(),
      disable: vi.fn(),
    });
    const { container } = render(<TravelModeCard />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the enable button when travel mode is inactive", () => {
    mockUseTravelMode.mockReturnValue({
      active: false,
      loading: false,
      enable: vi.fn(),
      disable: vi.fn(),
    });
    render(<TravelModeCard />);
    expect(
      screen.getByRole("button", { name: /^enable$/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("inactive")).toBeInTheDocument();
  });

  it("renders the disable button when travel mode is active", () => {
    mockUseTravelMode.mockReturnValue({
      active: true,
      loading: false,
      enable: vi.fn(),
      disable: vi.fn(),
    });
    render(<TravelModeCard />);
    expect(
      screen.getByRole("button", { name: /^disable$/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("Sec-2: passphrase entered into disable dialog is NOT echoed in error DOM after wrong-passphrase response", async () => {
    const disable = vi
      .fn()
      .mockResolvedValue({ success: false, error: "INVALID_PASSPHRASE" });
    mockUseTravelMode.mockReturnValue({
      active: true,
      loading: false,
      enable: vi.fn(),
      disable,
    });

    render(<TravelModeCard />);
    fireEvent.click(screen.getByRole("button", { name: /^disable$/ }));

    const input = screen.getByLabelText("passphrasePlaceholder");
    fireEvent.change(input, {
      target: { value: SENTINEL_NOT_A_SECRET_ZJYK },
    });

    // Click the dialog's disable submit (the second one)
    const disableBtns = screen.getAllByRole("button", { name: /^disable$/ });
    fireEvent.click(disableBtns[disableBtns.length - 1]);

    await waitFor(() => {
      expect(screen.getByText("passphraseIncorrect")).toBeInTheDocument();
    });
    // The passphrase plaintext must NOT have leaked into rendered DOM
    expect(
      screen.queryByText(new RegExp(SENTINEL_NOT_A_SECRET_ZJYK)),
    ).toBeNull();
  });
});

describe("TravelModeCard flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseVault.mockReturnValue({ getAccountSalt: () => ACCOUNT_SALT });
  });

  function renderActive(disable = vi.fn()) {
    mockUseTravelMode.mockReturnValue({ active: true, loading: false, enable: vi.fn(), disable });
    render(<TravelModeCard />);
    fireEvent.click(screen.getByRole("button", { name: /^disable$/ }));
    return disable;
  }

  function submitDisable() {
    const buttons = screen.getAllByRole("button", { name: /^disable$/ });
    fireEvent.click(buttons[buttons.length - 1]);
  }

  it("enables travel mode after confirmation and closes the confirm dialog", async () => {
    const enable = vi.fn().mockResolvedValue(true);
    mockUseTravelMode.mockReturnValue({ active: false, loading: false, enable, disable: vi.fn() });
    render(<TravelModeCard />);

    fireEvent.click(screen.getByRole("button", { name: /^enable$/ }));
    expect(screen.getByText("enableConfirm")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /^enable$/ });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("enableConfirm")).not.toBeInTheDocument());
  });

  function confirmEnable() {
    fireEvent.click(screen.getByRole("button", { name: /^enable$/ }));
    const buttons = screen.getAllByRole("button", { name: /^enable$/ });
    fireEvent.click(buttons[buttons.length - 1]);
  }

  it("reports a failed enable with the translated error toast", async () => {
    const enable = vi.fn().mockResolvedValue(false);
    mockUseTravelMode.mockReturnValue({ active: false, loading: false, enable, disable: vi.fn() });
    render(<TravelModeCard />);

    confirmEnable();

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("enableFailed"));
  });

  it("shows no error toast when enabling succeeds", async () => {
    const enable = vi.fn().mockResolvedValue(true);
    mockUseTravelMode.mockReturnValue({ active: false, loading: false, enable, disable: vi.fn() });
    render(<TravelModeCard />);

    confirmEnable();

    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("enableConfirm")).not.toBeInTheDocument());
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("requires a non-blank passphrase before disabling", () => {
    const disable = renderActive();
    fireEvent.change(screen.getByLabelText("passphrasePlaceholder"), { target: { value: "   " } });

    submitDisable();

    expect(screen.getByText("passphraseRequired")).toBeInTheDocument();
    expect(disable).not.toHaveBeenCalled();
  });

  it("refuses to disable when the vault has no account salt", async () => {
    mockUseVault.mockReturnValue({ getAccountSalt: () => null });
    const disable = renderActive();
    fireEvent.change(screen.getByLabelText("passphrasePlaceholder"), { target: { value: "pw" } });

    submitDisable();

    expect(await screen.findByText("disableFailed")).toBeInTheDocument();
    expect(disable).not.toHaveBeenCalled();
  });

  it("disables with the passphrase verifier and closes the dialog on success", async () => {
    const disable = renderActive(vi.fn().mockResolvedValue({ success: true }));
    fireEvent.change(screen.getByLabelText("passphrasePlaceholder"), {
      target: { value: "correct horse" },
    });

    submitDisable();

    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
    expect(disable).toHaveBeenCalledWith(
      await computePassphraseVerifier("correct horse", ACCOUNT_SALT),
    );
    await waitFor(() => expect(screen.queryByText("disableTitle")).not.toBeInTheDocument());
  });

  it("submits the passphrase on Enter", async () => {
    const disable = renderActive(vi.fn().mockResolvedValue({ success: true }));
    const input = screen.getByLabelText("passphrasePlaceholder");
    fireEvent.change(input, { target: { value: "pw" } });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
  });

  it("shows disableFailed for a non-passphrase server error", async () => {
    renderActive(vi.fn().mockResolvedValue({ success: false, error: "INTERNAL_ERROR" }));
    fireEvent.change(screen.getByLabelText("passphrasePlaceholder"), { target: { value: "pw" } });

    submitDisable();

    expect(await screen.findByText("disableFailed")).toBeInTheDocument();
    expect(screen.queryByText("passphraseIncorrect")).not.toBeInTheDocument();
  });

  it("shows the lockout with its remaining time on ACCOUNT_LOCKED", async () => {
    const lockedUntil = new Date(Date.now() + 29.5 * 60 * 1000).toISOString();
    renderActive(vi.fn().mockResolvedValue({ success: false, error: "ACCOUNT_LOCKED", lockedUntil }));
    fireEvent.change(screen.getByLabelText("passphrasePlaceholder"), { target: { value: "pw" } });

    submitDisable();

    expect(
      await screen.findByText(
        `accountLockedWithTime:${JSON.stringify({ time: `minutes:${JSON.stringify({ count: "30" })}` })}`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("disableFailed")).not.toBeInTheDocument();
  });

  it("shows the plain lockout message on ACCOUNT_LOCKED without lockedUntil", async () => {
    renderActive(vi.fn().mockResolvedValue({ success: false, error: "ACCOUNT_LOCKED" }));
    fireEvent.change(screen.getByLabelText("passphrasePlaceholder"), { target: { value: "pw" } });

    submitDisable();

    expect(await screen.findByText("accountLocked")).toBeInTheDocument();
  });

  it("sends an expired session (UNAUTHORIZED) to sign in again instead of blaming the passphrase", async () => {
    renderActive(vi.fn().mockResolvedValue({ success: false, error: "UNAUTHORIZED" }));
    fireEvent.change(screen.getByLabelText("passphrasePlaceholder"), {
      target: { value: SENTINEL_NOT_A_SECRET_ZJYK },
    });

    submitDisable();

    expect(await screen.findByText("reauthSessionExpired")).toBeInTheDocument();
    expect(screen.queryByText("passphraseIncorrect")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("disableTitle")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "recentSessionAction" }));
    await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));
  });

  it("shows disableFailed when the disable request throws", async () => {
    renderActive(vi.fn().mockRejectedValue(new Error("network")));
    fireEvent.change(screen.getByLabelText("passphrasePlaceholder"), { target: { value: "pw" } });

    submitDisable();

    expect(await screen.findByText("disableFailed")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^disable$/ }).at(-1)).toBeEnabled();
  });

  it("clears the passphrase and error when the dialog is dismissed", async () => {
    renderActive();
    const input = screen.getByLabelText("passphrasePlaceholder");
    fireEvent.change(input, { target: { value: "  " } });
    submitDisable();
    expect(screen.getByText("passphraseRequired")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("disableTitle")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^disable$/ }));

    expect(screen.getByLabelText("passphrasePlaceholder")).toHaveValue("");
    expect(screen.queryByText("passphraseRequired")).not.toBeInTheDocument();
  });

  it("clears the typed passphrase when the dialog is closed with Cancel", async () => {
    renderActive();
    fireEvent.change(screen.getByLabelText("passphrasePlaceholder"), {
      target: { value: SENTINEL_NOT_A_SECRET_ZJYK },
    });

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(screen.queryByText("disableTitle")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^disable$/ }));

    expect(screen.getByLabelText("passphrasePlaceholder")).toHaveValue("");
  });
});

