/**
 * Tests for ssh-sign-authorizer.ts
 *
 * Verifies fail-closed behavior and the one-time re-login hint for scope denials.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/api-client.js", () => ({
  apiRequest: vi.fn(),
}));

vi.mock("../../lib/output.js", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}));

const { apiRequest } = await import("../../lib/api-client.js");
const output = await import("../../lib/output.js");
const { authorizeSign, _resetScopeHintForTest } = await import(
  "../../lib/ssh-sign-authorizer.js"
);

const BASE_ARGS = {
  keyId: "cuid123abc",
  fingerprint: "SHA256:AAAA",
  binding: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetScopeHintForTest();
});

describe("authorizeSign — happy path", () => {
  it("returns true when server responds 200 with authorized:true", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: { authorized: true },
    });

    const result = await authorizeSign(BASE_ARGS);
    expect(result).toBe(true);
  });

  it("passes binding host fields in the request body when binding is present", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: { authorized: true },
    });

    const binding = { hostKeyFingerprint: "SHA256:HOST", forwarded: false };
    await authorizeSign({ ...BASE_ARGS, binding });

    expect(vi.mocked(apiRequest)).toHaveBeenCalledWith(
      "/api/vault/ssh/sign-authorize",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          host: { hostKeyFingerprint: "SHA256:HOST", forwarded: false },
        }),
      }),
    );
  });

  it("omits host field when binding is null", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: { authorized: true },
    });

    await authorizeSign(BASE_ARGS);

    const callArgs = vi.mocked(apiRequest).mock.calls[0];
    const body = (callArgs[1] as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty("host");
  });
});

describe("authorizeSign — deny paths", () => {
  it("returns false when server responds 200 with authorized:false", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: false,
      status: 200,
      data: { authorized: false, reason: "entry_not_found" },
    });

    const result = await authorizeSign(BASE_ARGS);
    expect(result).toBe(false);
  });

  it("returns false on 403 with reason entry_not_found — no hint emitted", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: false,
      status: 403,
      data: { authorized: false, reason: "entry_not_found" },
    });

    const result = await authorizeSign(BASE_ARGS);
    expect(result).toBe(false);
    expect(vi.mocked(output.warn)).not.toHaveBeenCalledWith(
      expect.stringContaining("passwd-sso login"),
    );
  });

  it("returns false on 403 reason unauthorized — emits re-login hint", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: false,
      status: 403,
      data: { authorized: false, reason: "unauthorized" },
    });

    const result = await authorizeSign(BASE_ARGS);
    expect(result).toBe(false);
    expect(vi.mocked(output.warn)).toHaveBeenCalledWith(
      expect.stringContaining("passwd-sso login"),
    );
  });

  it("emits the re-login hint exactly once per process run across multiple calls", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: false,
      status: 403,
      data: { authorized: false, reason: "unauthorized" },
    });

    await authorizeSign(BASE_ARGS);
    await authorizeSign(BASE_ARGS);
    await authorizeSign(BASE_ARGS);

    const hintCalls = vi.mocked(output.warn).mock.calls.filter((args) =>
      args[0].includes("passwd-sso login"),
    );
    expect(hintCalls).toHaveLength(1);
  });

  it("returns false on 401 with reason unauthorized — emits hint", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: false,
      status: 401,
      data: { authorized: false, reason: "unauthorized" },
    });

    const result = await authorizeSign(BASE_ARGS);
    expect(result).toBe(false);
    expect(vi.mocked(output.warn)).toHaveBeenCalledWith(
      expect.stringContaining("passwd-sso login"),
    );
  });

  it("returns false on 503 (service unavailable)", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: false,
      status: 503,
      data: { authorized: false, reason: "service_unavailable" },
    });

    const result = await authorizeSign(BASE_ARGS);
    expect(result).toBe(false);
  });

  it("returns false on network throw (fail-closed)", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await authorizeSign(BASE_ARGS);
    expect(result).toBe(false);
  });

  it("returns false on malformed response body (no authorized field)", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 200,
      data: { unexpected: "shape" } as unknown as { authorized: boolean },
    });

    const result = await authorizeSign(BASE_ARGS);
    // authorized field is not === true, so must return false
    expect(result).toBe(false);
  });
});
