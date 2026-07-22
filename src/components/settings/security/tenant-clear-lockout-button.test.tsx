// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetch, mockToast, mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } =
  vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockToast: { success: vi.fn(), error: vi.fn() },
    mockCanUsePasskeyRecovery: vi.fn(),
    mockReauthenticateWithPasskey: vi.fn(),
  }));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

import { setupPasskeyReauthDialogMocks } from "@/__tests__/helpers/passkey-reauth-mocks";
setupPasskeyReauthDialogMocks();

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import { TenantClearLockoutButton } from "./tenant-clear-lockout-button";

describe("TenantClearLockoutButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true });
  });

  it("disables the trigger when disabled prop is true", () => {
    render(
      <TenantClearLockoutButton userId="u-1" memberName="Alice" disabled />,
    );
    const triggers = screen.getAllByRole("button");
    expect(triggers[0]).toBeDisabled();
  });

  it("opens the confirm dialog when the trigger is clicked", () => {
    render(<TenantClearLockoutButton userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.getByText("clearLockoutTitle")).toBeInTheDocument();
  });

  it("posts to the clear-lockout endpoint and shows success toast", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    });
    const onSuccess = vi.fn();
    render(
      <TenantClearLockoutButton
        userId="user-xyz"
        memberName="Alice"
        onSuccess={onSuccess}
      />,
    );

    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(
      screen.getByRole("button", { name: "clearLockoutConfirm" }),
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("user-xyz");
    expect(String(url)).toContain("clear-lockout");
    expect(init.method).toBe("POST");
    expect(mockToast.success).toHaveBeenCalledWith("clearLockoutSuccess");
    expect(onSuccess).toHaveBeenCalled();
  });

  it("shows rate-limited toast on 429", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({}),
    });
    render(<TenantClearLockoutButton userId="user-1" memberName="Alice" />);

    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(
      screen.getByRole("button", { name: "clearLockoutConfirm" }),
    );

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("clearLockoutRateLimited");
    });
  });

  it("shows generic failure toast on a non-step-up, non-rate-limit error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    render(<TenantClearLockoutButton userId="user-1" memberName="Alice" />);

    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(
      screen.getByRole("button", { name: "clearLockoutConfirm" }),
    );

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("clearLockoutFailed");
    });
  });

  // A stale-session clear-lockout POST must surface the reauth recovery path,
  // not the generic clearLockoutFailed toast, and must NOT report success.
  it("opens the recent-session dialog on a SESSION_STEP_UP_REQUIRED response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
    });
    render(<TenantClearLockoutButton userId="user-1" memberName="Alice" />);

    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(
      screen.getByRole("button", { name: "clearLockoutConfirm" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("opens the passkey reauth dialog on step-up when the user has a passkey", async () => {
    mockCanUsePasskeyRecovery.mockResolvedValue(true);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
    });
    render(<TenantClearLockoutButton userId="user-1" memberName="Alice" />);

    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(
      screen.getByRole("button", { name: "clearLockoutConfirm" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("passkey-reauth-dialog")).toBeInTheDocument();
    });
  });
});
