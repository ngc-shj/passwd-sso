/**
 * Unit tests for src/lib/auth/session/session-cache.ts.
 *
 * Mock surface:
 *   - "@/lib/redis"            : controllable redis stub
 *   - "@/lib/crypto/crypto-server" : controllable getMasterKeyByVersion
 *
 * All fixtures are typed literals (no `as SessionInfo` casts, no spread
 * from production helpers — T-17 obligation). All TTL / key-prefix values
 * imported from the module under test (T-10 obligation).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockGetRedis,
  mockGet,
  mockSet,
  mockDel,
  mockPipelineSet,
  mockPipelineExec,
  mockPipelineFactory,
  mockGetMasterKeyByVersion,
} = vi.hoisted(() => {
  const setFn = vi.fn();
  const execFn = vi.fn();
  return {
    mockGetRedis: vi.fn(),
    mockGet: vi.fn(),
    mockSet: vi.fn(),
    mockDel: vi.fn(),
    mockPipelineSet: setFn,
    mockPipelineExec: execFn,
    mockPipelineFactory: vi.fn(() => ({
      set: setFn,
      exec: execFn,
    })),
    mockGetMasterKeyByVersion: vi.fn(),
  };
});

vi.mock("@/lib/redis", () => ({
  getRedis: mockGetRedis,
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  getMasterKeyByVersion: mockGetMasterKeyByVersion,
}));

// ── Imports of module under test ────────────────────────────

import {
  hashSessionToken,
  getCachedSession,
  setCachedSession,
  invalidateCachedSession,
  invalidateCachedSessionsBulk,
  SessionInfoSchema,
  NegativeCacheSchema,
  TombstoneSchema,
  SESSION_CACHE_TTL_MS,
  NEGATIVE_CACHE_TTL_MS,
  TOMBSTONE_TTL_MS,
  SESSION_CACHE_KEY_PREFIX,
  _resetSubkeyCacheForTests,
  type SessionInfo,
} from "./session-cache";

// ── Fixtures (typed literals, T-17) ─────────────────────────

const fixtureValidSession: SessionInfo = {
  valid: true,
  userId: "uuid-1234",
  tenantId: "uuid-tenant",
  hasPasskey: true,
  requirePasskey: false,
  requirePasskeyEnabledAt: null,
  passkeyGracePeriodDays: null,
};

const fixtureNegativeSession: SessionInfo = {
  valid: false,
};

const FIXED_IKM = Buffer.from(
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  "hex",
);

// ── Helpers ─────────────────────────────────────────────────

function buildRedisStub(): {
  get: typeof mockGet;
  set: typeof mockSet;
  del: typeof mockDel;
  pipeline: typeof mockPipelineFactory;
} {
  return {
    get: mockGet,
    set: mockSet,
    del: mockDel,
    pipeline: mockPipelineFactory,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetSubkeyCacheForTests();
  mockGetMasterKeyByVersion.mockReturnValue(FIXED_IKM);
  mockGetRedis.mockReturnValue(buildRedisStub());
});

afterEach(() => {
  _resetSubkeyCacheForTests();
});

// ── Test 1: hashSessionToken determinism + 64-hex output ────

describe("hashSessionToken", () => {
  it("is deterministic and returns 64-hex output for given token+ikm", () => {
    const a = hashSessionToken("alpha");
    const b = hashSessionToken("alpha");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs across master keys (ikm change → different output)", () => {
    // First call uses FIXED_IKM
    const hashV1 = hashSessionToken("token-x");

    // Reset memoization, swap IKM to DIFFERENT bytes, recompute
    _resetSubkeyCacheForTests();
    const altIkm = Buffer.from(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "hex",
    );
    mockGetMasterKeyByVersion.mockReturnValue(altIkm);
    const hashAlt = hashSessionToken("token-x");

    expect(hashV1).not.toBe(hashAlt);
  });

  // ── Test 3: Subkey identity invariant (T-12) ──────────────
  it(
    "memoizes subkey: getMasterKeyByVersion called once with literal 1, " +
      "even across many hashSessionToken calls",
    () => {
      hashSessionToken("X");
      expect(mockGetMasterKeyByVersion).toHaveBeenCalledTimes(1);
      expect(mockGetMasterKeyByVersion).toHaveBeenCalledWith(1);

      hashSessionToken("X");
      hashSessionToken("Y");
      // Memoized — still exactly one call to getMasterKeyByVersion.
      expect(mockGetMasterKeyByVersion).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "subkey identity: changing getMasterKeyByVersion(2) bytes does not " +
      "alter hashSessionToken output (V1 pinning)",
    () => {
      // First, prime the memoized subkey from V1.
      const original = hashSessionToken("X");

      // Now configure a different value for V2 — implementation must NOT
      // consult V2 (it's pinned to V1).
      mockGetMasterKeyByVersion.mockImplementation((v: number) => {
        if (v === 2) {
          return Buffer.from(
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            "hex",
          );
        }
        return FIXED_IKM;
      });

      const after = hashSessionToken("X");
      expect(after).toBe(original);
    },
  );
});

// ── Tests 4-9: getCachedSession ──────────────────────────────

describe("getCachedSession", () => {
  it("returns null when Redis returns null (cache miss)", async () => {
    mockGet.mockResolvedValueOnce(null);
    const result = await getCachedSession("tok");
    expect(result).toBeNull();
    expect(mockDel).not.toHaveBeenCalled();
  });

  it("returns parsed SessionInfo on a valid JSON+schema entry", async () => {
    mockGet.mockResolvedValueOnce(JSON.stringify(fixtureValidSession));
    const result = await getCachedSession("tok");
    expect(result).toStrictEqual<SessionInfo>(fixtureValidSession);
    expect(mockDel).not.toHaveBeenCalled();
  });

  it("returns { valid: false } on a NegativeCache entry", async () => {
    mockGet.mockResolvedValueOnce(JSON.stringify({ valid: false }));
    const result = await getCachedSession("tok");
    expect(result).toStrictEqual<SessionInfo>(fixtureNegativeSession);
    expect(mockDel).not.toHaveBeenCalled();
  });

  it(
    "tombstone preservation (T-14 / S-12): returns null AND does NOT call del",
    async () => {
      mockGet.mockResolvedValueOnce(JSON.stringify({ tombstone: true }));
      const result = await getCachedSession("tok");
      expect(result).toBeNull();
      expect(mockDel).not.toHaveBeenCalled();
    },
  );

  it("evicts AND returns null on malformed JSON (parse error path)", async () => {
    mockGet.mockResolvedValueOnce("{not valid json");
    mockDel.mockResolvedValueOnce(1);
    const result = await getCachedSession("tok");
    expect(result).toBeNull();
    expect(mockDel).toHaveBeenCalledTimes(1);
  });

  it(
    "evicts AND returns null on JSON-valid but neither tombstone, " +
      "negative, nor SessionInfo shape",
    async () => {
      // (a) typo'd tombstone key
      mockGet.mockResolvedValueOnce(JSON.stringify({ tombstoned: true }));
      mockDel.mockResolvedValue(1);
      expect(await getCachedSession("tok")).toBeNull();
      expect(mockDel).toHaveBeenCalledTimes(1);

      // (b) wrong type for userId
      mockGet.mockResolvedValueOnce(JSON.stringify({ valid: true, userId: 123 }));
      expect(await getCachedSession("tok")).toBeNull();
      expect(mockDel).toHaveBeenCalledTimes(2);

      // (c) wrong type for nested fields
      mockGet.mockResolvedValueOnce(
        JSON.stringify({ valid: true, userId: false }),
      );
      expect(await getCachedSession("tok")).toBeNull();
      expect(mockDel).toHaveBeenCalledTimes(3);
    },
  );

  it("returns null when Redis is unavailable (getRedis returns null)", async () => {
    mockGetRedis.mockReturnValueOnce(null);
    expect(await getCachedSession("tok")).toBeNull();
  });
});

// ── Tests 10-14: setCachedSession ────────────────────────────

describe("setCachedSession", () => {
  it(
    "writes JSON.stringify(info) with PX=ttlMs and NX (exact string-level call, T-4)",
    async () => {
      mockSet.mockResolvedValueOnce("OK");
      await setCachedSession("tok", fixtureValidSession, 2000);

      const expectedKey = `${SESSION_CACHE_KEY_PREFIX}${hashSessionToken("tok")}`;
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith(
        expectedKey,
        JSON.stringify(fixtureValidSession),
        "PX",
        2000,
        "NX",
      );
    },
  );

  it("clamps ttlMs > SESSION_CACHE_TTL_MS to SESSION_CACHE_TTL_MS", async () => {
    mockSet.mockResolvedValueOnce("OK");
    await setCachedSession("tok", fixtureValidSession, 60_000);
    expect(mockSet).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify(fixtureValidSession),
      "PX",
      SESSION_CACHE_TTL_MS,
      "NX",
    );
  });

  it("is a no-op when ttlMs < 1000 (S-Req-5)", async () => {
    await setCachedSession("tok", fixtureValidSession, 500);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it(
    "writes negative cache for { valid: false } with PX=NEGATIVE_CACHE_TTL_MS, NX (S-Req-6)",
    async () => {
      mockSet.mockResolvedValueOnce("OK");
      await setCachedSession("tok", fixtureNegativeSession, SESSION_CACHE_TTL_MS);

      const expectedKey = `${SESSION_CACHE_KEY_PREFIX}${hashSessionToken("tok")}`;
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith(
        expectedKey,
        JSON.stringify({ valid: false }),
        "PX",
        NEGATIVE_CACHE_TTL_MS,
        "NX",
      );
    },
  );

  it("returns gracefully when Redis NX rejects (returns null)", async () => {
    mockSet.mockResolvedValueOnce(null);
    await expect(
      setCachedSession("tok", fixtureValidSession, 2000),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValueOnce(null);
    await setCachedSession("tok", fixtureValidSession, 2000);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

// ── Tests 15-16: invalidateCachedSession ─────────────────────

describe("invalidateCachedSession", () => {
  it(
    "writes tombstone JSON with PX=TOMBSTONE_TTL_MS (NO DEL, exact string-level call)",
    async () => {
      mockSet.mockResolvedValueOnce("OK");
      await invalidateCachedSession("tok");

      const expectedKey = `${SESSION_CACHE_KEY_PREFIX}${hashSessionToken("tok")}`;
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith(
        expectedKey,
        JSON.stringify({ tombstone: true }),
        "PX",
        TOMBSTONE_TTL_MS,
      );
      expect(mockDel).not.toHaveBeenCalled();
    },
  );

  it("is a no-op (caught + throttled-logged) on Redis error", async () => {
    mockSet.mockRejectedValueOnce(
      Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    await expect(invalidateCachedSession("tok")).resolves.toBeUndefined();
  });

  it("is a no-op when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValueOnce(null);
    await invalidateCachedSession("tok");
    expect(mockSet).not.toHaveBeenCalled();
  });
});

// ── Test 17: Synchronous throw containment ──────────────────

describe("error containment (sync throws from hashSessionToken)", () => {
  it(
    "getCachedSession catches sync throws from getMasterKeyByVersion " +
      "and returns null",
    async () => {
      mockGetMasterKeyByVersion.mockImplementation(() => {
        throw new Error("master key missing");
      });
      await expect(getCachedSession("tok")).resolves.toBeNull();
    },
  );

  it(
    "invalidateCachedSession catches sync throws from getMasterKeyByVersion",
    async () => {
      mockGetMasterKeyByVersion.mockImplementation(() => {
        throw new Error("master key missing");
      });
      await expect(invalidateCachedSession("tok")).resolves.toBeUndefined();
    },
  );

  it(
    "setCachedSession catches sync throws from getMasterKeyByVersion (S-5/S-11 cold-start)",
    async () => {
      mockGetMasterKeyByVersion.mockImplementation(() => {
        throw new Error("master key missing");
      });
      await expect(
        setCachedSession("tok", fixtureValidSession, 2000),
      ).resolves.toBeUndefined();
    },
  );
});

// ── Test 18: Cross-shape mutual exclusivity (S-12) ──────────

describe("schema mutual exclusivity (S-12 ordering invariants)", () => {
  it("NegativeCacheSchema rejects { tombstone: true }", () => {
    const r = NegativeCacheSchema.safeParse({ tombstone: true });
    expect(r.success).toBe(false);
  });

  it("TombstoneSchema rejects { valid: false }", () => {
    const r = TombstoneSchema.safeParse({ valid: false });
    expect(r.success).toBe(false);
  });

  it("SessionInfoSchema rejects { tombstone: true }", () => {
    const r = SessionInfoSchema.safeParse({ tombstone: true });
    expect(r.success).toBe(false);
  });

  it("SessionInfoSchema rejects { valid: false }", () => {
    // Negative cache shape is NOT a SessionInfo; the sentinel must go via
    // NegativeCacheSchema.
    const r = SessionInfoSchema.safeParse({ valid: false });
    expect(r.success).toBe(false);
  });
});

// ── Test 19: invalidateCachedSessionsBulk ───────────────────

describe("invalidateCachedSessionsBulk", () => {
  it("issues a single Redis pipeline with N tombstone SETs", async () => {
    mockPipelineExec.mockResolvedValueOnce([]);
    const tokens = ["t1", "t2", "t3"];
    await invalidateCachedSessionsBulk(tokens);

    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
    expect(mockPipelineSet).toHaveBeenCalledTimes(tokens.length);
    expect(mockPipelineExec).toHaveBeenCalledTimes(1);

    for (const token of tokens) {
      const expectedKey = `${SESSION_CACHE_KEY_PREFIX}${hashSessionToken(token)}`;
      expect(mockPipelineSet).toHaveBeenCalledWith(
        expectedKey,
        JSON.stringify({ tombstone: true }),
        "PX",
        TOMBSTONE_TTL_MS,
      );
    }
  });

  it("is a no-op on empty input (no Redis call)", async () => {
    await invalidateCachedSessionsBulk([]);
    expect(mockPipelineFactory).not.toHaveBeenCalled();
    expect(mockGetRedis).not.toHaveBeenCalled();
  });

  it("is a no-op when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValueOnce(null);
    await invalidateCachedSessionsBulk(["t1"]);
    expect(mockPipelineFactory).not.toHaveBeenCalled();
  });

  it("swallows pipeline.exec errors (caught + throttled-logged)", async () => {
    mockPipelineExec.mockRejectedValueOnce(
      Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    await expect(
      invalidateCachedSessionsBulk(["t1", "t2"]),
    ).resolves.toBeUndefined();
  });
});
