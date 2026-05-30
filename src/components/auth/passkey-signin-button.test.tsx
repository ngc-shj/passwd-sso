// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Hoisted shared state ─────────────────────────────────────────────────────
const {
  mockStartPasskeyAuthentication,
  mockIsWebAuthnSupported,
  mockRouterPush,
  mockFetch,
  mockStashPrf,
} = vi.hoisted(() => ({
  mockStartPasskeyAuthentication: vi.fn(),
  mockIsWebAuthnSupported: vi.fn(() => true),
  mockRouterPush: vi.fn(),
  mockFetch: vi.fn(),
  mockStashPrf: vi.fn(),
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
}));

import { PasskeySignInButton } from "./passkey-signin-button";

function makePrfSentinel(): Uint8Array {
  // 0xAB repeated. Tests hold this reference to check zeroization post-hoc.
  return new Uint8Array(32).fill(0xab);
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

  it("(success) hands the live PRF buffer to the in-memory channel (NOT sessionStorage) WITHOUT zeroizing it", async () => {
    const prfBytes = makePrfSentinel();
    mockStartPasskeyAuthentication.mockResolvedValueOnce({
      responseJSON: { id: "cred-1" },
      prfOutput: prfBytes,
    });
    mockFetch
      .mockResolvedValueOnce(okJson({ options: {}, challengeId: "ch-1", prfSalt: "salt" })) // /options
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
      ); // /verify

    render(<PasskeySignInButton />);
    fireEvent.click(screen.getByRole("button", { name: /signInWithPasskey/ }));

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

    // Ownership transferred: the producer must NOT wipe the stashed buffer
    // (doing so would corrupt the consumer's unwrap). Buffer stays intact.
    expect(prfBytes.some((b) => b !== 0)).toBe(true);

    expect(mockRouterPush).toHaveBeenCalledWith("/dashboard");
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

    render(<PasskeySignInButton />);
    fireEvent.click(screen.getByRole("button", { name: /signInWithPasskey/ }));

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/dashboard");
    });

    // Vault not PRF-enrolled: no hand-off, buffer zeroized by the finally.
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

    render(<PasskeySignInButton />);
    fireEvent.click(screen.getByRole("button", { name: /signInWithPasskey/ }));

    await waitFor(() => {
      expect(screen.getByText("passkeySignInFailed")).toBeInTheDocument();
    });

    // The buffer obtained before the throw is still zeroized by the finally.
    expect(prfBytes.every((b) => b === 0)).toBe(true);
    expect(mockStashPrf).not.toHaveBeenCalled();
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

    // Zeroization in failure path (finally: prfOutput?.fill(0))
    expect(prfBytes.every((b) => b === 0)).toBe(true);

    // No PRF handed off and no session keys persisted
    expect(mockStashPrf).not.toHaveBeenCalled();
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
    expect(mockStashPrf).not.toHaveBeenCalled();
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
