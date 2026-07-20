import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";

const {
  mockValidateApiKeyOnly,
  mockEnforceAccessRestriction,
  mockCreateRateLimiter,
  mockEntryFindUnique,
  mockEntryUpdate,
  mockEntryDelete,
  mockHistoryCreate,
  mockHistoryFindMany,
  mockHistoryDeleteMany,
  mockFolderFindFirst,
  mockTagCount,
  mockQueryRaw,
  mockLogAudit,
  mockWithTenantRls,
} = vi.hoisted(() => {
  // curRow returned by $queryRaw FOR UPDATE — values are DISTINCT from ownedEntry
  // so field-level assertions can detect if the handler reads from `existing` instead.
  const curRow = {
    encrypted_blob: "cur-v1-blob",
    blob_iv: "cur-v1-iv",
    blob_auth_tag: "cur-v1-tag",
    key_version: 9,
    aad_version: 7,
  };
  // Discriminate by SQL text: assertCurrentKeyVersion's `FROM users` guard
  // read must return a DIFFERENT row than the entry `FOR UPDATE` snapshot
  // read — a single blanket mock would vacuously satisfy both (test-F4).
  const mockQueryRaw = vi.fn().mockImplementation((tpl: TemplateStringsArray) => {
    const sql = tpl.join("?");
    if (/FROM users/i.test(sql)) {
      return Promise.resolve([{ key_version: 2 }]);
    }
    return Promise.resolve([curRow]);
  });

  return {
    mockValidateApiKeyOnly: vi.fn(),
    mockEnforceAccessRestriction: vi.fn().mockResolvedValue(null),
    // Recording factory: assertRedisFailClosed's factory-attribution step
    // reads mock.calls/mock.results (a plain arrow would record nothing).
    // Each call returns a DISTINCT check mock (default allowed:true) so a
    // route wired to the wrong limiter cannot borrow the arranged failure —
    // the fail-closed cases arm only the v1 instance's check (external
    // security review 2026-07-20, P2-1).
    mockCreateRateLimiter: vi.fn(
      (_opts: { windowMs: number; max: number; failClosedOnRedisError?: boolean }) => ({
        check: vi.fn().mockResolvedValue({ allowed: true }),
      }),
    ),
    mockEntryFindUnique: vi.fn(),
    mockEntryUpdate: vi.fn(),
    mockEntryDelete: vi.fn(),
    mockHistoryCreate: vi.fn(),
    mockHistoryFindMany: vi.fn().mockResolvedValue([]),
    mockHistoryDeleteMany: vi.fn(),
    mockFolderFindFirst: vi.fn(),
    mockTagCount: vi.fn(),
    mockQueryRaw,
    mockLogAudit: vi.fn(),
    mockWithTenantRls: vi.fn(async (prisma: unknown, _tenantId: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  };
});

// curRow values accessible in test assertions (must match the vi.hoisted values)
const V1_CUR_ROW = {
  encrypted_blob: "cur-v1-blob",
  blob_iv: "cur-v1-iv",
  blob_auth_tag: "cur-v1-tag",
  key_version: 9,
  aad_version: 7,
};

vi.mock("@/lib/auth/tokens/api-key", () => ({ validateApiKeyOnly: mockValidateApiKeyOnly }));
vi.mock("@/lib/auth/policy/access-restriction", () => ({ enforceAccessRestriction: mockEnforceAccessRestriction }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: { findUnique: mockEntryFindUnique, update: mockEntryUpdate, delete: mockEntryDelete },
    passwordEntryHistory: {
      create: mockHistoryCreate,
      findMany: mockHistoryFindMany,
      deleteMany: mockHistoryDeleteMany,
    },
    folder: { findFirst: mockFolderFindFirst },
    tag: { count: mockTagCount },
    $queryRaw: mockQueryRaw,
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>, withTenantRls: mockWithTenantRls }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
  // Used by emitRateLimitFailClosed (rate-limit-audit.ts) on the redisErrored path.
  tenantAuditBase: vi.fn((_, userId, tenantId) => ({ scope: "TENANT", userId, tenantId })),
}));

import { GET, PUT, DELETE } from "./route";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

// Module-scope snapshot: rate-limiters.ts's module-level createRateLimiter
// calls ran at import time above; capture before beforeEach's
// vi.clearAllMocks() wipes mock.calls/mock.results (see snapshotFactory doc).
// Resolve the limiter under test by factory ARGS, not positional index —
// the same mocked factory also constructs migrateLimiter et al. at load.
const limiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const v1LimiterCallIndex = mockCreateRateLimiter.mock.calls.findIndex(
  ([opts]) =>
    opts.windowMs === RATE_WINDOW_MS && opts.max === 100 && opts.failClosedOnRedisError === true,
);
const v1LimiterResult = mockCreateRateLimiter.mock.results[v1LimiterCallIndex];
if (!v1LimiterResult) {
  throw new Error(
    "v1ApiKeyLimiter factory call not found — rate-limiters.ts options drifted from this test's match criteria (windowMs/max/failClosedOnRedisError)",
  );
}
const v1Limiter = v1LimiterResult.value as { check: Mock };
// The v1 instance's own check — arranging THIS mock (and only this one)
// proves the route is wired to v1ApiKeyLimiter; sibling factory products
// keep their allowed:true default, so a miswired route fails the
// "limiter reached" assertion instead of borrowing the arranged result.
const mockCheck = v1Limiter.check;

const PW_ID = "pw-123";
const USER_ID = "user-1";
const TENANT_ID = "tenant-1";
const API_KEY_ID = "key-1";
const now = new Date("2025-01-01T00:00:00Z");

const validApiKey = { userId: USER_ID, tenantId: TENANT_ID, apiKeyId: API_KEY_ID };

const ownedEntry = {
  id: PW_ID,
  userId: USER_ID,
  tenantId: TENANT_ID,
  encryptedBlob: "blob-cipher",
  blobIv: "blob-iv",
  blobAuthTag: "blob-tag",
  encryptedOverview: "overview-cipher",
  overviewIv: "overview-iv",
  overviewAuthTag: "overview-tag",
  keyVersion: 1,
  aadVersion: 0,
  entryType: "LOGIN",
  isFavorite: false,
  isArchived: false,
  requireReprompt: false,
  expiresAt: null as Date | null,
  folderId: null as string | null,
  tags: [{ id: "tag-1" }],
  createdAt: now,
  updatedAt: now,
};

describe("GET /api/v1/passwords/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "INVALID" });
    const res = await GET(
      createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBeDefined();
  });

  it("returns 403 when API key scope is insufficient", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "SCOPE_INSUFFICIENT" });
    const res = await GET(
      createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(403);
  });

  it("returns 429 when rate limit exceeded (no DB access)", async () => {
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const res = await GET(
      createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(mockEntryFindUnique).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the limiter reports redisErrored (no DB access)", async () => {
    await assertRedisFailClosed({
      invoke: () =>
        GET(
          createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
          createParams({ id: PW_ID }),
        ),
      limiter: v1Limiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockEntryFindUnique],
      limiterFactory: limiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  it("returns 404 when entry not found", async () => {
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when entry belongs to another user", async () => {
    mockEntryFindUnique.mockResolvedValue({ ...ownedEntry, userId: "other-user" });
    const res = await GET(
      createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("returns entry with correct shape including select fields", async () => {
    mockEntryFindUnique.mockResolvedValue(ownedEntry);
    const res = await GET(
      createRequest("GET", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.id).toBe(PW_ID);
    expect(json.encryptedBlob).toEqual({
      ciphertext: "blob-cipher",
      iv: "blob-iv",
      authTag: "blob-tag",
    });
    expect(json.encryptedOverview).toEqual({
      ciphertext: "overview-cipher",
      iv: "overview-iv",
      authTag: "overview-tag",
    });
    expect(json.tagIds).toEqual(["tag-1"]);
    expect(json.keyVersion).toBe(1);
    expect(json.aadVersion).toBe(0);
  });
});

describe("PUT /api/v1/passwords/[id]", () => {
  const updateBody = {
    encryptedBlob: { ciphertext: "new-blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "new-over", iv: "c".repeat(24), authTag: "d".repeat(32) },
    keyVersion: 2,
  };

  const updatedEntry = {
    id: PW_ID,
    encryptedOverview: "new-over",
    overviewIv: "c".repeat(24),
    overviewAuthTag: "d".repeat(32),
    keyVersion: 2,
    aadVersion: 0,
    entryType: "LOGIN",
    requireReprompt: false,
    expiresAt: null,
    tags: [],
    createdAt: now,
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockEntryFindUnique.mockResolvedValue(ownedEntry);
    // withTenantRls runs its callback inside a tenant-scoped transaction and
    // passes a tx client; the mock routes tx → the prisma mock, so writes land
    // on the top-level mockHistory*/mockEntryUpdate fns (no $transaction).
    mockHistoryCreate.mockResolvedValue({});
    mockHistoryFindMany.mockResolvedValue([]);
    mockHistoryDeleteMany.mockResolvedValue({ count: 0 });
    mockEntryUpdate.mockResolvedValue(updatedEntry);
    // Restore the discriminated default (clearAllMocks clears it each run):
    // `FROM users` (assertCurrentKeyVersion) → key_version matching
    // updateBody.keyVersion (2) so the guard passes; entry FOR UPDATE → V1_CUR_ROW.
    mockQueryRaw.mockImplementation((tpl: TemplateStringsArray) => {
      const sql = tpl.join("?");
      if (/FROM users/i.test(sql)) {
        return Promise.resolve([{ key_version: 2 }]);
      }
      return Promise.resolve([V1_CUR_ROW]);
    });
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "INVALID" });
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("updates entry and snapshots history when the blob changes", async () => {
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.id).toBe(PW_ID);
    expect(json.keyVersion).toBe(2);

    // C1: snapshot fields come from the FOR UPDATE re-read (V1_CUR_ROW), not from existing
    expect(mockHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryId: PW_ID,
          encryptedBlob: V1_CUR_ROW.encrypted_blob,
          blobIv: V1_CUR_ROW.blob_iv,
          blobAuthTag: V1_CUR_ROW.blob_auth_tag,
          keyVersion: V1_CUR_ROW.key_version,
          aadVersion: V1_CUR_ROW.aad_version,
        }),
      }),
    );
    expect(mockEntryUpdate).toHaveBeenCalled();

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ENTRY_UPDATE", targetId: PW_ID }),
    );
  });

  it("trims history to newest 20 when over limit", async () => {
    mockHistoryFindMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({ id: `hist-${i}` })),
    );

    await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );

    expect(mockHistoryDeleteMany).toHaveBeenCalledWith({
      where: { entryId: PW_ID, id: { in: ["hist-0"] } },
    });
  });

  it("does not snapshot history when only metadata changes (no encryptedBlob)", async () => {
    mockEntryUpdate.mockResolvedValue({ ...updatedEntry, isFavorite: true });

    await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: { isFavorite: true },
      }),
      createParams({ id: PW_ID }),
    );

    expect(mockHistoryCreate).not.toHaveBeenCalled();
    expect(mockEntryUpdate).toHaveBeenCalled();
  });

  it("rejects a keyVersion change without re-encryption (C7) with 409", async () => {
    // ownedEntry.keyVersion === 1; bumping to 2 without an encryptedBlob is the
    // metadata/ciphertext desync the guard must reject.
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: { keyVersion: 2 },
      }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("KEY_VERSION_WITHOUT_REENCRYPT");
    expect(mockEntryUpdate).not.toHaveBeenCalled();
  });

  it("rejects an aadVersion change without re-encryption (C7) with 409", async () => {
    // ownedEntry.aadVersion === 0; bumping to 1 without an encryptedBlob.
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: { aadVersion: 1 },
      }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("KEY_VERSION_WITHOUT_REENCRYPT");
    expect(mockEntryUpdate).not.toHaveBeenCalled();
  });

  // RT7/F1a: metadata-only PUT must strip keyVersion/aadVersion from the
  // prisma update payload even when the caller supplies matching values —
  // they are ONLY legitimate on the blob (re-encrypt) path. Reverting the
  // `if (encryptedBlob) { ... }` guard would let these fields leak into
  // `data` on the metadata-only path, failing this test.
  it("RT7/F1a: strips keyVersion and aadVersion from the update payload on metadata-only PUT", async () => {
    // ownedEntry.keyVersion === 1 — send the SAME value (no
    // KEY_VERSION_WITHOUT_REENCRYPT rejection) alongside a metadata field.
    // aadVersion is omitted from the body: aadVersionSchema is min(1) and
    // ownedEntry.aadVersion is 0, so there is no valid "same value" to send —
    // the keyVersion assertion alone proves the strip guard fires.
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: { isFavorite: true, keyVersion: 1 },
      }),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(mockEntryUpdate).toHaveBeenCalledTimes(1);
    const updateArg = mockEntryUpdate.mock.calls[0][0];
    expect(updateArg.data).not.toHaveProperty("keyVersion");
    expect(updateArg.data).not.toHaveProperty("aadVersion");
  });

  // RT7/F1b: a blob-changing PUT MUST carry its keyVersion so
  // assertCurrentKeyVersion always runs — otherwise a blob-without-keyVersion
  // write could race a rotation and permanently brick the entry. Reverting
  // the `if (encryptedBlob && keyVersion === undefined)` guard would let
  // this request fall through to a 200 instead of 409.
  it("RT7/F1b: rejects blob PUT with keyVersion omitted → 409 KEY_VERSION_WITHOUT_REENCRYPT", async () => {
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: {
          encryptedBlob: { ciphertext: "new-blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
          encryptedOverview: { ciphertext: "new-over", iv: "c".repeat(24), authTag: "d".repeat(32) },
          // keyVersion intentionally omitted
        },
      }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(409);
    expect(json.error).toBe("KEY_VERSION_WITHOUT_REENCRYPT");
    expect(mockEntryUpdate).not.toHaveBeenCalled();
    expect(mockHistoryCreate).not.toHaveBeenCalled();
  });

  it("allows a keyVersion change when an encryptedBlob is supplied (re-encryption)", async () => {
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    // blob-changing path: update goes through mockEntryUpdate (tx is the prisma mock)
    expect(mockEntryUpdate).toHaveBeenCalled();
  });

  // C1: FOR UPDATE snapshot source and SQL text guard
  it("C1: $queryRaw FOR UPDATE is issued before History.create on blob-changing PUT", async () => {
    const callOrder: string[] = [];
    mockQueryRaw.mockImplementation((tpl: TemplateStringsArray) => {
      const sql = tpl.join("?");
      if (/FROM users/i.test(sql)) {
        callOrder.push("$queryRaw:users");
        return Promise.resolve([{ key_version: 2 }]);
      }
      callOrder.push("$queryRaw:entries");
      return Promise.resolve([V1_CUR_ROW]);
    });
    mockHistoryCreate.mockImplementation(() => {
      callOrder.push("historyCreate");
      return Promise.resolve({});
    });

    await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );

    // Both queryRaw reads (user guard, then entry FOR UPDATE) precede History.create.
    expect(callOrder.indexOf("$queryRaw:users")).toBeLessThan(callOrder.indexOf("$queryRaw:entries"));
    expect(callOrder.indexOf("$queryRaw:entries")).toBeLessThan(callOrder.indexOf("historyCreate"));
  });

  it("C1: FOR UPDATE SQL contains table name and required crypto columns", async () => {
    await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );

    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    // Two distinct queryRaw reads now fire: assertCurrentKeyVersion's `FROM
    // users` guard, then the entry FOR UPDATE snapshot — find the latter by
    // SQL text rather than assuming call index.
    const entryCall = mockQueryRaw.mock.calls.find(([tpl]) => {
      const sqlText = (tpl as TemplateStringsArray).join("?");
      return /FROM password_entries/i.test(sqlText);
    }) as [TemplateStringsArray, ...unknown[]] | undefined;
    expect(entryCall).toBeDefined();
    const sql = entryCall![0].join("?");
    expect(sql).toMatch(/FOR UPDATE/i);
    expect(sql).toMatch(/password_entries/i);
    expect(sql).toMatch(/encrypted_blob/i);
    expect(sql).toMatch(/blob_iv/i);
    expect(sql).toMatch(/blob_auth_tag/i);
    expect(sql).toMatch(/key_version/i);
    expect(sql).toMatch(/aad_version/i);
  });

  it("C1: all 5 crypto fields in History.create come from $queryRaw result, not from existing", async () => {
    await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );

    const histData = mockHistoryCreate.mock.calls[0][0].data;
    expect(histData.encryptedBlob).toBe(V1_CUR_ROW.encrypted_blob);
    expect(histData.blobIv).toBe(V1_CUR_ROW.blob_iv);
    expect(histData.blobAuthTag).toBe(V1_CUR_ROW.blob_auth_tag);
    expect(histData.keyVersion).toBe(V1_CUR_ROW.key_version);
    expect(histData.aadVersion).toBe(V1_CUR_ROW.aad_version);
    // Distinct-from-ownedEntry sanity check
    expect(histData.encryptedBlob).not.toBe(ownedEntry.encryptedBlob);
    expect(histData.keyVersion).not.toBe(ownedEntry.keyVersion);
  });

  // F1: race — entry deleted between early read and FOR UPDATE lock
  it("F1: returns 404 when $queryRaw FOR UPDATE returns empty (concurrent delete)", async () => {
    // Only the entry FOR UPDATE read returns empty (row gone by the time the
    // lock fires) — the users guard read must still resolve normally so this
    // test isolates the entry-delete race, not a keyVersion mismatch.
    mockQueryRaw.mockImplementation((tpl: TemplateStringsArray) => {
      const sql = tpl.join("?");
      if (/FROM users/i.test(sql)) {
        return Promise.resolve([{ key_version: 2 }]);
      }
      return Promise.resolve([]);
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
    // update must NOT have been called — the handler must abort before writing
    expect(mockEntryUpdate).not.toHaveBeenCalled();
  });

  it("C1: metadata-only PUT issues no $queryRaw and no History.create", async () => {
    await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: { isFavorite: true },
      }),
      createParams({ id: PW_ID }),
    );

    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(mockHistoryCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when folderId is not owned by the user", async () => {
    mockFolderFindFirst.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: { folderId: "folder-x" },
      }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockEntryUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 when tagIds include a tag not owned by the user", async () => {
    mockTagCount.mockResolvedValue(1); // only 1 of the 2 requested tags is owned
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: { tagIds: ["tag-x", "tag-y"] },
      }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockEntryUpdate).not.toHaveBeenCalled();
  });

  it("C3: succeeds when tagIds contain duplicates but are all owned (count mock returns 1 for [t1,t1])", async () => {
    // tag.count returns distinct row count; t1 is owned once → count=1.
    // Before the fix, ownedCount(1) !== tagIds.length(2) → 400.
    // After the fix, ownedCount(1) !== uniqueTagIds.length(1) → success.
    const ownedTagId = "00000000-0000-4000-a000-000000000001";
    mockTagCount.mockResolvedValue(1);
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: { tagIds: [ownedTagId, ownedTagId] },
      }),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
  });

  it("C3: still rejects when tagIds reference an unowned tag", async () => {
    // t1 owned, t2-unowned → count=1 but uniqueTagIds.length=2 → 400
    const ownedTagId = "00000000-0000-4000-a000-000000000001";
    const unownedTagId = "00000000-0000-4000-a000-000000000002";
    mockTagCount.mockResolvedValue(1);
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: { tagIds: [ownedTagId, unownedTagId] },
      }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockEntryUpdate).not.toHaveBeenCalled();
  });

  it("returns a valid response shape (tagIds, encryptedOverview)", async () => {
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, { body: updateBody }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json).toHaveProperty("tagIds");
    expect(json).toHaveProperty("encryptedOverview");
  });

  // C1/S1: overview-only PUT has no legitimate consumer (all clients derive
  // overview from blob at save time) and is the corruption vector the refine closes.
  it("C1: rejects encryptedOverview without encryptedBlob → 400 VALIDATION_ERROR, no write attempted", async () => {
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: {
          encryptedOverview: { ciphertext: "new-over", iv: "c".repeat(24), authTag: "d".repeat(32) },
        },
      }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockEntryUpdate).not.toHaveBeenCalled();
    expect(mockHistoryCreate).not.toHaveBeenCalled();
  });

  // C1: the extension passkey signature-counter persist sends blob-without-overview
  // (passkey-provider.ts) — must remain a valid, successful shape under the refine.
  it("C1: accepts encryptedBlob without encryptedOverview (passkey counter shape) → 200", async () => {
    const res = await PUT(
      createRequest("PUT", `http://localhost/api/v1/passwords/${PW_ID}`, {
        body: {
          encryptedBlob: { ciphertext: "new-blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
          keyVersion: 2,
        },
      }),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(mockEntryUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/v1/passwords/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateApiKeyOnly.mockResolvedValue({ ok: true, data: validApiKey });
    mockCheck.mockResolvedValue({ allowed: true });
    mockEnforceAccessRestriction.mockResolvedValue(null);
    mockEntryFindUnique.mockResolvedValue({ userId: USER_ID });
  });

  it("returns 401 when API key is missing or invalid", async () => {
    mockValidateApiKeyOnly.mockResolvedValue({ ok: false, error: "INVALID" });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(401);
  });

  it("returns 404 when entry not found", async () => {
    mockEntryFindUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when entry belongs to another user", async () => {
    mockEntryFindUnique.mockResolvedValue({ userId: "other-user" });
    const res = await DELETE(
      createRequest("DELETE", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(404);
  });

  it("soft deletes (trash) by default", async () => {
    mockEntryUpdate.mockResolvedValue({});
    const res = await DELETE(
      createRequest("DELETE", `http://localhost/api/v1/passwords/${PW_ID}`),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockEntryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deletedAt: expect.any(Date) } }),
    );
    expect(mockEntryDelete).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ENTRY_TRASH" }),
    );
  });

  it("rejects ?permanent=true with 403 (no step-up over API key)", async () => {
    const res = await DELETE(
      createRequest("DELETE", `http://localhost/api/v1/passwords/${PW_ID}`, {
        searchParams: { permanent: "true" },
      }),
      createParams({ id: PW_ID }),
    );
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
    // Rejected before any DB access — no delete, no soft-delete, no audit.
    expect(mockEntryDelete).not.toHaveBeenCalled();
    expect(mockEntryUpdate).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
