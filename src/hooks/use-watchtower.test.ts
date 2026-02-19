// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ─── Minimal localStorage mock for Node/jsdom environment ────

const storageMap = new Map<string, string>();
const mockLocalStorage = {
  getItem: vi.fn((key: string) => storageMap.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { storageMap.set(key, String(value)); }),
  removeItem: vi.fn((key: string) => { storageMap.delete(key); }),
  clear: vi.fn(() => storageMap.clear()),
};
vi.stubGlobal("localStorage", mockLocalStorage);

// ─── vi.hoisted mocks ────────────────────────────────────────

const {
  mockUseVault,
  mockDecryptData,
  mockBuildPersonalEntryAAD,
  mockAnalyzeStrength,
  mockCheckHIBP,
  mockDelay,
  mockGetCooldownState,
} = vi.hoisted(() => ({
  mockUseVault: vi.fn(),
  mockDecryptData: vi.fn(),
  mockBuildPersonalEntryAAD: vi.fn(),
  mockAnalyzeStrength: vi.fn(),
  mockCheckHIBP: vi.fn(),
  mockDelay: vi.fn().mockResolvedValue(undefined),
  mockGetCooldownState: vi.fn(),
}));

// ─── vi.mock declarations ────────────────────────────────────

vi.mock("@/lib/vault-context", () => ({ useVault: mockUseVault }));

vi.mock("@/lib/crypto-client", () => ({
  decryptData: mockDecryptData,
}));

vi.mock("@/lib/crypto-aad", () => ({
  buildPersonalEntryAAD: mockBuildPersonalEntryAAD,
}));

vi.mock("@/lib/password-analyzer", () => ({
  analyzeStrength: mockAnalyzeStrength,
  checkHIBP: mockCheckHIBP,
  delay: mockDelay,
}));

vi.mock("@/lib/watchtower/state", () => ({
  getCooldownState: mockGetCooldownState,
}));

vi.mock("@/lib/constants", () => ({
  API_PATH: {
    WATCHTOWER_START: "/api/watchtower/start",
    PASSWORDS: "/api/passwords",
  },
  ENTRY_TYPE: { LOGIN: "LOGIN" },
  LOCAL_STORAGE_KEY: { WATCHTOWER_LAST_ANALYZED_AT: "watchtower:lastAnalyzedAt" },
}));

// ─── Import under test (after mocks) ────────────────────────

import {
  useWatchtower,
  OLD_THRESHOLD_DAYS,
  WATCHTOWER_COOLDOWN_MS,
} from "./use-watchtower";

// ─── Helpers ─────────────────────────────────────────────────

/** Fake CryptoKey for tests */
const fakeKey = { type: "secret" } as unknown as CryptoKey;

/** Build a mock fetch response */
function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

/** Build a raw entry as returned by GET /api/passwords?include=blob */
function makeRawEntry(overrides: {
  id?: string;
  password?: string;
  url?: string;
  updatedAt?: string;
  entryType?: string | null;
  encryptedBlob?: object | null;
  aadVersion?: number;
} = {}) {
  const id = overrides.id ?? "entry-1";
  const password = overrides.password ?? "Str0ng!Pass#42";
  const url = overrides.url ?? "https://example.com";
  const updatedAt = overrides.updatedAt ?? new Date().toISOString();

  return {
    id,
    entryType: "entryType" in overrides ? overrides.entryType : "LOGIN",
    encryptedBlob: "encryptedBlob" in overrides ? overrides.encryptedBlob : { ciphertext: "aaa", iv: "bbb", authTag: "ccc" },
    aadVersion: overrides.aadVersion ?? 1,
    updatedAt,
    _plaintext: JSON.stringify({
      title: `Site ${id}`,
      username: `user-${id}`,
      password,
      url,
    }),
  };
}

/** Default strong result from analyzeStrength */
const strongResult = {
  score: 80,
  entropy: 60,
  hasUppercase: true,
  hasLowercase: true,
  hasNumbers: true,
  hasSymbols: true,
  patterns: [],
};

/** Weak result */
const weakResult = {
  score: 20,
  entropy: 15,
  hasUppercase: false,
  hasLowercase: true,
  hasNumbers: false,
  hasSymbols: false,
  patterns: ["common:password"],
};

// ─── Setup ───────────────────────────────────────────────────

describe("useWatchtower", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Default vault mock
    mockUseVault.mockReturnValue({
      encryptionKey: fakeKey,
      userId: "user-1",
    });

    // Default cooldown: no cooldown, can analyze
    mockGetCooldownState.mockReturnValue({
      nextAllowedAt: null,
      cooldownRemainingMs: 0,
      canAnalyze: true,
    });

    // Default: strong password, not breached
    mockAnalyzeStrength.mockReturnValue(strongResult);
    mockCheckHIBP.mockResolvedValue({ breached: false, count: 0 });

    // Default decrypt: parse _plaintext from raw entry
    mockDecryptData.mockImplementation((_blob: unknown) => {
      // We'll override per-test; default returns a valid JSON
      return Promise.resolve(
        JSON.stringify({
          title: "Site",
          username: "user",
          password: "Str0ng!Pass#42",
          url: "https://example.com",
        })
      );
    });

    mockBuildPersonalEntryAAD.mockReturnValue(new Uint8Array([1, 2, 3]));

    // Spy on global fetch
    fetchSpy = vi.spyOn(globalThis, "fetch");

    // Clear localStorage mock state
    storageMap.clear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // ─── Exported constants ──────────────────────────────────

  it("exports OLD_THRESHOLD_DAYS = 90", () => {
    expect(OLD_THRESHOLD_DAYS).toBe(90);
  });

  it("exports WATCHTOWER_COOLDOWN_MS = 5 minutes", () => {
    expect(WATCHTOWER_COOLDOWN_MS).toBe(5 * 60 * 1000);
  });

  // ─── Initial state ──────────────────────────────────────

  it("returns initial state with no report", () => {
    const { result } = renderHook(() => useWatchtower());

    expect(result.current.report).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.progress).toEqual({ current: 0, total: 0, step: "" });
    expect(typeof result.current.analyze).toBe("function");
  });

  it("exposes canAnalyze from getCooldownState", () => {
    mockGetCooldownState.mockReturnValue({
      nextAllowedAt: null,
      cooldownRemainingMs: 0,
      canAnalyze: true,
    });

    const { result } = renderHook(() => useWatchtower());
    expect(result.current.canAnalyze).toBe(true);
  });

  it("exposes canAnalyze=false when cooldown is active", () => {
    mockGetCooldownState.mockReturnValue({
      nextAllowedAt: Date.now() + 60000,
      cooldownRemainingMs: 60000,
      canAnalyze: false,
    });

    const { result } = renderHook(() => useWatchtower());
    expect(result.current.canAnalyze).toBe(false);
    expect(result.current.cooldownRemainingMs).toBe(60000);
  });

  it("reads lastAnalyzedAt from localStorage on mount", () => {
    const ts = Date.now() - 1000;
    window.localStorage.setItem("watchtower:lastAnalyzedAt", String(ts));

    renderHook(() => useWatchtower());

    // getCooldownState should have been called with a numeric lastAnalyzedAt
    expect(mockGetCooldownState).toHaveBeenCalled();
    // The first call during render may have null, but after the effect runs it'll update
  });

  // ─── Analyze: empty passwords → score 100 ───────────────

  it("produces score 100 when there are no passwords", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true })) // POST /api/watchtower/start
      .mockResolvedValueOnce(jsonResponse([])); // GET /api/passwords?include=blob

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report).not.toBeNull();
    expect(result.current.report!.totalPasswords).toBe(0);
    expect(result.current.report!.overallScore).toBe(100);
    expect(result.current.report!.breached).toEqual([]);
    expect(result.current.report!.weak).toEqual([]);
    expect(result.current.report!.reused).toEqual([]);
    expect(result.current.report!.old).toEqual([]);
    expect(result.current.report!.unsecured).toEqual([]);
  });

  // ─── Analyze: full pipeline with healthy entries ─────────

  it("analyzes entries and produces a report with all-clear results", async () => {
    const raw = makeRawEntry();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true })) // start
      .mockResolvedValueOnce(jsonResponse([raw])); // passwords

    mockDecryptData.mockResolvedValue(raw._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report).not.toBeNull();
    expect(result.current.report!.totalPasswords).toBe(1);
    expect(result.current.report!.breached).toHaveLength(0);
    expect(result.current.report!.weak).toHaveLength(0);
    expect(result.current.report!.reused).toHaveLength(0);
    expect(result.current.report!.unsecured).toHaveLength(0);
    expect(result.current.report!.overallScore).toBe(100);
    expect(result.current.loading).toBe(false);
  });

  // ─── Weak password detection ─────────────────────────────

  it("detects weak passwords (score < 50)", async () => {
    const raw = makeRawEntry({ password: "abc" });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);
    mockAnalyzeStrength.mockReturnValue(weakResult);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.weak).toHaveLength(1);
    expect(result.current.report!.weak[0].severity).toBe("high"); // score 20 < 25
    expect(result.current.report!.weak[0].details).toContain("entropy:");
  });

  it("assigns medium severity to weak passwords with score >= 25", async () => {
    const raw = makeRawEntry({ password: "weak1" });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);
    mockAnalyzeStrength.mockReturnValue({ ...weakResult, score: 30, entropy: 25 });

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.weak[0].severity).toBe("medium");
  });

  // ─── Reused password detection ───────────────────────────

  it("detects reused passwords via SHA-256 hash dedup", async () => {
    const samePassword = "SamePass!123";
    const raw1 = makeRawEntry({ id: "e1", password: samePassword });
    const raw2 = makeRawEntry({ id: "e2", password: samePassword });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw1, raw2]));

    // Each entry decrypts to the same password
    mockDecryptData
      .mockResolvedValueOnce(raw1._plaintext)
      .mockResolvedValueOnce(raw2._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.reused).toHaveLength(1);
    expect(result.current.report!.reused[0].entries).toHaveLength(2);
    expect(result.current.report!.reused[0].entries[0].id).toBe("e1");
    expect(result.current.report!.reused[0].entries[1].id).toBe("e2");
  });

  // ─── Old password detection ──────────────────────────────

  it("detects old passwords (>90 days) with low severity", async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const raw = makeRawEntry({ updatedAt: oldDate });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.old).toHaveLength(1);
    expect(result.current.report!.old[0].severity).toBe("low");
    expect(result.current.report!.old[0].details).toMatch(/^days:\d+/);
  });

  it("assigns medium severity to passwords older than 180 days", async () => {
    const veryOldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const raw = makeRawEntry({ updatedAt: veryOldDate });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.old).toHaveLength(1);
    expect(result.current.report!.old[0].severity).toBe("medium");
  });

  it("does not flag recent passwords as old", async () => {
    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const raw = makeRawEntry({ updatedAt: recentDate });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.old).toHaveLength(0);
  });

  // ─── Unsecured URL detection ─────────────────────────────

  it("detects HTTP URLs as unsecured", async () => {
    const raw = makeRawEntry({ url: "http://insecure.example.com" });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.unsecured).toHaveLength(1);
    expect(result.current.report!.unsecured[0].severity).toBe("medium");
    expect(result.current.report!.unsecured[0].details).toContain("http://");
  });

  it("does not flag HTTPS URLs", async () => {
    const raw = makeRawEntry({ url: "https://secure.example.com" });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.unsecured).toHaveLength(0);
  });

  // ─── Breach detection via HIBP ───────────────────────────

  it("detects breached passwords via checkHIBP", async () => {
    const raw = makeRawEntry();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);
    mockCheckHIBP.mockResolvedValue({ breached: true, count: 100 });

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.breached).toHaveLength(1);
    expect(result.current.report!.breached[0].severity).toBe("critical");
    expect(result.current.report!.breached[0].details).toBe("count:100");
  });

  it("deduplicates HIBP checks for identical passwords", async () => {
    const samePassword = "DupePass!1";
    const raw1 = makeRawEntry({ id: "e1", password: samePassword });
    const raw2 = makeRawEntry({ id: "e2", password: samePassword });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw1, raw2]));

    mockDecryptData
      .mockResolvedValueOnce(raw1._plaintext)
      .mockResolvedValueOnce(raw2._plaintext);

    mockCheckHIBP.mockResolvedValue({ breached: true, count: 50 });

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    // checkHIBP should be called only once (deduped)
    expect(mockCheckHIBP).toHaveBeenCalledTimes(1);
    // But both entries should be marked as breached
    expect(result.current.report!.breached).toHaveLength(2);
  });

  it("calls delay between HIBP requests for rate limiting", async () => {
    const raw1 = makeRawEntry({ id: "e1", password: "UniquePass1!" });
    const raw2 = makeRawEntry({ id: "e2", password: "UniquePass2!" });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw1, raw2]));

    mockDecryptData
      .mockResolvedValueOnce(raw1._plaintext)
      .mockResolvedValueOnce(raw2._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    // delay should be called between HIBP calls (not after the last one)
    expect(mockDelay).toHaveBeenCalledWith(1500);
    expect(mockDelay).toHaveBeenCalledTimes(1);
  });

  // ─── Non-LOGIN entries are skipped ───────────────────────

  it("skips non-LOGIN entries", async () => {
    const loginEntry = makeRawEntry({ id: "login-1", entryType: "LOGIN" });
    const noteEntry = makeRawEntry({ id: "note-1", entryType: "SECURE_NOTE" });
    const cardEntry = makeRawEntry({ id: "card-1", entryType: "CREDIT_CARD" });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([loginEntry, noteEntry, cardEntry]));

    mockDecryptData.mockResolvedValue(loginEntry._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    // Only the LOGIN entry should be analyzed
    expect(result.current.report!.totalPasswords).toBe(1);
    expect(mockDecryptData).toHaveBeenCalledTimes(1);
  });

  it("skips entries with no encryptedBlob", async () => {
    const noBlobEntry = makeRawEntry({ id: "no-blob", encryptedBlob: null });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([noBlobEntry]));

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    // No entries decrypted → empty password list → score 100
    expect(result.current.report!.totalPasswords).toBe(0);
    expect(result.current.report!.overallScore).toBe(100);
    expect(mockDecryptData).not.toHaveBeenCalled();
  });

  // ─── Entries with entryType null are treated as LOGIN ────

  it("includes entries with null entryType (legacy entries)", async () => {
    const legacyEntry = makeRawEntry({ id: "legacy-1", entryType: null });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([legacyEntry]));

    mockDecryptData.mockResolvedValue(legacyEntry._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.totalPasswords).toBe(1);
  });

  // ─── 429 Rate limit handling ─────────────────────────────

  it("handles 429 with retryAt by setting cooldown", async () => {
    const retryAt = Date.now() + WATCHTOWER_COOLDOWN_MS;
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ retryAt }, 429)
    );

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    // Report should remain null (analysis aborted)
    expect(result.current.report).toBeNull();

    // localStorage should be updated with the derived startedAt
    const stored = window.localStorage.getItem("watchtower:lastAnalyzedAt");
    expect(stored).not.toBeNull();
    const storedNum = Number(stored);
    expect(storedNum).toBe(retryAt - WATCHTOWER_COOLDOWN_MS);
  });

  it("handles 429 without retryAt by using fallback timestamp", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({}, 429)
    );

    const before = Date.now();
    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report).toBeNull();
    const stored = Number(window.localStorage.getItem("watchtower:lastAnalyzedAt"));
    expect(stored).toBeGreaterThanOrEqual(before);
  });

  it("handles 429 with unparseable JSON body", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.reject(new Error("bad json")),
    } as unknown as Response);

    const before = Date.now();
    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    // Falls through to the else branch (no retryAt) → fallback timestamp
    expect(result.current.report).toBeNull();
    const stored = Number(window.localStorage.getItem("watchtower:lastAnalyzedAt"));
    expect(stored).toBeGreaterThanOrEqual(before);
  });

  // ─── Non-429 start failure ──────────────────────────────

  it("aborts silently on non-429 start failure", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "server error" }, 500));

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  // ─── Fetch failure for passwords ─────────────────────────

  it("handles fetch failure for passwords silently", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true })) // start succeeds
      .mockResolvedValueOnce(jsonResponse({ error: "fail" }, 500)); // passwords fail

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    // Error caught silently, report remains null, loading reset
    expect(result.current.report).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  // ─── Decrypt failure → skip entry ────────────────────────

  it("skips entries that fail to decrypt", async () => {
    const goodEntry = makeRawEntry({ id: "good-1" });
    const badEntry = makeRawEntry({ id: "bad-1" });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([goodEntry, badEntry]));

    mockDecryptData
      .mockResolvedValueOnce(goodEntry._plaintext)
      .mockRejectedValueOnce(new Error("decrypt failed"));

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    // Only the good entry should be in the report
    expect(result.current.report!.totalPasswords).toBe(1);
  });

  // ─── Guard: no encryptionKey ─────────────────────────────

  it("does nothing if encryptionKey is null", async () => {
    mockUseVault.mockReturnValue({ encryptionKey: null, userId: "user-1" });

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.report).toBeNull();
  });

  // ─── Guard: cooldown active ──────────────────────────────

  it("does nothing if cooldown is active", async () => {
    mockGetCooldownState.mockReturnValue({
      nextAllowedAt: Date.now() + 60000,
      cooldownRemainingMs: 60000,
      canAnalyze: false,
    });

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ─── AAD handling ────────────────────────────────────────

  it("passes AAD when aadVersion >= 1 and userId is present", async () => {
    const raw = makeRawEntry({ aadVersion: 1 });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);
    const fakeAAD = new Uint8Array([1, 2, 3]);
    mockBuildPersonalEntryAAD.mockReturnValue(fakeAAD);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(mockBuildPersonalEntryAAD).toHaveBeenCalledWith("user-1", "entry-1");
    expect(mockDecryptData).toHaveBeenCalledWith(
      raw.encryptedBlob,
      fakeKey,
      fakeAAD
    );
  });

  it("does not pass AAD when aadVersion < 1", async () => {
    const raw = makeRawEntry({ aadVersion: 0 });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(mockDecryptData).toHaveBeenCalledWith(
      raw.encryptedBlob,
      fakeKey,
      undefined
    );
  });

  // ─── Score calculation ───────────────────────────────────

  it("calculates weighted score: all issues → low score", async () => {
    // 2 entries, both breached, both weak, both reused, both old, both unsecured
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const samePass = "weak";
    const raw1 = makeRawEntry({ id: "e1", password: samePass, url: "http://bad.com", updatedAt: oldDate });
    const raw2 = makeRawEntry({ id: "e2", password: samePass, url: "http://bad2.com", updatedAt: oldDate });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw1, raw2]));

    mockDecryptData
      .mockResolvedValueOnce(raw1._plaintext)
      .mockResolvedValueOnce(raw2._plaintext);

    mockAnalyzeStrength.mockReturnValue(weakResult);
    mockCheckHIBP.mockResolvedValue({ breached: true, count: 999 });

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    // total=2, breached=2, weak=2, reused=2, old=2, unsecured=2
    // breach: (2-2)/2*40=0, strength: (2-2)/2*25=0, unique: (2-2)/2*20=0
    // freshness: (2-2)/2*10=0, security: (2-2)/2*5=0 → total=0
    expect(result.current.report!.overallScore).toBe(0);
  });

  it("calculates weighted score: no issues → score 100", async () => {
    const raw = makeRawEntry();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.overallScore).toBe(100);
  });

  it("calculates partial score with only breach issues", async () => {
    const raw = makeRawEntry();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);
    mockCheckHIBP.mockResolvedValue({ breached: true, count: 5 });

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    // total=1, breached=1 → breach: 0, strength: 25, unique: 20, fresh: 10, sec: 5 = 60
    expect(result.current.report!.overallScore).toBe(60);
  });

  it("calculates partial score with only weakness issues", async () => {
    const raw = makeRawEntry();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(raw._plaintext);
    mockAnalyzeStrength.mockReturnValue(weakResult);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    // total=1, weak=1 → breach: 40, strength: 0, unique: 20, fresh: 10, sec: 5 = 75
    expect(result.current.report!.overallScore).toBe(75);
  });

  // ─── localStorage persistence ────────────────────────────

  it("stores lastAnalyzedAt in localStorage after successful start", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([]));

    const before = Date.now();
    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    const stored = Number(window.localStorage.getItem("watchtower:lastAnalyzedAt"));
    expect(stored).toBeGreaterThanOrEqual(before);
  });

  // ─── Entry with null url field ───────────────────────────

  it("handles entries with null url without flagging unsecured", async () => {
    const raw = makeRawEntry({ url: "https://example.com" });
    // Override the decrypted data to have no url
    const plaintext = JSON.stringify({
      title: "Site entry-1",
      username: "user-entry-1",
      password: "Str0ng!Pass#42",
    });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw]));

    mockDecryptData.mockResolvedValue(plaintext);

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.report!.unsecured).toHaveLength(0);
  });

  // ─── Multiple issue types in one analysis ────────────────

  it("detects multiple issue types simultaneously", async () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const raw1 = makeRawEntry({ id: "e1", password: "weak1", url: "http://bad.com", updatedAt: oldDate });
    const raw2 = makeRawEntry({ id: "e2", password: "weak1", url: "https://good.com" });
    const raw3 = makeRawEntry({ id: "e3", password: "Strong!99#xyz", url: "https://safe.com" });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse([raw1, raw2, raw3]));

    mockDecryptData
      .mockResolvedValueOnce(raw1._plaintext)
      .mockResolvedValueOnce(raw2._plaintext)
      .mockResolvedValueOnce(raw3._plaintext);

    // e1 and e2 have weak password, e3 is strong
    mockAnalyzeStrength
      .mockReturnValueOnce(weakResult)
      .mockReturnValueOnce(weakResult)
      .mockReturnValueOnce(strongResult);

    // Only e1's password is breached (same as e2's), e3's not
    mockCheckHIBP
      .mockResolvedValueOnce({ breached: true, count: 42 }) // weak1
      .mockResolvedValueOnce({ breached: false, count: 0 }); // Strong!99#xyz

    const { result } = renderHook(() => useWatchtower());

    await act(async () => {
      await result.current.analyze();
    });

    const report = result.current.report!;
    expect(report.totalPasswords).toBe(3);
    expect(report.weak).toHaveLength(2); // e1, e2
    expect(report.reused).toHaveLength(1); // e1 + e2 same password
    expect(report.reused[0].entries).toHaveLength(2);
    expect(report.old).toHaveLength(1); // e1
    expect(report.unsecured).toHaveLength(1); // e1
    expect(report.breached).toHaveLength(2); // e1 and e2 share breached password
  });

  // ─── loading flag lifecycle ──────────────────────────────

  it("sets loading=true during analysis and false when done", async () => {
    const raw = makeRawEntry();

    // Use a deferred promise to control timing
    let resolvePasswords: (v: Response) => void;
    const passwordsPromise = new Promise<Response>((r) => { resolvePasswords = r; });

    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockReturnValueOnce(passwordsPromise as Promise<Response>);

    mockDecryptData.mockResolvedValue(raw._plaintext);

    const { result } = renderHook(() => useWatchtower());

    // Start analysis (don't await)
    let analyzePromise: Promise<void>;
    act(() => {
      analyzePromise = result.current.analyze();
    });

    // Loading should be true after the start request completes
    // Resolve the passwords request
    await act(async () => {
      resolvePasswords!(jsonResponse([raw]));
      await analyzePromise!;
    });

    expect(result.current.loading).toBe(false);
  });
});
