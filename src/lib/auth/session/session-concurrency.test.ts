import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockLogAudit,
  mockCreateNotification,
  mockInvalidateCachedSessions,
  mockWithBypassRls,
  mockCheckNewDeviceAndNotify,
} = vi.hoisted(() => ({
  mockLogAudit: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockInvalidateCachedSessions: vi.fn().mockResolvedValue(undefined),
  mockWithBypassRls: vi.fn(),
  mockCheckNewDeviceAndNotify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
}));
vi.mock("@/lib/notification", () => ({
  createNotification: mockCreateNotification,
}));
vi.mock("@/lib/auth/session/session-cache-helpers", () => ({
  invalidateCachedSessions: mockInvalidateCachedSessions,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-rls")>()),
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/auth/policy/new-device-detection", () => ({
  checkNewDeviceAndNotify: mockCheckNewDeviceAndNotify,
}));
// H4: deterministic hashSessionToken so assertions can predict the stored digest.
vi.mock("@/lib/auth/session/session-cache", () => ({
  hashSessionToken: (token: string) => `hashed:${token}`,
}));

import {
  createCappedSession,
  createSessionUnderConcurrencyCap,
  reportSessionEviction,
} from "./session-concurrency";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";

const LIVE = new Date(Date.now() + 3_600_000);

function makeTx() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    tenant: { findUnique: vi.fn() },
    session: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn(),
    },
  };
}

describe("createSessionUnderConcurrencyCap", () => {
  const expires = new Date("2025-06-01T00:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("takes the per-user advisory lock before reading the cap", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: null });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });

    await createSessionUnderConcurrencyCap(tx as never, {
      userId: "u-1",
      tenantId: "tenant-1",
      sessionToken: "raw-token",
      expires,
      ip: null,
      userAgent: null,
      provider: null,
    });

    expect(
      tx.$executeRaw.mock.calls.some((c) => String(c[0]).includes("pg_advisory_xact_lock")),
    ).toBe(true);
  });

  it("deletes the replaced session by digest after the lock and before the cap is read", async () => {
    const tx = makeTx();
    tx.session.findUnique.mockResolvedValue({ userId: "u-2", expires: LIVE });
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: 2 });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });

    await createSessionUnderConcurrencyCap(tx as never, {
      userId: "u-1",
      tenantId: "tenant-1",
      sessionToken: "raw-token",
      expires,
      ip: null,
      userAgent: null,
      provider: null,
      replacesSessionTokens: ["prev-token"],
    });

    expect(tx.session.deleteMany).toHaveBeenCalledWith({
      where: { sessionToken: "hashed:prev-token" },
    });
    const [lock] = tx.$executeRaw.mock.invocationCallOrder;
    const [replacedDelete] = tx.session.deleteMany.mock.invocationCallOrder;
    const [capRead] = tx.tenant.findUnique.mock.invocationCallOrder;
    const [count] = tx.session.findMany.mock.invocationCallOrder;
    expect(lock).toBeLessThan(replacedDelete);
    expect(replacedDelete).toBeLessThan(capRead);
    expect(replacedDelete).toBeLessThan(count);
  });

  // A CHIPS browser holding both variants of the session cookie names two
  // sessions; the sign-in response deletes both cookies, so both go.
  it("deletes every replaced session before the cap is read", async () => {
    const tx = makeTx();
    tx.session.findUnique.mockResolvedValue({ userId: "u-1", expires: LIVE });
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: 2 });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });

    await createSessionUnderConcurrencyCap(tx as never, {
      userId: "u-1",
      tenantId: "tenant-1",
      sessionToken: "raw-token",
      expires,
      ip: null,
      userAgent: null,
      provider: null,
      replacesSessionTokens: ["prev-a", "prev-b"],
    });

    expect(tx.session.deleteMany.mock.calls.map(([arg]) => arg)).toEqual([
      { where: { sessionToken: "hashed:prev-a" } },
      { where: { sessionToken: "hashed:prev-b" } },
    ]);
    const lastReplacedDelete = Math.max(...tx.session.deleteMany.mock.invocationCallOrder);
    const [count] = tx.session.findMany.mock.invocationCallOrder;
    expect(lastReplacedDelete).toBeLessThan(count);
  });

  it("fails closed when the tenant row is missing", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue(null);

    await expect(
      createSessionUnderConcurrencyCap(tx as never, {
        userId: "u-1",
        tenantId: "tenant-gone",
        sessionToken: "raw-token",
        expires,
        ip: null,
        userAgent: null,
        provider: null,
      }),
    ).rejects.toThrow(/tenant-gone not found/);

    expect(tx.session.create).not.toHaveBeenCalled();
  });

  // F3-adj-1: Session.id is uuid(4) (random), so ordering eviction by id alone
  // is arbitrary. The helper orders by createdAt first, with id only as the
  // tie-break for a total order (R57) — pinned directly here because none of
  // the adapter's mocks (which return a canned array regardless of the
  // orderBy argument) can catch a regression back to `{ id: "asc" }`.
  it("orders the active-session read by createdAt asc, id asc (F3-adj-1)", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: 2 });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });

    await createSessionUnderConcurrencyCap(tx as never, {
      userId: "u-1",
      tenantId: "tenant-1",
      sessionToken: "raw-token",
      expires,
      ip: null,
      userAgent: null,
      provider: null,
    });

    expect(tx.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
  });

  it("does not evict and returns eviction: null when under the cap", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: 3 });
    tx.session.findMany.mockResolvedValue([{ id: "s1", sessionToken: "tok-s1", ipAddress: null, userAgent: null }]);
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });

    const result = await createSessionUnderConcurrencyCap(tx as never, {
      userId: "u-1",
      tenantId: "tenant-1",
      sessionToken: "raw-token",
      expires,
      ip: null,
      userAgent: null,
      provider: null,
    });

    expect(tx.session.deleteMany).not.toHaveBeenCalled();
    expect(result.eviction).toBeNull();
  });

  it("evicts the oldest session and returns it in eviction.evicted when at the cap", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: 1 });
    tx.session.findMany.mockResolvedValue([
      { id: "old-s1", sessionToken: "old-tok-1", ipAddress: "1.1.1.1", userAgent: "old-1" },
    ]);
    tx.session.deleteMany.mockResolvedValue({ count: 1 });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });

    const result = await createSessionUnderConcurrencyCap(tx as never, {
      userId: "u-1",
      tenantId: "tenant-1",
      sessionToken: "raw-token",
      expires,
      ip: null,
      userAgent: null,
      provider: null,
    });

    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old-s1"] } } });
    expect(result.eviction).toEqual({
      tenantId: "tenant-1",
      maxSessions: 1,
      evicted: [{ id: "old-s1", sessionToken: "old-tok-1", ipAddress: "1.1.1.1", userAgent: "old-1" }],
    });
  });

  it("hashes the raw sessionToken before writing it (H4) and passes through the passkey fields", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: null });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });

    await createSessionUnderConcurrencyCap(tx as never, {
      userId: "u-1",
      tenantId: "tenant-1",
      sessionToken: "raw-token",
      expires,
      ip: "10.0.0.1",
      userAgent: "ua",
      provider: "webauthn",
      passkeyVerifiedAt: new Date("2025-01-01T00:00:00Z"),
      authCredentialId: "cred-1",
    });

    expect(tx.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionToken: "hashed:raw-token",
        userId: "u-1",
        tenantId: "tenant-1",
        provider: "webauthn",
        passkeyVerifiedAt: new Date("2025-01-01T00:00:00Z"),
        authCredentialId: "cred-1",
      }),
      select: { userId: true, expires: true },
    });
  });
});

describe("reportSessionEviction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates the cache, writes one SESSION_EVICTED audit entry per evicted session, and notifies the user", async () => {
    const eviction = {
      tenantId: "tenant-1",
      maxSessions: 2,
      evicted: [
        { id: "s1", sessionToken: "tok-s1", ipAddress: "1.1.1.1", userAgent: "ua1" },
        { id: "s2", sessionToken: "tok-s2", ipAddress: "2.2.2.2", userAgent: "ua2" },
      ],
    };

    await reportSessionEviction(eviction, { userId: "u-1", ip: "9.9.9.9", userAgent: "new-device" });

    expect(mockInvalidateCachedSessions).toHaveBeenCalledWith(["tok-s1", "tok-s2"]);
    expect(mockLogAudit).toHaveBeenCalledTimes(2);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SESSION_EVICTED",
        userId: "u-1",
        tenantId: "tenant-1",
        targetId: "s1",
        metadata: expect.objectContaining({ reason: "concurrent_session_limit", maxConcurrentSessions: 2 }),
      }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-1", tenantId: "tenant-1", type: "SESSION_EVICTED" }),
    );
  });
});

describe("createCappedSession", () => {
  const expires = new Date("2025-06-01T00:00:00Z");
  const input = {
    userId: "u-1",
    tenantId: "tenant-1",
    sessionToken: "raw-token",
    expires,
    ip: "9.9.9.9",
    userAgent: "new-device",
    acceptLanguage: "ja",
    provider: "webauthn",
  };

  // Runs the callback against `tx` and records whether the bypass
  // transaction is still open when each post-commit side effect fires.
  function openTxAround(tx: ReturnType<typeof makeTx>) {
    const state = { open: false };
    mockWithBypassRls.mockImplementation(async (_client: unknown, fn: (t: unknown) => unknown) => {
      state.open = true;
      try {
        return await fn(tx);
      } finally {
        state.open = false;
      }
    });
    return state;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens its own AUTH_FLOW bypass and checks the new device with the RAW token after commit", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: null });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });
    const state = openTxAround(tx);
    let checkedWhileOpen: boolean | null = null;
    mockCheckNewDeviceAndNotify.mockImplementation(async () => {
      checkedWhileOpen = state.open;
    });

    const session = await createCappedSession(input);

    expect(session).toEqual({ userId: "u-1", expires });
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      BYPASS_GRANT.AUTH_SESSION_CAPPING,
    );
    expect(mockCheckNewDeviceAndNotify).toHaveBeenCalledWith("u-1", {
      ip: "9.9.9.9",
      userAgent: "new-device",
      acceptLanguage: "ja",
      currentSessionToken: "raw-token",
    });
    expect(checkedWhileOpen).toBe(false);
    // No eviction happened, so nothing is reported.
    expect(mockInvalidateCachedSessions).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("reports a cap eviction only after the creating transaction has closed", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: 1 });
    tx.session.findMany.mockResolvedValue([
      { id: "old-s1", sessionToken: "old-digest", ipAddress: null, userAgent: null },
    ]);
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });
    const state = openTxAround(tx);
    let reportedWhileOpen: boolean | null = null;
    mockInvalidateCachedSessions.mockImplementation(async () => {
      reportedWhileOpen = state.open;
    });

    await createCappedSession(input);

    expect(mockInvalidateCachedSessions).toHaveBeenCalledWith(["old-digest"]);
    expect(reportedWhileOpen).toBe(false);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SESSION_EVICTED", targetId: "old-s1", userId: "u-1" }),
    );
  });

  it("deletes the replaced session in the creating transaction and evicts its cache entry after commit", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: null });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });
    tx.session.findUnique.mockResolvedValue({ userId: "u-2", expires: LIVE });
    const state = openTxAround(tx);
    let deletedWhileOpen: boolean | null = null;
    tx.session.deleteMany.mockImplementation(async () => {
      deletedWhileOpen = state.open;
      return { count: 1 };
    });
    let evictedWhileOpen: boolean | null = null;
    mockInvalidateCachedSessions.mockImplementation(async () => {
      evictedWhileOpen = state.open;
    });

    await createCappedSession({ ...input, replacesSessionTokens: ["prev-token"] });

    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(deletedWhileOpen).toBe(true);
    expect(mockInvalidateCachedSessions).toHaveBeenCalledWith(["hashed:prev-token"]);
    expect(evictedWhileOpen).toBe(false);
  });

  it("evicts the cache entry of every replaced session", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: null });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });
    tx.session.findUnique.mockResolvedValue({ userId: "u-1", expires: LIVE });
    openTxAround(tx);

    await createCappedSession({ ...input, replacesSessionTokens: ["prev-a", "prev-b"] });

    expect(mockInvalidateCachedSessions).toHaveBeenCalledWith(["hashed:prev-a", "hashed:prev-b"]);
  });

  it("keeps the replaced session's cache entry when the creating transaction fails", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: null });
    tx.session.create.mockRejectedValue(new Error("db down"));
    tx.session.findUnique.mockResolvedValue({ userId: "u-1", expires: LIVE });
    openTxAround(tx);

    await expect(
      createCappedSession({ ...input, replacesSessionTokens: ["prev-token"] }),
    ).rejects.toThrow("db down");

    expect(mockInvalidateCachedSessions).not.toHaveBeenCalled();
  });

  // The browser presented this user's own session, so it is a known device;
  // the deleted row would otherwise be missing from the new-device check.
  it("skips the new-device check when the replaced session was the user's own", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: null });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });
    tx.session.findUnique.mockResolvedValue({ userId: "u-1", expires: LIVE });
    openTxAround(tx);

    await createCappedSession({ ...input, replacesSessionTokens: ["prev-token"] });

    expect(mockCheckNewDeviceAndNotify).not.toHaveBeenCalled();
  });

  it("still checks for a new device when the replaced own session had expired", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: null });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });
    tx.session.findUnique.mockResolvedValue({ userId: "u-1", expires: new Date(Date.now() - 60_000) });
    openTxAround(tx);

    await createCappedSession({ ...input, replacesSessionTokens: ["prev-token"] });

    expect(tx.session.deleteMany).toHaveBeenCalled();
    expect(mockCheckNewDeviceAndNotify).toHaveBeenCalledTimes(1);
  });

  it("still checks for a new device when the replaced session was another user's", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: null });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });
    tx.session.findUnique.mockResolvedValue({ userId: "u-2", expires: LIVE });
    openTxAround(tx);

    await createCappedSession({ ...input, replacesSessionTokens: ["prev-token"] });

    expect(mockCheckNewDeviceAndNotify).toHaveBeenCalledTimes(1);
  });

  it("still checks for a new device when the replaced session is already gone", async () => {
    const tx = makeTx();
    tx.tenant.findUnique.mockResolvedValue({ maxConcurrentSessions: null });
    tx.session.create.mockResolvedValue({ userId: "u-1", expires });
    openTxAround(tx);

    await createCappedSession({ ...input, replacesSessionTokens: ["prev-token"] });

    expect(tx.session.deleteMany).not.toHaveBeenCalled();
    expect(mockCheckNewDeviceAndNotify).toHaveBeenCalledTimes(1);
  });
});
