import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFetchApi, mockStartPasskeyAuthentication } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockStartPasskeyAuthentication: vi.fn(),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: mockFetchApi,
}));

vi.mock("@/lib/auth/webauthn/webauthn-client", () => ({
  startPasskeyAuthentication: mockStartPasskeyAuthentication,
}));

import { reauthenticateWithPasskey } from "./passkey-reauth-client";

describe("reauthenticateWithPasskey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns verifiedAt after a successful reauth ceremony", async () => {
    mockFetchApi
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            challengeId: "a".repeat(32),
            options: { challenge: "abc" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, verifiedAt: "2026-05-07T00:00:00Z" }),
          { status: 200 },
        ),
      );
    mockStartPasskeyAuthentication.mockResolvedValue({
      responseJSON: { id: "cred-1" },
    });

    const result = await reauthenticateWithPasskey();

    expect(result).toEqual({ ok: true, verifiedAt: "2026-05-07T00:00:00Z" });
  });

  it("returns AUTHENTICATION_CANCELLED when the user cancels the ceremony", async () => {
    mockFetchApi.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            challengeId: "a".repeat(32),
            options: { challenge: "abc" },
          }),
        { status: 200 },
      ),
    );
    mockStartPasskeyAuthentication.mockRejectedValue(
      new Error("AUTHENTICATION_CANCELLED"),
    );

    const result = await reauthenticateWithPasskey();

    expect(result).toEqual({ ok: false, error: "AUTHENTICATION_CANCELLED" });
  });

  it("returns the server error code when verify fails", async () => {
    mockFetchApi
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            challengeId: "a".repeat(32),
            options: { challenge: "abc" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "SESSION_STEP_UP_REQUIRED" }),
          { status: 403 },
        ),
      );
    mockStartPasskeyAuthentication.mockResolvedValue({
      responseJSON: { id: "cred-1" },
    });

    const result = await reauthenticateWithPasskey();

    expect(result).toEqual({ ok: false, error: "SESSION_STEP_UP_REQUIRED" });
  });

  // C11: verify committed the session's passkeyVerifiedAt refresh once it
  // answered 2xx, so an unreadable body is still a successful reauth.
  const unreadable = () =>
    new Response("<html>bad gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } });
  const optionsOk = () =>
    new Response(JSON.stringify({ challengeId: "a".repeat(32), options: { challenge: "abc" } }), { status: 200 });

  it("succeeds with a null verifiedAt when the committed verify body is unreadable", async () => {
    mockFetchApi.mockResolvedValueOnce(optionsOk()).mockResolvedValueOnce(unreadable());
    mockStartPasskeyAuthentication.mockResolvedValue({ responseJSON: { id: "cred-1" } });

    const result = await reauthenticateWithPasskey();

    expect(result).toEqual({ ok: true, verifiedAt: null });
  });

  it("fails without running the ceremony when the options body is unreadable", async () => {
    mockFetchApi.mockResolvedValueOnce(unreadable());

    const result = await reauthenticateWithPasskey();

    expect(result).toEqual({ ok: false, error: "PASSKEY_REAUTH_FAILED" });
    expect(mockStartPasskeyAuthentication).not.toHaveBeenCalled();
    expect(mockFetchApi).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["non-record options", { challengeId: "a".repeat(32), options: "abc" }],
    ["array options", { challengeId: "a".repeat(32), options: [] }],
    ["a non-string challenge id", { challengeId: 123, options: { challenge: "abc" } }],
  ])("fails without running the ceremony when the options body has %s", async (_label, body) => {
    mockFetchApi.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

    const result = await reauthenticateWithPasskey();

    expect(result).toEqual({ ok: false, error: "PASSKEY_REAUTH_FAILED" });
    expect(mockStartPasskeyAuthentication).not.toHaveBeenCalled();
    expect(mockFetchApi).toHaveBeenCalledTimes(1);
  });

  it("falls back to PASSKEY_REAUTH_FAILED when the verify error body is unreadable", async () => {
    mockFetchApi
      .mockResolvedValueOnce(optionsOk())
      .mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    mockStartPasskeyAuthentication.mockResolvedValue({ responseJSON: { id: "cred-1" } });

    const result = await reauthenticateWithPasskey();

    expect(result).toEqual({ ok: false, error: "PASSKEY_REAUTH_FAILED" });
  });
});
