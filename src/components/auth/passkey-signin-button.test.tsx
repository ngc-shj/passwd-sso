// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted shared state ─────────────────────────────────────────────────────
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
  // Sentinel: 0xAB repeated. Tests check zeroization by post-hoc inspection.
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

// CRITICAL §Sec-7: mock @/lib/auth/webauthn/webauthn-client (NOT @simplewebauthn/browser)
vi.mock("@/lib/auth/webauthn/webauthn-client", () => ({
  isWebAuthnSupported: () => mockIsWebAuthnSupported(),
  startPasskeyAuthentication: (
    ...args: unknown[]
  ) => mockStartPasskeyAuthentication(...args),
  hexEncode: (b: Uint8Array) => mockHexEncode(b),
}));

import { PasskeySignInButton } from "./passkey-signin-button";

function makePrfSentinel(): Uint8Array {
  const bytes = new Uint8Array(32).fill(0xab);
  prfSentinel.current = bytes;
  return bytes;
}

function okJson(body: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function errResponse(): Response {
  return { ok: false, json: () => Promise.resolve({}) } as unknown as Response;
}

describe("PasskeySignInButton — §Sec-7 WebAuthn / PRF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockIsWebAuthnSupported.mockReturnValue(true);
  });

  it("renders nothing when WebAuthn is not supported", () => {
    mockIsWebAuthnSupported.mockReturnValue(false);
    const { container } = render(<PasskeySignInButton />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the sign-in-with-passkey button when supported (R26: enabled by default)", () => {
    render(<PasskeySignInButton />);
    expect(screen.getByRole("button", { name: /signInWithPasskey/ })).not.toBeDisabled();
  });

  it("(success) writes hex(prfOutput) to sessionStorage, then zeroizes prfOutput", async () => {
    const prfBytes = makePrfSentinel();
    mockStartPasskeyAuthentication.mockResolvedValueOnce({
      responseJSON: { id: "cred-1" },
      prfOutput: prfBytes,
    });
    mockFetch
      .mockResolvedValueOnce(okJson({ options: {}, challengeId: "ch-1", prfSalt: "salt" })) // /options
      .mockResolvedValueOnce(okJson({ ok: true, prf: { wrappedKey: "wk", iv: "iv" } })); // /verify

    render(<PasskeySignInButton />);
    fireEvent.click(screen.getByRole("button", { name: /signInWithPasskey/ }));

    // Hex of 32 bytes of 0xAB
    const expectedHex = "ab".repeat(32);
    await waitFor(() => {
      expect(sessionStorage.getItem("psso:prf-output")).toBe(expectedHex);
      expect(sessionStorage.getItem("psso:webauthn-signin")).toBe("1");
      expect(sessionStorage.getItem("psso:prf-data")).not.toBeNull();
    });

    // Zeroization invariant: source line 85 calls prfOutput.fill(0) after persist.
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
      .mockResolvedValueOnce(errResponse()); // /verify fails

    render(<PasskeySignInButton />);
    fireEvent.click(screen.getByRole("button", { name: /signInWithPasskey/ }));

    await waitFor(() => {
      // Error rendered (i18n key)
      expect(screen.getByText("passkeySignInFailed")).toBeInTheDocument();
    });

    // Zeroization in failure path (source line 73 prfOutput?.fill(0))
    expect(prfBytes.every((b) => b === 0)).toBe(true);

    // No PRF/session keys persisted
    expect(sessionStorage.getItem("psso:prf-output")).toBeNull();
    expect(sessionStorage.getItem("psso:prf-data")).toBeNull();
    expect(sessionStorage.getItem("psso:webauthn-signin")).toBeNull();

    // No nav on failure
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("(NotAllowedError → AUTHENTICATION_CANCELLED) renders cancellation copy and writes NO PRF keys", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ options: {}, challengeId: "ch-1", prfSalt: "salt" }));
    mockStartPasskeyAuthentication.mockRejectedValueOnce(new Error("AUTHENTICATION_CANCELLED"));

    render(<PasskeySignInButton />);
    fireEvent.click(screen.getByRole("button", { name: /signInWithPasskey/ }));

    await waitFor(() => {
      expect(screen.getByText("passkeySignInCancelled")).toBeInTheDocument();
    });
    expect(sessionStorage.getItem("psso:prf-output")).toBeNull();
    expect(sessionStorage.getItem("psso:prf-data")).toBeNull();
    expect(sessionStorage.getItem("psso:webauthn-signin")).toBeNull();
  });

  it("(/options endpoint failure) renders generic error and does not call WebAuthn", async () => {
    mockFetch.mockResolvedValueOnce(errResponse());

    render(<PasskeySignInButton />);
    fireEvent.click(screen.getByRole("button", { name: /signInWithPasskey/ }));

    await waitFor(() => {
      expect(screen.getByText("passkeySignInFailed")).toBeInTheDocument();
    });
    expect(mockStartPasskeyAuthentication).not.toHaveBeenCalled();
  });
});
