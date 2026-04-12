import { describe, it, expect, vi, beforeEach } from "vitest";
import { AUDIT_SCOPE, ACTOR_TYPE, AUDIT_ACTION, OUTBOX_BYPASS_AUDIT_ACTIONS } from "@/lib/constants/audit";

// ─── Shared mock handles ──────────────────────────────────────────────────────

const {
  mockExecuteRaw,
  mockQueryRawUnsafe,
  mockExecuteRawUnsafe,
  mockTransaction,
  mockDisconnect,
  MockPrismaClient,
  MockPrismaPg,
  MockPool,
  mockPoolEnd,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
  mockDeadLetterWarn,
  mockComputeBackoffMs,
  mockWithFullJitter,
  mockDispatchWebhook,
  mockDispatchTenantWebhook,
} = vi.hoisted(() => {
  const mockExecuteRaw = vi.fn().mockResolvedValue(undefined);
  const mockQueryRawUnsafe = vi.fn().mockResolvedValue([]);
  const mockExecuteRawUnsafe = vi.fn().mockResolvedValue(undefined);
  const mockDisconnect = vi.fn().mockResolvedValue(undefined);

  // tx object passed inside $transaction callback
  const txClient = {
    $executeRaw: mockExecuteRaw,
    $queryRawUnsafe: mockQueryRawUnsafe,
    $executeRawUnsafe: mockExecuteRawUnsafe,
  };

  const mockTransaction = vi.fn(
    async function (fn: (tx: typeof txClient) => Promise<unknown>) {
      return fn(txClient);
    },
  );

  // Use function keyword so vitest accepts these as constructors
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function MockPrismaClient(this: any, _opts: unknown) {
    this.$transaction = mockTransaction;
    this.$executeRaw = mockExecuteRaw;
    this.$queryRawUnsafe = mockQueryRawUnsafe;
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
  const mockLoggerWarn = vi.fn();
  const mockLoggerError = vi.fn();

  const mockDeadLetterWarn = vi.fn();

  const mockComputeBackoffMs = vi.fn().mockReturnValue(1000);
  const mockWithFullJitter = vi.fn().mockReturnValue(1000);

  const mockDispatchWebhook = vi.fn();
  const mockDispatchTenantWebhook = vi.fn();

  return {
    mockExecuteRaw,
    mockQueryRawUnsafe,
    mockExecuteRawUnsafe,
    mockTransaction,
    mockDisconnect,
    MockPrismaClient,
    MockPrismaPg,
    MockPool,
    mockPoolOn,
    mockPoolEnd,
    mockLoggerInfo,
    mockLoggerWarn,
    mockLoggerError,
    mockDeadLetterWarn,
    mockComputeBackoffMs,
    mockWithFullJitter,
    mockDispatchWebhook,
    mockDispatchTenantWebhook,
  };
});

vi.mock("@prisma/client", () => ({
  PrismaClient: MockPrismaClient,
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: MockPrismaPg,
}));

vi.mock("pg", () => ({
  // The worker does `import pg from "pg"` then `new pg.Pool(...)`,
  // so the default export must have Pool as a constructor on it.
  default: { Pool: MockPool },
}));

vi.mock("@/lib/logger", () => ({
  getLogger: function () {
    return {
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
    };
  },
}));

vi.mock("@/lib/audit-logger", () => ({
  deadLetterLogger: { warn: mockDeadLetterWarn },
  auditLogger: { info: vi.fn(), enabled: false },
}));

vi.mock("@/lib/backoff", () => ({
  computeBackoffMs: mockComputeBackoffMs,
  withFullJitter: mockWithFullJitter,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhook: mockDispatchWebhook,
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));

import { createWorker } from "./audit-outbox-worker";
import { NIL_UUID } from "@/lib/constants/app";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";

// ─── Test data helpers ────────────────────────────────────────────────────────

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const ROW_ID = "00000000-0000-4000-8000-000000000003";
const TEAM_ID = "00000000-0000-4000-8000-000000000004";

interface OutboxRow {
  id: string;
  tenant_id: string;
  payload: unknown;
  status: string;
  attempt_count: number;
  max_attempts: number;
  created_at: Date;
  next_retry_at: Date;
  processing_started_at: Date | null;
  sent_at: Date | null;
  last_error: string | null;
}

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: ROW_ID,
    tenant_id: TENANT_ID,
    payload: {
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_CREATE,
      userId: USER_ID,
      actorType: ACTOR_TYPE.HUMAN,
      serviceAccountId: null,
      teamId: null,
      targetType: null,
      targetId: null,
      metadata: null,
      ip: null,
      userAgent: null,
    },
    status: "PENDING",
    attempt_count: 0,
    max_attempts: 8,
    created_at: new Date("2026-01-01T00:00:00Z"),
    next_retry_at: new Date("2026-01-01T00:00:00Z"),
    processing_started_at: null,
    sent_at: null,
    last_error: null,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxFn = (tx: any) => Promise<unknown>;

/**
 * Build a $transaction implementation that stops the worker after the first
 * claimBatch round-trip. Returns the worker's stop() handle so tests that
 * override $transaction can call it themselves.
 *
 * claimBatch is the only transaction that calls $queryRawUnsafe inside the callback.
 * deliverRow and recordError only call $executeRawUnsafe.
 * We detect the second claimBatch by tracking whether a previous tx already used
 * $queryRawUnsafe.
 */
function makeOneShotTxImpl(stopFn: () => void): (fn: TxFn) => Promise<unknown> {
  let firstClaimDone = false;
  return async function (fn: TxFn) {
    const txQueryRaw = vi.fn(async (...args: unknown[]) => {
      if (!firstClaimDone) {
        return mockQueryRawUnsafe(...args);
      }
      stopFn();
      return [];
    });

    const result = await fn({
      $executeRaw: mockExecuteRaw,
      $queryRawUnsafe: txQueryRaw,
      $executeRawUnsafe: mockExecuteRawUnsafe,
    });

    if (txQueryRaw.mock.calls.length > 0) {
      firstClaimDone = true;
    }
    return result;
  };
}

// Helper to reset mock state between tests while keeping implementations
function resetMocks() {
  vi.clearAllMocks();
  mockExecuteRaw.mockResolvedValue(undefined);
  mockQueryRawUnsafe.mockResolvedValue([]);
  mockExecuteRawUnsafe.mockResolvedValue(undefined);
  mockDisconnect.mockResolvedValue(undefined);
  mockPoolEnd.mockResolvedValue(undefined);
  // Default: pass-through — tests that need stop-after-one-batch use runWorkerOnce()
  mockTransaction.mockImplementation(async function (fn: TxFn) {
    return fn({
      $executeRaw: mockExecuteRaw,
      $queryRawUnsafe: mockQueryRawUnsafe,
      $executeRawUnsafe: mockExecuteRawUnsafe,
    });
  });
  mockComputeBackoffMs.mockReturnValue(1000);
  mockWithFullJitter.mockReturnValue(1000);
}

const TEST_DB_URL = "postgresql://test:test@localhost:5432/test";

/**
 * Run the worker for one loop iteration then stop it.
 *
 * Installs a one-shot $transaction implementation that stops the worker when the
 * second claimBatch is detected (identified by $queryRawUnsafe being called inside
 * the tx callback), then awaits start().
 *
 * Tests that need custom $transaction behavior (error paths) must set up
 * mockTransaction AFTER calling resetMocks() and BEFORE calling this function —
 * but must also include the stop-after-one-batch logic themselves, OR they can
 * call makeOneShotTxImpl and compose on top of it.
 */
async function runWorkerOnce(worker: ReturnType<typeof createWorker>): Promise<void> {
  mockTransaction.mockImplementation(makeOneShotTxImpl(() => worker.stop()));
  await worker.start();
}

// ─── parsePayload — happy path ────────────────────────────────────────────────

describe("parsePayload — happy path", () => {
  beforeEach(resetMocks);

  it("returns correct AuditOutboxPayload from valid JSON object", async () => {
    const row = makeRow({
      payload: {
        scope: AUDIT_SCOPE.TEAM,
        action: AUDIT_ACTION.ENTRY_CREATE,
        userId: USER_ID,
        actorType: ACTOR_TYPE.SERVICE_ACCOUNT,
        serviceAccountId: "00000000-0000-4000-8000-000000000010",
        teamId: TEAM_ID,
        targetType: "PASSWORD_ENTRY",
        targetId: "00000000-0000-4000-8000-000000000011",
        metadata: { key: "value" },
        ip: "10.0.0.1",
        userAgent: "TestAgent/1.0",
      },
    });

    // First claimBatch returns one row, subsequent calls return empty
    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    const insertCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO audit_logs"),
    );
    expect(insertCall).toBeDefined();
    // Verify fields were passed through correctly
    expect(insertCall![2]).toBe(AUDIT_SCOPE.TEAM);
    expect(insertCall![5]).toBe(ACTOR_TYPE.SERVICE_ACCOUNT);
    expect(insertCall![7]).toBe(TEAM_ID);
  }, 15000);

  it("uses default AUDIT_SCOPE.PERSONAL and ACTOR_TYPE.HUMAN for missing fields", async () => {
    const row = makeRow({
      payload: {
        action: AUDIT_ACTION.ENTRY_CREATE,
        userId: USER_ID,
        // scope and actorType deliberately omitted
      },
    });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    const insertCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO audit_logs"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![2]).toBe(AUDIT_SCOPE.PERSONAL);
    expect(insertCall![5]).toBe(ACTOR_TYPE.HUMAN);
  }, 15000);
});

// ─── parsePayload — edge cases ────────────────────────────────────────────────

describe("parsePayload — edge cases", () => {
  beforeEach(resetMocks);

  it("handles null metadata", async () => {
    const row = makeRow({ payload: { action: AUDIT_ACTION.ENTRY_CREATE, userId: USER_ID, metadata: null } });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    const insertCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO audit_logs"),
    );
    expect(insertCall).toBeDefined();
    // metadata JSON param (index 10) should be null when payload.metadata is null
    expect(insertCall![10]).toBeNull();
  }, 15000);

  it("handles null userId with SYSTEM actorType — skips to recordError (Phase 1 limitation)", async () => {
    const row = makeRow({
      payload: {
        action: AUDIT_ACTION.ENTRY_CREATE,
        userId: null,
        actorType: ACTOR_TYPE.SYSTEM,
      },
    });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    // recordError triggers an UPDATE (PENDING retry), not INSERT
    const updateCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("UPDATE audit_outbox"),
    );
    expect(updateCall).toBeDefined();
    // INSERT INTO audit_logs must NOT have been called
    const insertCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO audit_logs"),
    );
    expect(insertCall).toBeUndefined();
  }, 15000);
});

// ─── createWorker lifecycle ───────────────────────────────────────────────────

describe("createWorker lifecycle", () => {
  beforeEach(resetMocks);

  it("starts and stops gracefully with empty batch", async () => {
    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    expect(mockLoggerInfo).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();
    expect(mockPoolEnd).toHaveBeenCalled();
  }, 15000);

  it("claims batch, delivers rows, and marks SENT", async () => {
    const row = makeRow();

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    const sentUpdate = mockExecuteRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("status = 'SENT'"),
    );
    expect(sentUpdate).toBeDefined();
  }, 15000);

  it("handles empty batch gracefully without calling deliverRow", async () => {
    // mockQueryRawUnsafe already returns [] by default

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    const insertCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO audit_logs"),
    );
    expect(insertCall).toBeUndefined();
  }, 15000);
});

// ─── claimBatch ──────────────────────────────────────────────────────────────

describe("claimBatch", () => {
  beforeEach(resetMocks);

  it("returns empty array when no pending rows — worker sleeps and exits on stop", async () => {
    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    // No INSERT should have been attempted
    const insertCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO audit_logs"),
    );
    expect(insertCall).toBeUndefined();
  }, 15000);
});

// ─── setBypassRlsGucs ─────────────────────────────────────────────────────────

describe("setBypassRlsGucs", () => {
  beforeEach(resetMocks);

  it("sets bypass GUCs via $executeRaw tagged template in each transaction", async () => {
    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    // Tagged template calls: first arg is TemplateStringsArray, rest are interpolated values
    // Reconstruct SQL by joining strings with placeholder markers
    function reconstructSql(call: unknown[]): string {
      const strings = call[0] as { raw?: string[] };
      if (!strings?.raw) return "";
      return strings.raw.join("$");
    }

    const gucCalls = mockExecuteRaw.mock.calls.map(reconstructSql)
      .filter((sql) => sql.includes("set_config"));
    expect(gucCalls.length).toBeGreaterThanOrEqual(3);
    expect(gucCalls.some((s) => s.includes("bypass_rls"))).toBe(true);
    // bypass_purpose and tenant_id are interpolated values ($1, $2), not in the template strings
    // Verify they were passed as the second argument
    const purposeCall = mockExecuteRaw.mock.calls.find(
      (call) => call[1] === BYPASS_PURPOSE.AUDIT_WRITE,
    );
    expect(purposeCall).toBeDefined();
    const tenantIdCall = mockExecuteRaw.mock.calls.find(
      (call) => call[1] === NIL_UUID,
    );
    expect(tenantIdCall).toBeDefined();
  }, 15000);
});

// ─── Error paths ──────────────────────────────────────────────────────────────

describe("error paths", () => {
  beforeEach(resetMocks);

  it("deliverRow failure triggers recordError with incremented attempt_count", async () => {
    const row = makeRow({ attempt_count: 2, max_attempts: 8 });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    // First $transaction call (claimBatch) succeeds via default impl,
    // second (deliverRow) throws, third (recordError) uses default impl,
    // fourth (next claimBatch) signals stop.
    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    let txCallCount = 0;
    mockTransaction.mockImplementation(
      async function (fn: (tx: unknown) => Promise<unknown>) {
        txCallCount++;
        if (txCallCount === 2) {
          throw new Error("deliver error");
        }
        if (txCallCount === 4) {
          worker.stop();
          return [];
        }
        return fn({
          $executeRaw: mockExecuteRaw,
          $queryRawUnsafe: mockQueryRawUnsafe,
          $executeRawUnsafe: mockExecuteRawUnsafe,
        });
      },
    );

    await worker.start();

    // recordError should update attempt_count to 3 (2+1) with PENDING status
    const updateCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("UPDATE audit_outbox") &&
        call[1] === 3,
    );
    expect(updateCall).toBeDefined();
  }, 15000);

  it("recordError marks row as FAILED when attempt_count >= max_attempts", async () => {
    const row = makeRow({ attempt_count: 7, max_attempts: 8 });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    let txCallCount = 0;
    mockTransaction.mockImplementation(
      async function (fn: (tx: unknown) => Promise<unknown>) {
        txCallCount++;
        if (txCallCount === 2) {
          throw new Error("final failure");
        }
        if (txCallCount === 4) {
          worker.stop();
          return [];
        }
        return fn({
          $executeRaw: mockExecuteRaw,
          $queryRawUnsafe: mockQueryRawUnsafe,
          $executeRawUnsafe: mockExecuteRawUnsafe,
        });
      },
    );

    await worker.start();

    const failedUpdate = mockExecuteRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("status = 'FAILED'"),
    );
    expect(failedUpdate).toBeDefined();
  }, 15000);

  it("worker handles deliverRow exception without crashing the loop", async () => {
    const row = makeRow({ attempt_count: 0, max_attempts: 8 });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    let txCallCount = 0;
    mockTransaction.mockImplementation(
      async function (fn: (tx: unknown) => Promise<unknown>) {
        txCallCount++;
        if (txCallCount === 2) {
          throw new Error("unexpected crash");
        }
        return fn({
          $executeRaw: mockExecuteRaw,
          $queryRawUnsafe: mockQueryRawUnsafe,
          $executeRawUnsafe: mockExecuteRawUnsafe,
        });
      },
    );

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    // Must not throw
    await expect(runWorkerOnce(worker)).resolves.toBeUndefined();
  }, 15000);

  it("dead-letter logging occurs when row reaches max_attempts", async () => {
    const row = makeRow({ attempt_count: 7, max_attempts: 8 });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    let txCallCount = 0;
    mockTransaction.mockImplementation(
      async function (fn: (tx: unknown) => Promise<unknown>) {
        txCallCount++;
        if (txCallCount === 2) {
          throw new Error("fatal error");
        }
        if (txCallCount === 4) {
          worker.stop();
          return [];
        }
        return fn({
          $executeRaw: mockExecuteRaw,
          $queryRawUnsafe: mockQueryRawUnsafe,
          $executeRawUnsafe: mockExecuteRawUnsafe,
        });
      },
    );

    await worker.start();

    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        outboxId: ROW_ID,
        tenantId: TENANT_ID,
      }),
      "outbox row dead-lettered",
    );
  }, 15000);

  it("worker skips null userId with non-SYSTEM actorType and logs warning + dead-letter", async () => {
    const row = makeRow({
      payload: {
        action: AUDIT_ACTION.ENTRY_CREATE,
        userId: null,
        actorType: ACTOR_TYPE.HUMAN,
      },
    });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ outboxId: ROW_ID, actorType: ACTOR_TYPE.HUMAN }),
      "worker.null_userid_non_system_skipped",
    );
    expect(mockDeadLetterWarn).toHaveBeenCalledWith(
      expect.objectContaining({ outboxId: ROW_ID }),
      "null userId for non-SYSTEM actor — skipping",
    );
    // No INSERT INTO audit_logs
    const insertCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO audit_logs"),
    );
    expect(insertCall).toBeUndefined();
  }, 15000);
});

// ─── Webhook dispatch ─────────────────────────────────────────────────────────

describe("webhook dispatch", () => {
  beforeEach(resetMocks);

  it("dispatches team webhook for TEAM scope with teamId", async () => {
    const row = makeRow({
      payload: {
        scope: AUDIT_SCOPE.TEAM,
        action: AUDIT_ACTION.ENTRY_CREATE,
        userId: USER_ID,
        actorType: ACTOR_TYPE.HUMAN,
        serviceAccountId: null,
        teamId: TEAM_ID,
        targetType: null,
        targetId: null,
        metadata: null,
        ip: null,
        userAgent: null,
      },
    });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    // Allow microtask queue to flush (void dispatchWebhookForRow)
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockDispatchWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AUDIT_ACTION.ENTRY_CREATE,
        teamId: TEAM_ID,
      }),
    );
    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  }, 15000);

  it("dispatches tenant webhook for TENANT scope", async () => {
    const row = makeRow({
      payload: {
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION.ENTRY_CREATE,
        userId: USER_ID,
        actorType: ACTOR_TYPE.HUMAN,
        serviceAccountId: null,
        teamId: null,
        targetType: null,
        targetId: null,
        metadata: null,
        ip: null,
        userAgent: null,
      },
    });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockDispatchTenantWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AUDIT_ACTION.ENTRY_CREATE,
        tenantId: TENANT_ID,
      }),
    );
    expect(mockDispatchWebhook).not.toHaveBeenCalled();
  }, 15000);

  it("skips webhook dispatch for PERSONAL scope", async () => {
    const row = makeRow();
    // payload defaults to PERSONAL scope

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockDispatchWebhook).not.toHaveBeenCalled();
    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  }, 15000);

  it("skips webhook dispatch for OUTBOX_BYPASS_AUDIT_ACTIONS", async () => {
    const bypassAction = [...OUTBOX_BYPASS_AUDIT_ACTIONS][0];
    const row = makeRow({
      payload: {
        scope: AUDIT_SCOPE.TENANT,
        action: bypassAction,
        userId: USER_ID,
        actorType: ACTOR_TYPE.HUMAN,
        serviceAccountId: null,
        teamId: null,
        targetType: null,
        targetId: null,
        metadata: null,
        ip: null,
        userAgent: null,
      },
    });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockDispatchWebhook).not.toHaveBeenCalled();
    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  }, 15000);
});

// ─── ON CONFLICT DO NOTHING dedup ────────────────────────────────────────────

describe("ON CONFLICT DO NOTHING dedup", () => {
  beforeEach(resetMocks);

  it("deliverRow marks SENT even if audit_logs INSERT was a no-op (0 rows affected)", async () => {
    const row = makeRow();

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);
    // GUCs go through $executeRaw (tagged template), not $executeRawUnsafe
    mockExecuteRawUnsafe
      .mockResolvedValueOnce(0)         // INSERT ON CONFLICT DO NOTHING — 0 rows
      .mockResolvedValueOnce(1);        // UPDATE to SENT — 1 row

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    // SENT update must still be called regardless of INSERT return value
    const sentUpdate = mockExecuteRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("status = 'SENT'"),
    );
    expect(sentUpdate).toBeDefined();
  }, 15000);
});
