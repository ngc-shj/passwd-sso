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

vi.mock("@/lib/http/api-error-codes", () => ({
  apiErrorToI18nKey: (code: string) => code,
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

  it("§Sec-2: 401-style failure renders wrongPassword key only (sentinel never echoed)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: "INVALID_PASSWORD" }),
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
        json: () => Promise.resolve({ error: "INVALID_PASSWORD" }),
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
});
