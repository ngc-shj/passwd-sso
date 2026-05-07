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
            publicKey: { challenge: "abc" },
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
          publicKey: { challenge: "abc" },
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
            publicKey: { challenge: "abc" },
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
});
