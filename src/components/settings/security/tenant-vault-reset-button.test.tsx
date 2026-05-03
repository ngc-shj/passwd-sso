// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetch, mockToast } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

import { TenantVaultResetButton } from "./tenant-vault-reset-button";

describe("TenantVaultResetButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables the trigger when disabled prop is true (R26 disabled cue)", () => {
    render(
      <TenantVaultResetButton userId="u-1" memberName="Alice" disabled />,
    );
    const triggers = screen.getAllByRole("button");
    expect(triggers[0]).toBeDisabled();
  });

  it("opens the confirm dialog when the trigger is clicked", () => {
    render(<TenantVaultResetButton userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.getByText("vaultResetTitle")).toBeInTheDocument();
  });

  it("disables the confirm button until 'RESET' is typed verbatim", () => {
    render(<TenantVaultResetButton userId="u-1" memberName="Alice" />);
    fireEvent.click(screen.getAllByRole("button")[0]);

    const input = screen.getByPlaceholderText("RESET");
    const confirmBtn = screen.getByRole("button", {
      name: "vaultResetConfirm",
    });
    expect(confirmBtn).toBeDisabled();

    fireEvent.change(input, { target: { value: "reset" } });
    expect(confirmBtn).toBeDisabled();

    fireEvent.change(input, { target: { value: "RESET" } });
    expect(confirmBtn).not.toBeDisabled();
  });

  it("posts to the reset-vault endpoint and shows initiated toast on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    const onSuccess = vi.fn();
    render(
      <TenantVaultResetButton
        userId="user-xyz"
        memberName="Alice"
        onSuccess={onSuccess}
      />,
    );

    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.change(screen.getByPlaceholderText("RESET"), {
      target: { value: "RESET" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "vaultResetConfirm" }),
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("user-xyz");
    expect(init.method).toBe("POST");
    expect(mockToast.success).toHaveBeenCalledWith("vaultResetInitiated");
    expect(onSuccess).toHaveBeenCalled();
  });

  it("shows rate-limited toast on 429", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({}),
    });
    render(<TenantVaultResetButton userId="user-1" memberName="Alice" />);

    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.change(screen.getByPlaceholderText("RESET"), {
      target: { value: "RESET" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "vaultResetConfirm" }),
    );

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("vaultResetRateLimited");
    });
  });
});
