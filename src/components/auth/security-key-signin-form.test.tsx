// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const {
  mockStartPasskeyAuthentication,
  mockIsWebAuthnSupported,
  mockHexEncode,
  mockRouterPush,
  mockFetch,
  prfSentinel,
} = vi.hoisted(() => ({
  mockStartPasskeyAuthentication: vi.fn(),
  mockIsWebAuthnSupported: vi.fn(() => true),
  mockHexEncode: vi.fn((b: Uint8Array) =>
    Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""),
  ),
  mockRouterPush: vi.fn(),
  mockFetch: vi.fn(),
  prfSentinel: { current: null as Uint8Array | null },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("@/hooks/use-callback-url", () => ({
  useCallbackUrl: () => "/dashboard",
}));

vi.mock("@/lib/auth/session/callback-url", () => ({
  callbackUrlToHref: (cb: string) => cb,
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
  hexEncode: (b: Uint8Array) => mockHexEncode(b),
}));

import { SecurityKeySignInForm } from "./security-key-signin-form";

function makePrfSentinel(): Uint8Array {
  const bytes = new Uint8Array(32).fill(0xab);
  prfSentinel.current = bytes;
  return bytes;
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
  });

  it("renders nothing when WebAuthn is not supported", () => {
    mockIsWebAuthnSupported.mockReturnValue(false);
    const { container } = render(<SecurityKeySignInForm />);
    expect(container.firstChild).toBeNull();
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

  it("(success) persists PRF hex to sessionStorage and zeroizes prfOutput", async () => {
    const prfBytes = makePrfSentinel();
    mockStartPasskeyAuthentication.mockResolvedValueOnce({
      responseJSON: { id: "cred-1" },
      prfOutput: prfBytes,
    });
    mockFetch
      .mockResolvedValueOnce(okJson({ options: {}, challengeId: "ch-1", prfSalt: "salt" }))
      .mockResolvedValueOnce(okJson({ ok: true, prf: { wrappedKey: "wk" } }));

    render(<SecurityKeySignInForm />);
    fireEvent.change(screen.getByPlaceholderText("emailForSecurityKey"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /signInWithSecurityKey/ }));

    const expectedHex = "ab".repeat(32);
    await waitFor(() => {
      expect(sessionStorage.getItem("psso:prf-output")).toBe(expectedHex);
      expect(sessionStorage.getItem("psso:webauthn-signin")).toBe("1");
    });
    expect(prfBytes.every((b) => b === 0)).toBe(true);
    expect(mockRouterPush).toHaveBeenCalledWith("/dashboard");
  });

  it("(verify-failure) zeroizes prfOutput AND writes NO PRF/webauthn-signin keys to sessionStorage", async () => {
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
    expect(sessionStorage.getItem("psso:prf-output")).toBeNull();
    expect(sessionStorage.getItem("psso:prf-data")).toBeNull();
    expect(sessionStorage.getItem("psso:webauthn-signin")).toBeNull();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("(AUTHENTICATION_CANCELLED) renders cancellation copy and writes NO PRF keys", async () => {
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
    expect(sessionStorage.getItem("psso:prf-output")).toBeNull();
    expect(sessionStorage.getItem("psso:prf-data")).toBeNull();
    expect(sessionStorage.getItem("psso:webauthn-signin")).toBeNull();
  });
});
