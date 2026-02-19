import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockAuth, mockValidateExtensionToken, mockHasScope } = vi.hoisted(
  () => ({
    mockAuth: vi.fn(),
    mockValidateExtensionToken: vi.fn(),
    mockHasScope: vi.fn(),
  }),
);

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
  hasScope: mockHasScope,
}));

import { authOrToken } from "./auth-or-token";

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/test");
}

describe("authOrToken", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockValidateExtensionToken.mockReset();
    mockHasScope.mockReset();
  });

  it("returns session result when session is valid", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });

    const result = await authOrToken(makeRequest());
    expect(result).toEqual({ type: "session", userId: "user-1" });
    expect(mockValidateExtensionToken).not.toHaveBeenCalled();
  });

  it("falls back to extension token when session is absent", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateExtensionToken.mockResolvedValue({
      ok: true,
      data: { userId: "user-2", scopes: ["passwords:read"] },
    });

    const result = await authOrToken(makeRequest());
    expect(result).toEqual({
      type: "token",
      userId: "user-2",
      scopes: ["passwords:read"],
    });
  });

  it("returns null when both session and token fail", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateExtensionToken.mockResolvedValue({ ok: false });

    const result = await authOrToken(makeRequest());
    expect(result).toBeNull();
  });

  it("returns scope_insufficient when token lacks required scope", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateExtensionToken.mockResolvedValue({
      ok: true,
      data: { userId: "user-3", scopes: ["passwords:read"] },
    });
    mockHasScope.mockReturnValue(false);

    const result = await authOrToken(
      makeRequest(),
      "passwords:write" as Parameters<typeof authOrToken>[1],
    );
    expect(result).toEqual({ type: "scope_insufficient" });
  });

  it("returns token result when required scope is met", async () => {
    mockAuth.mockResolvedValue(null);
    mockValidateExtensionToken.mockResolvedValue({
      ok: true,
      data: { userId: "user-4", scopes: ["passwords:write"] },
    });
    mockHasScope.mockReturnValue(true);

    const result = await authOrToken(
      makeRequest(),
      "passwords:write" as Parameters<typeof authOrToken>[1],
    );
    expect(result).toEqual({
      type: "token",
      userId: "user-4",
      scopes: ["passwords:write"],
    });
  });

  it("session auth always passes regardless of requiredScope", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-5" } });

    const result = await authOrToken(
      makeRequest(),
      "passwords:write" as Parameters<typeof authOrToken>[1],
    );
    expect(result).toEqual({ type: "session", userId: "user-5" });
    expect(mockHasScope).not.toHaveBeenCalled();
  });
});
