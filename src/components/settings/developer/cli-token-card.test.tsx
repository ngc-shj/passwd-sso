// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetch, mockToast } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

import { CliTokenCard } from "./cli-token-card";

describe("CliTokenCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the generate button initially and no token", () => {
    render(<CliTokenCard />);
    expect(
      screen.getByRole("button", { name: /generate/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("tokenReady")).toBeNull();
  });

  it("shows the token after successful generate", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: "ext-token-abc" }),
    });
    render(<CliTokenCard />);
    fireEvent.click(screen.getByRole("button", { name: /generate/ }));

    await waitFor(() => {
      expect(screen.getByText("tokenReady")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("ext-token-abc")).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith("generated");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("shows rate-limit toast on 429", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({}),
    });
    render(<CliTokenCard />);
    fireEvent.click(screen.getByRole("button", { name: /generate/ }));
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("rateLimited");
    });
  });

  it("shows generic generate-error on other failures", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    render(<CliTokenCard />);
    fireEvent.click(screen.getByRole("button", { name: /generate/ }));
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("generateError");
    });
  });

  it("hides the token panel when OK is clicked", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: "ext-token-abc" }),
    });
    render(<CliTokenCard />);
    fireEvent.click(screen.getByRole("button", { name: /generate/ }));
    await waitFor(() => {
      expect(screen.getByText("tokenReady")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByText("tokenReady")).toBeNull();
  });
});
