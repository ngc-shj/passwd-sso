// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SHARE_PASSWORD_MAX_ATTEMPTS } from "@/lib/validations/common";

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetch(path, init),
  withBasePath: (p: string) => p,
}));

import { SharePasswordGate } from "./share-password-gate";

const SENTINEL_NOT_A_SECRET_ZJYK = "ZJYKZJYKZJYK_pwgate_secret";

function pasteEvent(value: string) {
  return {
    clipboardData: { getData: () => value },
    preventDefault: () => {},
  } as unknown as React.ClipboardEvent<HTMLInputElement>;
}

describe("SharePasswordGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("renders the password input and unlock button (R26: button disabled until password)", () => {
    render(<SharePasswordGate token="t1" onVerified={vi.fn()} />);
    expect(screen.getByPlaceholderText("pasteOnly")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /unlock/ })).toBeDisabled();
  });

  it("uses the externally-supplied error verbatim", () => {
    render(
      <SharePasswordGate token="t1" onVerified={vi.fn()} error="external-issue" />,
    );
    expect(screen.getByText("external-issue")).toBeInTheDocument();
  });

  it("paste populates password field; submit calls fetchApi and onVerified on success", async () => {
    const onVerified = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ accessToken: "at-1" }),
    } as unknown as Response);

    render(<SharePasswordGate token="t1" onVerified={onVerified} />);
    const input = screen.getByPlaceholderText("pasteOnly") as HTMLInputElement;
    fireEvent.paste(input, pasteEvent("correct-password"));

    fireEvent.click(screen.getByRole("button", { name: /unlock/ }));
    await waitFor(() => expect(onVerified).toHaveBeenCalledWith("at-1"));
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/share-links/verify-access",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("§Sec-2: a refused password renders wrongPassword key only (sentinel never echoed)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "SHARE_PASSWORD_INCORRECT" }),
    } as unknown as Response);

    render(<SharePasswordGate token="t1" onVerified={vi.fn()} />);
    fireEvent.paste(
      screen.getByPlaceholderText("pasteOnly"),
      pasteEvent(SENTINEL_NOT_A_SECRET_ZJYK),
    );
    fireEvent.click(screen.getByRole("button", { name: /unlock/ }));
    await waitFor(() => expect(screen.getByText("wrongPassword")).toBeInTheDocument());
    expect(screen.queryByText(new RegExp(SENTINEL_NOT_A_SECRET_ZJYK))).toBeNull();
  });

  it("§Sec-2: 429 (RATE_LIMIT_EXCEEDED) renders tooManyAttempts and never echoes sentinel", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: "RATE_LIMIT_EXCEEDED" }),
    } as unknown as Response);

    render(<SharePasswordGate token="t1" onVerified={vi.fn()} />);
    fireEvent.paste(
      screen.getByPlaceholderText("pasteOnly"),
      pasteEvent(SENTINEL_NOT_A_SECRET_ZJYK),
    );
    fireEvent.click(screen.getByRole("button", { name: /unlock/ }));
    await waitFor(() => expect(screen.getByText("tooManyAttempts")).toBeInTheDocument());
    expect(screen.queryByText(new RegExp(SENTINEL_NOT_A_SECRET_ZJYK))).toBeNull();
  });

  it(`disables unlock after SHARE_PASSWORD_MAX_ATTEMPTS=${SHARE_PASSWORD_MAX_ATTEMPTS} failed attempts (RT3 + R26 cue)`, async () => {
    // Simulate MAX_ATTEMPTS sequential failures
    for (let i = 0; i < SHARE_PASSWORD_MAX_ATTEMPTS; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "SHARE_PASSWORD_INCORRECT" }),
      } as unknown as Response);
    }

    render(<SharePasswordGate token="t1" onVerified={vi.fn()} />);
    const input = screen.getByPlaceholderText("pasteOnly") as HTMLInputElement;
    const btn = screen.getByRole("button", { name: /unlock/ });

    for (let i = 0; i < SHARE_PASSWORD_MAX_ATTEMPTS; i++) {
      fireEvent.paste(input, pasteEvent(`attempt-${i}`));
      fireEvent.click(btn);
      // Wait for the response to settle before next click
      await waitFor(() => expect(screen.getByText("wrongPassword")).toBeInTheDocument());
    }
    expect(btn).toBeDisabled();
  });
  async function submitUntilSettled(times: number, expectedText: string) {
    render(<SharePasswordGate token="t1" onVerified={vi.fn()} />);
    const input = screen.getByPlaceholderText("pasteOnly");
    const btn = screen.getByRole("button", { name: /unlock/ });
    for (let i = 0; i < times; i++) {
      fireEvent.paste(input, pasteEvent(`attempt-${i}`));
      fireEvent.click(btn);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(i + 1));
      await waitFor(() => expect(screen.getByText(expectedText)).toBeInTheDocument());
      await waitFor(() => expect(btn).toBeEnabled());
    }
    return btn;
  }

  it("tells the visitor a 404 link is no longer available, not that the password is wrong", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "NOT_FOUND" }),
    } as unknown as Response);

    await submitUntilSettled(1, "linkUnavailable");

    expect(screen.queryByText("wrongPassword")).not.toBeInTheDocument();
  });

  it.each([503, 500])("asks the visitor to retry later on a %i, not that the password is wrong", async (status) => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status,
      json: () => Promise.resolve({ error: status === 503 ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR" }),
    } as unknown as Response);

    await submitUntilSettled(1, "verifyRetryLater");

    expect(screen.queryByText("wrongPassword")).not.toBeInTheDocument();
  });

  it("asks the visitor to retry later when the request itself fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("offline"));

    await submitUntilSettled(1, "verifyRetryLater");
  });

  it.each([
    [404, "NOT_FOUND", "linkUnavailable"],
    [503, "SERVICE_UNAVAILABLE", "verifyRetryLater"],
  ])("does not count a %i toward the attempt cap", async (status, error, expectedText) => {
    for (let i = 0; i < SHARE_PASSWORD_MAX_ATTEMPTS; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
        json: () => Promise.resolve({ error }),
      } as unknown as Response);
    }

    const btn = await submitUntilSettled(SHARE_PASSWORD_MAX_ATTEMPTS, expectedText);

    expect(btn).toBeEnabled();
    expect(screen.queryByText("tooManyAttempts")).not.toBeInTheDocument();
  });
});
