import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AUDIT_SCOPE, ACTOR_TYPE, AUDIT_ACTION, AUDIT_METADATA_KEY } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID, SYSTEM_TENANT_ID } from "@/lib/constants/app";
import type { PrismaClient } from "@prisma/client";

// ─── Shared mock handles ──────────────────────────────────────────────────────

const {
  mockExecuteRaw,
  mockExecuteRawUnsafe,
  mockTransaction,
  mockDisconnect,
  MockPrismaClient,
  MockPrismaPg,
  MockPool,
  mockPoolEnd,
  mockLoggerInfo,
  mockLoggerError,
} = vi.hoisted(() => {
  const mockExecuteRaw = vi.fn().mockResolvedValue(undefined);
  const mockExecuteRawUnsafe = vi.fn().mockResolvedValue(5);
  const mockDisconnect = vi.fn().mockResolvedValue(undefined);

  const mockTransaction = vi.fn();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function MockPrismaClient(this: any, _opts: unknown) {
    this.$transaction = mockTransaction;
    this.$executeRaw = mockExecuteRaw;
    this.$executeRawUnsafe = mockExecuteRawUnsafe;
    this.$disconnect = mockDisconnect;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function MockPrismaPg(this: any, _pool: unknown) {
    // no-op adapter
  }

  const mockPoolOn = vi.fn();
  const mockPoolEnd = vi.fn().mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function MockPool(this: any, _opts: unknown) {
    this.on = mockPoolOn;
    this.end = mockPoolEnd;
  }

  const mockLoggerInfo = vi.fn();
  const mockLoggerError = vi.fn();

  return {
    mockExecuteRaw,
    mockExecuteRawUnsafe,
    mockTransaction,
    mockDisconnect,
    MockPrismaClient,
    MockPrismaPg,
    MockPool,
    mockPoolOn,
    mockPoolEnd,
    mockLoggerInfo,
    mockLoggerError,
  };
});

vi.mock("@prisma/client", () => ({
  PrismaClient: MockPrismaClient,
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: MockPrismaPg,
}));

vi.mock("pg", () => ({
  default: { Pool: MockPool },
}));

vi.mock("@/lib/logger", () => ({
  getLogger: function () {
    return {
      info: mockLoggerInfo,
      error: mockLoggerError,
    };
  },
}));

import { sweepOnce, createWorker } from "./dcr-cleanup-worker";

const TEST_DB_URL = "postgresql://test:test@localhost:5432/test";

const DEFAULT_OPTS = {
  intervalMs: 3_600_000,
  emitHeartbeatAudit: false,
};

// ─── helpers ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxClient = any;

/**
 * Build a mock tx client where $queryRaw answers bypass_rls + tenant existence
 * in the expected call order, and returns a configurable auditOutboxCreate mock.
 */
function makeMockTxClient(opts: {
  executeRawUnsafeReturn?: number;
  auditOutboxCreate?: ReturnType<typeof vi.fn>;
} = {}): TxClient {
  let queryRawCallCount = 0;
  return {
    $executeRaw: mockExecuteRaw,
    $executeRawUnsafe: opts.executeRawUnsafeReturn !== undefined
      ? vi.fn().mockResolvedValue(opts.executeRawUnsafeReturn)
      : mockExecuteRawUnsafe,
    $queryRaw: vi.fn(async () => {
      queryRawCallCount++;
      if (queryRawCallCount === 1) {
        return [{ bypass_rls: "on", tenant_id: "" }];
      }
      return [{ ok: true }];
    }),
    auditOutbox: {
      create: opts.auditOutboxCreate ?? vi.fn().mockResolvedValue({}),
    },
  };
}

/**
 * Create a minimal fake PrismaClient that delegates to our mock $transaction.
 * Avoids instantiating MockPrismaClient directly (typing issues with constructor function mocks).
 */
function makeFakePrismaClient(): PrismaClient {
  return {
    $transaction: mockTransaction,
    $disconnect: mockDisconnect,
  } as unknown as PrismaClient;
}

function resetMocks() {
  vi.clearAllMocks();
  mockExecuteRaw.mockResolvedValue(undefined);
  mockExecuteRawUnsafe.mockResolvedValue(5);
  mockDisconnect.mockResolvedValue(undefined);
  mockPoolEnd.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (fn: (tx: TxClient) => Promise<unknown>) => {
    return fn(makeMockTxClient());
  });
}

// ─── sweepOnce — core behaviour ───────────────────────────────────────────────

describe("sweepOnce", () => {
  beforeEach(resetMocks);

  it("returns the deleted count from $executeRawUnsafe", async () => {
    mockTransaction.mockImplementation(async (fn: (tx: TxClient) => Promise<unknown>) => {
      return fn(makeMockTxClient({ executeRawUnsafeReturn: 7 }));
    });
    const result = await sweepOnce(makeFakePrismaClient(), 1000, DEFAULT_OPTS);
    expect(result).toBe(7);
  });

  it("calls $executeRawUnsafe with a DELETE containing the correct WHERE clause", async () => {
    let capturedSql = "";
    let capturedBatchSize: unknown = null;

    mockTransaction.mockImplementation(async (fn: (tx: TxClient) => Promise<unknown>) => {
      let queryRawCallCount = 0;
      return fn({
        $executeRaw: mockExecuteRaw,
        $executeRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
          capturedSql = sql;
          capturedBatchSize = args[0];
          return 3;
        }),
        $queryRaw: vi.fn(async () => {
          queryRawCallCount++;
          if (queryRawCallCount === 1) return [{ bypass_rls: "on", tenant_id: "" }];
          return [{ ok: true }];
        }),
        auditOutbox: { create: vi.fn().mockResolvedValue({}) },
      });
    });

    await sweepOnce(makeFakePrismaClient(), 500, DEFAULT_OPTS);

    expect(capturedSql).toContain("is_dcr = true AND tenant_id IS NULL AND dcr_expires_at < now()");
    expect(capturedBatchSize).toBe(500);
  });

  it("emits audit via auditOutbox.create when purged > 0", async () => {
    const auditOutboxCreate = vi.fn().mockResolvedValue({});
    mockTransaction.mockImplementation(async (fn: (tx: TxClient) => Promise<unknown>) => {
      return fn(makeMockTxClient({ executeRawUnsafeReturn: 3, auditOutboxCreate }));
    });

    await sweepOnce(makeFakePrismaClient(), 1000, DEFAULT_OPTS);

    expect(auditOutboxCreate).toHaveBeenCalledOnce();
    const createCall = auditOutboxCreate.mock.calls[0][0] as {
      data: { tenantId: string; payload: Record<string, unknown> };
    };
    const { tenantId, payload } = createCall.data;

    expect(tenantId).toBe(SYSTEM_TENANT_ID);
    expect(payload.scope).toBe(AUDIT_SCOPE.TENANT);
    expect(payload.action).toBe(AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP);
    expect(payload.userId).toBe(SYSTEM_ACTOR_ID);
    expect(payload.actorType).toBe(ACTOR_TYPE.SYSTEM);
    expect(payload.serviceAccountId).toBeNull();
    expect(payload.teamId).toBeNull();
    expect(payload.targetType).toBeNull();
    expect(payload.targetId).toBeNull();
    expect(payload.ip).toBeNull();
    expect(payload.userAgent).toBe("dcr-cleanup-worker");

    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata[AUDIT_METADATA_KEY.PURGED_COUNT]).toBe(3);
    expect(metadata.triggeredBy).toBe("dcr-cleanup-worker");
    expect(metadata.sweepIntervalMs).toBe(DEFAULT_OPTS.intervalMs);

    // Assert ABSENCE of legacy/unrelated fields
    expect(metadata.operatorId).toBeUndefined();
    expect(metadata.tokenId).toBeUndefined();
    expect(metadata.tokenSubjectUserId).toBeUndefined();
    expect(metadata.systemWide).toBeUndefined();
  });

  it("does NOT emit audit when purged === 0 AND emitHeartbeatAudit === false", async () => {
    const auditOutboxCreate = vi.fn().mockResolvedValue({});
    mockTransaction.mockImplementation(async (fn: (tx: TxClient) => Promise<unknown>) => {
      return fn(makeMockTxClient({ executeRawUnsafeReturn: 0, auditOutboxCreate }));
    });

    await sweepOnce(makeFakePrismaClient(), 1000, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: false,
    });

    expect(auditOutboxCreate).not.toHaveBeenCalled();
  });

  it("emits audit when purged === 0 AND emitHeartbeatAudit === true", async () => {
    const auditOutboxCreate = vi.fn().mockResolvedValue({});
    mockTransaction.mockImplementation(async (fn: (tx: TxClient) => Promise<unknown>) => {
      return fn(makeMockTxClient({ executeRawUnsafeReturn: 0, auditOutboxCreate }));
    });

    await sweepOnce(makeFakePrismaClient(), 1000, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: true,
    });

    expect(auditOutboxCreate).toHaveBeenCalledOnce();
    const createCall = auditOutboxCreate.mock.calls[0][0] as {
      data: { tenantId: string; payload: Record<string, unknown> };
    };
    const metadata = createCall.data.payload.metadata as Record<string, unknown>;
    expect(metadata[AUDIT_METADATA_KEY.PURGED_COUNT]).toBe(0);
  });
});

// ─── loop — AbortSignal handling ──────────────────────────────────────────────

describe("loop responds to AbortSignal", () => {
  beforeEach(resetMocks);
  afterEach(() => vi.useRealTimers());

  it("resolves start() when stop() is called after the first sweep", async () => {
    vi.useFakeTimers();

    // Sweep returns 0 (no audit emission), so no auditOutbox writes.
    mockTransaction.mockImplementation(async (fn: (tx: TxClient) => Promise<unknown>) => {
      return fn(makeMockTxClient({ executeRawUnsafeReturn: 0 }));
    });

    const worker = createWorker({
      databaseUrl: TEST_DB_URL,
      intervalMs: 60_000,
      batchSize: 100,
      emitHeartbeatAudit: false,
    });

    const startPromise = worker.start();

    // Advance past the first sweep and into the sleep.
    // The first sweep completes synchronously in our mock; then the loop
    // calls setTimeoutPromise(60_000). We stop the worker so the AbortController
    // aborts the sleep and the loop exits.
    await vi.runAllTimersAsync();
    await worker.stop();

    await expect(startPromise).resolves.toBeUndefined();
  });
});
