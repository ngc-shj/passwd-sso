// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const {
  mockStartPasskeyAuthentication,
  mockIsWebAuthnSupported,
  mockAbortInFlightCeremony,
  mockRouterPush,
  mockFetch,
  mockStashPrf,
  mockUseCallbackUrl,
} = vi.hoisted(() => ({
  mockStartPasskeyAuthentication: vi.fn(),
  mockIsWebAuthnSupported: vi.fn(() => true),
  mockAbortInFlightCeremony: vi.fn(),
  mockRouterPush: vi.fn(),
  mockFetch: vi.fn(),
  mockStashPrf: vi.fn(),
  mockUseCallbackUrl: vi.fn(() => "/dashboard"),
}));

vi.mock("@/lib/auth/prf-handoff", () => ({
  stashPrf: (h: unknown) => mockStashPrf(h),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("@/hooks/use-callback-url", () => ({
  useCallbackUrl: () => mockUseCallbackUrl(),
}));

vi.mock("@/lib/auth/session/callback-url", () => ({
  callbackUrlToHref: (cb: string) => cb,
  isApiCallbackUrl: (cb: string) => cb.startsWith("/api/"),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetch(path, init),
  withBasePath: (p: string) => p,
}));

vi.mock("@/lib/auth/webauthn/webauthn-client", () => ({
  isWebAuthnSupported: () => mockIsWebAuthnSupported(),
  startPasskeyAuthentication: (
    ...args: unknown[]
  ) => mockStartPasskeyAuthentication(...args),
  abortInFlightCeremony: () => mockAbortInFlightCeremony(),
}));

import { SecurityKeySignInForm } from "./security-key-signin-form";

function makePrfSentinel(): Uint8Array {
  // 0xAB repeated. Tests hold this reference to check zeroization post-hoc.
  return new Uint8Array(32).fill(0xab);
}

function okJson(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

function errResponse(): Response {
  return { ok: false, json: () => Promise.resolve({}) } as unknown as Response;
}

describe("SecurityKeySignInForm — §Sec-7 WebAuthn / PRF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockIsWebAuthnSupported.mockReturnValue(true);
    mockUseCallbackUrl.mockReturnValue("/dashboard");
  });

  it("renders nothing when WebAuthn is not supported", () => {
    mockIsWebAuthnSupported.mockReturnValue(false);
    const { container } = render(<SecurityKeySignInForm />);
    expect(container.firstChild).toBeNull();
  });

  it("aborts any in-flight ceremony on unmount (releases a ceremony stranded by navigation)", () => {
    const { unmount } = render(<SecurityKeySignInForm />);
    expect(mockAbortInFlightCeremony).not.toHaveBeenCalled();
    unmount();
    expect(mockAbortInFlightCeremony).toHaveBeenCalledTimes(1);
  });

  it("disables the submit button until an email is entered (R26 disabled cue)", () => {
    render(<SecurityKeySignInForm />);
    const btn = screen.getByRole("button", { name: /signInWithSecurityKey/ });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("emailForSecurityKey"), {
      target: { value: "user@example.com" },
    });
    expect(btn).not.toBeDisabled();
  });

  it("validates empty email and renders error without calling WebAuthn", async () => {
    render(<SecurityKeySignInForm />);
    // Force submit via Enter (button is disabled at empty state — submit via form)
    const input = screen.getByPlaceholderText("emailForSecurityKey");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(screen.getByText("emailInvalid")).toBeInTheDocument());
    expect(mockStartPasskeyAuthentication).not.toHaveBeenCalled();
  });

  it("(success) hands the live PRF buffer to the in-memory channel (NOT sessionStorage) WITHOUT zeroizing it", async () => {
    const prfBytes = makePrfSentinel();
    mockStartPasskeyAuthentication.mockResolvedValueOnce({
      responseJSON: { id: "cred-1" },
      prfOutput: prfBytes,
    });
    mockFetch
      .mockResolvedValueOnce(okJson({ options: {}, challengeId: "ch-1", prfSalt: "salt" }))
      .mockResolvedValueOnce(
        okJson({
          ok: true,
          // Real PRF-wrapped key bundle shape (matches /verify route + PrfHandoff).
          prf: {
            prfEncryptedSecretKey: "ct",
            prfSecretKeyIv: "iv",
            prfSecretKeyAuthTag: "tag",
          },
        }),
      );

    render(<SecurityKeySignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailForSecurityKey"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /signInWithSecurityKey/ }));

    await waitFor(() => {
      // Ownership transfer: the SAME live Uint8Array reference is stashed (no
      // hex copy), so the consumer can zeroize the real buffer after use.
      expect(mockStashPrf).toHaveBeenCalledWith({
        prfOutput: prfBytes,
        prfData: {
          prfEncryptedSecretKey: "ct",
          prfSecretKeyIv: "iv",
          prfSecretKeyAuthTag: "tag",
        },
      });
      // Only the non-sensitive trigger flag is in sessionStorage.
      expect(sessionStorage.getItem("psso:webauthn-signin")).toBe("1");
      expect(sessionStorage.getItem("psso:prf-output")).toBeNull();
      expect(sessionStorage.getItem("psso:prf-data")).toBeNull();
    });
    // Ownership transferred: producer must NOT wipe the stashed buffer.
    expect(prfBytes.some((b) => b !== 0)).toBe(true);
    expect(mockRouterPush).toHaveBeenCalledWith("/dashboard");
  });

  it("(success, API callbackUrl) navigates via window.location.assign, NOT the locale router", async () => {
    mockUseCallbackUrl.mockReturnValue("/api/mobile/authorize?client_kind=ios&state=x");
    // window.location.assign is non-configurable in jsdom, so replace the whole
    // location object for this test and restore it afterwards.
    const origLocation = window.location;
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign: assignSpy, href: "http://localhost/", origin: "http://localhost" },
    });

    mockStartPasskeyAuthentication.mockResolvedValueOnce({
      responseJSON: { id: "cred-1" },
      prfOutput: makePrfSentinel(),
    });
    mockFetch
      .mockResolvedValueOnce(okJson({ options: {}, challengeId: "ch-1", prfSalt: "salt" }))
      .mockResolvedValueOnce(okJson({ ok: true }));

    render(<SecurityKeySignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailForSecurityKey"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /signInWithSecurityKey/ }));

    try {
      await waitFor(() => {
        expect(assignSpy).toHaveBeenCalledWith("/api/mobile/authorize?client_kind=ios&state=x");
      });
      expect(mockRouterPush).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: origLocation });
    }
  });

  it("(no PRF bundle) does NOT hand off and zeroizes the obtained buffer", async () => {
    const prfBytes = makePrfSentinel();
    mockStartPasskeyAuthentication.mockResolvedValueOnce({
      responseJSON: { id: "cred-1" },
      prfOutput: prfBytes,
    });
    mockFetch
      .mockResolvedValueOnce(okJson({ options: {}, challengeId: "ch-1", prfSalt: "salt" }))
      .mockResolvedValueOnce(okJson({ ok: true })); // /verify ok but no prf bundle

    render(<SecurityKeySignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailForSecurityKey"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /signInWithSecurityKey/ }));

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/dashboard");
    });
    expect(mockStashPrf).not.toHaveBeenCalled();
    expect(prfBytes.every((b) => b === 0)).toBe(true);
  });

  it("(fetch throws after ceremony) zeroizes the obtained buffer in finally", async () => {
    const prfBytes = makePrfSentinel();
    mockStartPasskeyAuthentication.mockResolvedValueOnce({
      responseJSON: { id: "cred-1" },
      prfOutput: prfBytes,
    });
    mockFetch
      .mockResolvedValueOnce(okJson({ options: {}, challengeId: "ch-1", prfSalt: "salt" }))
      .mockRejectedValueOnce(new Error("network")); // /verify rejects

    render(<SecurityKeySignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailForSecurityKey"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /signInWithSecurityKey/ }));

    await waitFor(() => {
      expect(screen.getByText("securityKeySignInFailed")).toBeInTheDocument();
    });
    expect(prfBytes.every((b) => b === 0)).toBe(true);
    expect(mockStashPrf).not.toHaveBeenCalled();
  });

  it("(verify-failure) zeroizes prfOutput AND hands off NO PRF / writes no webauthn-signin key", async () => {
    const prfBytes = makePrfSentinel();
    mockStartPasskeyAuthentication.mockResolvedValueOnce({
      responseJSON: { id: "cred-1" },
      prfOutput: prfBytes,
    });
    mockFetch
      .mockResolvedValueOnce(okJson({ options: {}, challengeId: "ch-1", prfSalt: "salt" }))
      .mockResolvedValueOnce(errResponse());

    render(<SecurityKeySignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailForSecurityKey"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /signInWithSecurityKey/ }));

    await waitFor(() => {
      expect(screen.getByText("securityKeySignInFailed")).toBeInTheDocument();
    });
    expect(prfBytes.every((b) => b === 0)).toBe(true);
    expect(mockStashPrf).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("psso:webauthn-signin")).toBeNull();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("(AUTHENTICATION_CANCELLED) renders cancellation copy and hands off NO PRF", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ options: {}, challengeId: "ch-1", prfSalt: "salt" }));
    mockStartPasskeyAuthentication.mockRejectedValueOnce(new Error("AUTHENTICATION_CANCELLED"));

    render(<SecurityKeySignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailForSecurityKey"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /signInWithSecurityKey/ }));

    await waitFor(() => {
      expect(screen.getByText("securityKeySignInCancelled")).toBeInTheDocument();
    });
    expect(mockStashPrf).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("psso:webauthn-signin")).toBeNull();
  });
});
