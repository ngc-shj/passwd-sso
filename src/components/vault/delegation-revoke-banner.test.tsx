// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { mockI18nNavigation } from "@/__tests__/helpers/mock-app-navigation";

const { mockUseVault, mockFetchApi, routerPush } = vi.hoisted(() => ({
  mockUseVault: vi.fn(),
  mockFetchApi: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetchApi(path, init),
}));

vi.mock("@/i18n/navigation", () =>
  mockI18nNavigation({ router: { push: routerPush } }),
);

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: React.ComponentProps<"button">) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

import { DelegationRevokeBanner } from "./delegation-revoke-banner";
import { VAULT_STATUS } from "@/lib/constants";

describe("DelegationRevokeBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when vault is locked (does not fetch)", () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.LOCKED });
    render(<DelegationRevokeBanner />);

    expect(screen.queryByText(/bannerActive/)).toBeNull();
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("renders nothing when vault unlocked but no sessions returned", async () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED });
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [] }),
    });

    render(<DelegationRevokeBanner />);

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalled();
    });
    expect(screen.queryByText(/bannerActive/)).toBeNull();
  });

  it("renders banner with count when sessions exist", async () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED });
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [{ id: "s1" }, { id: "s2" }] }),
    });

    render(<DelegationRevokeBanner />);

    await waitFor(() => {
      expect(screen.getByText(/bannerActive/)).toBeInTheDocument();
    });
    expect(screen.getByText(/"count":2/)).toBeInTheDocument();
  });

  it("navigates to delegation page when manage button clicked", async () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED });
    mockFetchApi.mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [{ id: "s1" }] }),
    });

    render(<DelegationRevokeBanner />);

    await waitFor(() => {
      expect(screen.getByText("bannerManage")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("bannerManage"));
    expect(routerPush).toHaveBeenCalledWith("/dashboard/settings/vault/delegation");
  });

  it("does not crash on fetch failure (returns null when count stays 0)", async () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED });
    mockFetchApi.mockResolvedValue({ ok: false });

    render(<DelegationRevokeBanner />);

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalled();
    });
    expect(screen.queryByText(/bannerActive/)).toBeNull();
  });

  it("handles thrown error from fetchApi without rendering banner", async () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED });
    mockFetchApi.mockRejectedValue(new Error("network"));

    render(<DelegationRevokeBanner />);

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalled();
    });
    expect(screen.queryByText(/bannerActive/)).toBeNull();
  });
});
