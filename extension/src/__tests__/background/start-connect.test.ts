/**
 * C6: SW startConnect() helper — five acceptance cases from the plan.
 *
 *   1. Happy path → setToken called with (token, expiresAt, cnfJkt).
 *   2. Bridge-code 401 → no setToken; errorCode propagated.
 *   3. Exchange 401 → no setToken; errorCode propagated.
 *   4. Network error mid-flow → no setToken; errorCode = GENERIC_FAILURE.
 *   5. DPoP signer throws → no setToken; errorCode = GENERIC_FAILURE.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/storage", () => ({
  getSettings: vi.fn().mockResolvedValue({ serverUrl: "https://example.com" }),
}));

import { startConnect } from "../../background/token-handler";
import { DpopSignError } from "../../background/dpop-fetch";

const SERVER = "https://example.com";
const BRIDGE_CODE = "a".repeat(64);
const TOKEN = "ext-token-abc";
const CNF_JKT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("startConnect (C6)", () => {
  let setToken: ReturnType<typeof vi.fn>;
  let signDpopProof: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setToken = vi.fn();
    signDpopProof = vi.fn().mockResolvedValue("dpop.proof.jws");
  });

  it("happy path: bridge-code + exchange both 2xx → setToken called once", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: BRIDGE_CODE, expiresAt: new Date(Date.now() + 60000).toISOString() }, 201),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            token: TOKEN,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            scope: ["passwords:read"],
            cnfJkt: CNF_JKT,
          },
          201,
        ),
      );

    const result = await startConnect({ setToken, fetchImpl, signDpopProofImpl: signDpopProof });

    expect(result).toEqual({ ok: true });
    expect(setToken).toHaveBeenCalledTimes(1);
    expect(setToken.mock.calls[0][0]).toBe(TOKEN);
    expect(setToken.mock.calls[0][2]).toBe(CNF_JKT);

    // Bridge-code request: credentialed + empty body + DPoP header.
    const [bridgeUrl, bridgeInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(bridgeUrl).toBe(`${SERVER}/api/extension/bridge-code`);
    expect(bridgeInit.method).toBe("POST");
    expect(bridgeInit.credentials).toBe("include");
    expect(bridgeInit.body).toBe("{}");
    expect((bridgeInit.headers as Record<string, string>).DPoP).toBe("dpop.proof.jws");

    // Exchange request: NO credentials, body carries the code.
    const [exchangeUrl, exchangeInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(exchangeUrl).toBe(`${SERVER}/api/extension/token/exchange`);
    expect(exchangeInit.credentials).toBe("omit");
    expect(JSON.parse(exchangeInit.body as string)).toEqual({ code: BRIDGE_CODE });
  });

  it("bridge-code 401 → no setToken; errorCode propagated (GENERIC_FAILURE for non-step-up codes)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "UNAUTHORIZED" }, 401));

    const result = await startConnect({ setToken, fetchImpl, signDpopProofImpl: signDpopProof });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("GENERIC_FAILURE");
    expect(setToken).not.toHaveBeenCalled();
    // Exchange call MUST NOT happen when bridge-code failed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bridge-code 403 SESSION_STEP_UP_REQUIRED → errorCode propagated verbatim", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "SESSION_STEP_UP_REQUIRED" }, 403));

    const result = await startConnect({ setToken, fetchImpl, signDpopProofImpl: signDpopProof });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("SESSION_STEP_UP_REQUIRED");
    expect(setToken).not.toHaveBeenCalled();
  });

  it("exchange 401 → no setToken; errorCode propagated", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: BRIDGE_CODE, expiresAt: new Date(Date.now() + 60000).toISOString() }, 201),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "UNAUTHORIZED" }, 401));

    const result = await startConnect({ setToken, fetchImpl, signDpopProofImpl: signDpopProof });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("GENERIC_FAILURE");
    expect(setToken).not.toHaveBeenCalled();
  });

  it("network error mid-flow → no setToken; errorCode = GENERIC_FAILURE", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("network down"));

    const result = await startConnect({ setToken, fetchImpl, signDpopProofImpl: signDpopProof });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("GENERIC_FAILURE");
    expect(setToken).not.toHaveBeenCalled();
  });

  // Regression: a basePath-bearing serverUrl (e.g. behind a Tailscale Serve
  // or reverse-proxy prefix) MUST be preserved on both fetches. An earlier
  // implementation used `new URL(path, serverUrl)` which discards the
  // basePath because absolute paths override the base's pathname, sending
  // requests to the host root and producing silent network errors.
  it("preserves basePath in serverUrl on both bridge-code and exchange fetches", async () => {
    const basePathServer = "https://example.com/passwd-sso";
    vi.doMock("../../lib/storage", () => ({
      getSettings: vi.fn().mockResolvedValue({ serverUrl: basePathServer }),
    }));
    vi.resetModules();
    const { startConnect: startConnectIso } = await import("../../background/token-handler");

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: BRIDGE_CODE, expiresAt: new Date(Date.now() + 60000).toISOString() }, 201),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            token: TOKEN,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            scope: ["passwords:read"],
            cnfJkt: CNF_JKT,
          },
          201,
        ),
      );

    await startConnectIso({ setToken, fetchImpl, signDpopProofImpl: signDpopProof });

    const [bridgeUrl] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(bridgeUrl).toBe(`${basePathServer}/api/extension/bridge-code`);
    const [exchangeUrl] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(exchangeUrl).toBe(`${basePathServer}/api/extension/token/exchange`);

    vi.doUnmock("../../lib/storage");
    vi.resetModules();
  });

  it("DPoP signer throws (e.g., IDB unavailable) → no setToken; errorCode = GENERIC_FAILURE", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    signDpopProof.mockRejectedValueOnce(new DpopSignError("IDB unavailable"));

    const result = await startConnect({ setToken, fetchImpl, signDpopProofImpl: signDpopProof });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("GENERIC_FAILURE");
    expect(setToken).not.toHaveBeenCalled();
    // No fetch should have been issued — the signer failure happens first.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
