/**
 * Tests for C8 contract: DPoP header attached on all fetch sites via
 * swFetchAuthenticated, and token-handler helpers use swFetchAuthenticated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock dpop-key before importing consumers ──────────────────────────────
const dpopKeyMocks = vi.hoisted(() => ({
  signDpopProof: vi.fn().mockResolvedValue("fake.dpop.jws"),
  resetInMemoryKeyCache: vi.fn(),
}));

vi.mock("../../lib/dpop-key", () => dpopKeyMocks);

// ── Mock storage so token-handler does not call real chrome APIs ──────────
vi.mock("../../lib/storage", () => ({
  getSettings: vi.fn().mockResolvedValue({ serverUrl: "https://example.com" }),
}));

import { swFetchAuthenticated, DpopSignError } from "../../background/dpop-fetch";
import { attemptTokenRefreshWith, revokeTokenOnServerWith } from "../../background/token-handler";

const SERVER_URL = "https://example.com";
const TOKEN = "bearer-token-abc";

describe("swFetchAuthenticated (C8)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);
    dpopKeyMocks.signDpopProof.mockReset();
    dpopKeyMocks.signDpopProof.mockResolvedValue("fake.dpop.jws");
    dpopKeyMocks.resetInMemoryKeyCache.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches DPoP header on every authenticated fetch", async () => {
    await swFetchAuthenticated("/api/passwords", { method: "GET" }, SERVER_URL, TOKEN);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/api/passwords");
    const headers = init.headers as Headers;
    expect(headers.get("DPoP")).toBe("fake.dpop.jws");
    expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("retries once on transient sign failure then succeeds", async () => {
    dpopKeyMocks.signDpopProof
      .mockRejectedValueOnce(new Error("WebCrypto glitch"))
      .mockResolvedValueOnce("retry.dpop.jws");

    await swFetchAuthenticated("/api/passwords", { method: "GET" }, SERVER_URL, TOKEN);

    expect(dpopKeyMocks.resetInMemoryKeyCache).toHaveBeenCalledOnce();
    expect(dpopKeyMocks.signDpopProof).toHaveBeenCalledTimes(2);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("DPoP")).toBe("retry.dpop.jws");
  });

  it("throws DpopSignError on two consecutive sign failures", async () => {
    dpopKeyMocks.signDpopProof
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"));

    await expect(
      swFetchAuthenticated("/api/passwords", { method: "GET" }, SERVER_URL, TOKEN),
    ).rejects.toBeInstanceOf(DpopSignError);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("attemptTokenRefreshWith (C8 — DPoP header on refresh)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dpopKeyMocks.signDpopProof.mockReset();
    dpopKeyMocks.signDpopProof.mockResolvedValue("fake.dpop.jws");
    dpopKeyMocks.resetInMemoryKeyCache.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls fetch with DPoP header on token refresh", async () => {
    const newExpiresAt = new Date(Date.now() + 900_000).toISOString();
    mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "new-token", expiresAt: newExpiresAt, scope: [] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const setToken = vi.fn();
    await attemptTokenRefreshWith({
      getCurrentToken: () => TOKEN,
      getTokenExpiresAt: () => Date.now() + 600_000,
      setToken,
      clearToken: vi.fn(),
      scheduleRefreshAlarm: vi.fn(),
      createTtlAlarm: vi.fn(),
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("DPoP")).toBe("fake.dpop.jws");
    expect(setToken).toHaveBeenCalledWith("new-token", expect.any(Number));
  });

  it("does NOT call clearToken when DpopSignError is thrown (F6 / Round 2)", async () => {
    dpopKeyMocks.signDpopProof
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"));

    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const clearToken = vi.fn();
    await attemptTokenRefreshWith({
      getCurrentToken: () => TOKEN,
      getTokenExpiresAt: () => Date.now() + 600_000,
      setToken: vi.fn(),
      clearToken,
      scheduleRefreshAlarm: vi.fn(),
      createTtlAlarm: vi.fn(),
    });

    expect(clearToken).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("revokeTokenOnServerWith (C8 — DPoP header on revoke)", () => {
  beforeEach(() => {
    dpopKeyMocks.signDpopProof.mockReset();
    dpopKeyMocks.signDpopProof.mockResolvedValue("fake.dpop.jws");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls fetch with DPoP header on token revocation", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await revokeTokenOnServerWith({
      getCurrentToken: () => TOKEN,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("DPoP")).toBe("fake.dpop.jws");
  });
});
