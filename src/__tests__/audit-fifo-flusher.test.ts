import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_OUTBOX } from "@/lib/constants/audit";

const {
  mockEnqueueAudit,
  mockDeadLetterWarn,
  mockUserFindUnique,
  mockUserFindMany,
  mockTeamFindUnique,
  mockTeamFindMany,
  mockDrainBuffer,
} = vi.hoisted(() => ({
  mockEnqueueAudit: vi.fn().mockResolvedValue(undefined),
  mockDeadLetterWarn: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserFindMany: vi.fn(),
  mockTeamFindUnique: vi.fn(),
  mockTeamFindMany: vi.fn(),
  mockDrainBuffer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit-outbox", () => ({
  enqueueAudit: mockEnqueueAudit,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    team: { findUnique: mockTeamFindUnique, findMany: mockTeamFindMany },
    user: { findUnique: mockUserFindUnique, findMany: mockUserFindMany },
  },
}));

vi.mock("@/lib/audit-retry", () => ({
  enqueue: vi.fn(),
  drainBuffer: mockDrainBuffer,
  bufferSize: () => 0,
}));

vi.mock("@/lib/audit-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit-logger")>();
  return {
    ...actual,
    auditLogger: { info: vi.fn(), enabled: false },
    deadLetterLogger: { warn: mockDeadLetterWarn },
  };
});

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  // Override tenantRlsStorage.run to be a synchronous passthrough (no AsyncLocalStorage context)
  tenantRlsStorage: {
    run: (_store: unknown, fn: () => unknown) => fn(),
  },
  getTenantRlsContext: () => null,
  // withBypassRls must call the callback directly so resolveTenantId works in tests
  withBypassRls: (_prisma: unknown, fn: () => unknown, _purpose: unknown) => fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { logAudit, _getFifoSize, _flushFifoForTest, _clearFifoForTest } from "@/lib/audit";

describe("FIFO flusher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearFifoForTest();
    mockEnqueueAudit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // nothing to restore — no fake timers used
  });

  it("logAudit pushes entry to FIFO (visible via _getFifoSize)", () => {
    // Capture size before and after
    const before = _getFifoSize();
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "00000000-0000-4000-8000-000000000001",
    });
    expect(_getFifoSize()).toBe(before + 1);
  });

  it("_flushFifoForTest drains FIFO and calls enqueueAudit", async () => {
    mockUserFindMany.mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000001", tenantId: "tenant-1" }]);

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "00000000-0000-4000-8000-000000000001",
    });

    await _flushFifoForTest();

    expect(mockEnqueueAudit).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: "00000000-0000-4000-8000-000000000001",
        actorType: "HUMAN",
      }),
    );
    // FIFO should be drained
    expect(_getFifoSize()).toBe(0);
  });

  it("flusher resolves tenantId from userId when not provided", async () => {
    mockUserFindMany.mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000042", tenantId: "tenant-from-user" }]);

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: "00000000-0000-4000-8000-000000000042",
      // no tenantId supplied
    });

    await _flushFifoForTest();

    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["00000000-0000-4000-8000-000000000042"] } } }),
    );
    expect(mockEnqueueAudit).toHaveBeenCalledWith(
      "tenant-from-user",
      expect.objectContaining({ userId: "00000000-0000-4000-8000-000000000042" }),
    );
  });

  it("flusher resolves tenantId from teamId when provided", async () => {
    mockTeamFindMany.mockResolvedValue([{ id: "team-99", tenantId: "tenant-from-team" }]);

    logAudit({
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: "00000000-0000-4000-8000-000000000001",
      teamId: "team-99",
      // no tenantId supplied
    });

    await _flushFifoForTest();

    expect(mockTeamFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["team-99"] } } }),
    );
    expect(mockEnqueueAudit).toHaveBeenCalledWith(
      "tenant-from-team",
      expect.objectContaining({ teamId: "team-99" }),
    );
  });

  it("dead-letters entry when tenantId cannot be resolved", async () => {
    mockUserFindMany.mockResolvedValue([]);
    mockTeamFindMany.mockResolvedValue([]);

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "00000000-0000-4000-8000-0000000000ff",
    });

    await _flushFifoForTest();

    expect(mockEnqueueAudit).not.toHaveBeenCalled();
    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "tenant_not_found" }),
      "audit.dead_letter",
    );
  });

  it("per-entry failure isolation — second entry processed even if first throws", async () => {
    mockUserFindMany.mockResolvedValue([
      { id: "00000000-0000-4000-8000-00000000000a", tenantId: "tenant-1" },
      { id: "00000000-0000-4000-8000-00000000000b", tenantId: "tenant-1" },
    ]);
    mockEnqueueAudit
      .mockRejectedValueOnce(new Error("outbox error"))
      .mockResolvedValue(undefined);

    logAudit({ scope: AUDIT_SCOPE.PERSONAL, action: AUDIT_ACTION.AUTH_LOGIN, userId: "00000000-0000-4000-8000-00000000000a" });
    logAudit({ scope: AUDIT_SCOPE.PERSONAL, action: AUDIT_ACTION.AUTH_LOGOUT, userId: "00000000-0000-4000-8000-00000000000b" });

    await _flushFifoForTest();

    // Both were attempted: first failed (re-queued), second succeeded
    expect(mockEnqueueAudit).toHaveBeenCalledTimes(2);
    const actions = mockEnqueueAudit.mock.calls.map(
      (call: [string, { action: string }]) => call[1].action,
    );
    expect(actions).toContain(AUDIT_ACTION.AUTH_LOGOUT);
  });

  it("dead-letters entry after FIFO_MAX_RETRIES failures", async () => {
    mockUserFindMany.mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000099", tenantId: "tenant-1" }]);
    mockEnqueueAudit.mockRejectedValue(new Error("persistent outbox error"));

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGIN,
      userId: "00000000-0000-4000-8000-000000000099",
    });

    // Flush FIFO_MAX_RETRIES+1 times to exhaust retries
    for (let i = 0; i <= AUDIT_OUTBOX.FIFO_MAX_RETRIES; i++) {
      await _flushFifoForTest();
    }

    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "max_retries_exceeded" }),
      "audit.dead_letter",
    );
  });

  it("overflow drops oldest entry to dead-letter when FIFO is full", () => {
    // Push FIFO_MAX_SIZE+1 entries — oldest should be dead-lettered
    for (let i = 0; i <= AUDIT_OUTBOX.FIFO_MAX_SIZE; i++) {
      logAudit({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.AUTH_LOGIN,
        userId: "00000000-0000-4000-8000-000000000001",
        tenantId: "tenant-1",
      });
    }

    // deadLetterLogger.warn should have been called for the dropped entry
    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "fifo_overflow" }),
      "audit.dead_letter",
    );
  });

  it("SIGTERM handler triggers flush — enqueueAudit called", async () => {
    mockUserFindMany.mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000001", tenantId: "tenant-1" }]);

    // Drain any FIFO entries left over from previous tests (overflow test leaves FIFO_MAX_SIZE entries)
    mockEnqueueAudit.mockResolvedValue(undefined);
    while (_getFifoSize() > 0) {
      await _flushFifoForTest();
    }
    vi.clearAllMocks();
    mockUserFindMany.mockResolvedValue([{ id: "00000000-0000-4000-8000-0000000000cc", tenantId: "tenant-1" }]);
    mockEnqueueAudit.mockResolvedValue(undefined);

    // Prevent process.exit(0) from actually terminating the test runner
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number | string | null) => {
      // no-op: prevent actual exit without throwing (to avoid unhandled rejection in .finally)
      return undefined as never;
    });

    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.AUTH_LOGOUT,
      userId: "00000000-0000-4000-8000-0000000000cc",
    });

    // Emit SIGTERM to trigger the handler registered in audit.ts
    // The handler calls flushWithTimeout which calls flushFifo, then process.exit(0)
    process.emit("SIGTERM");

    // Allow the async flush to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockEnqueueAudit).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({
        action: AUDIT_ACTION.AUTH_LOGOUT,
        userId: "00000000-0000-4000-8000-0000000000cc",
      }),
    );

    exitSpy.mockRestore();
  });
});
