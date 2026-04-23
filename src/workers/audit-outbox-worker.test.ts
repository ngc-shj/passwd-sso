import { describe, it, expect, vi, beforeEach } from "vitest";
import { AUDIT_SCOPE, ACTOR_TYPE, AUDIT_ACTION, OUTBOX_BYPASS_AUDIT_ACTIONS, WEBHOOK_DISPATCH_SUPPRESS } from "@/lib/constants/audit/audit";

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
    // Phase 3: delivery model stubs (fanOutDeliveries runs fire-and-forget)
    auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
    auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
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

vi.mock("@/lib/audit/audit-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit/audit-logger")>();
  return {
    ...actual,
    deadLetterLogger: { warn: mockDeadLetterWarn },
    auditLogger: { info: vi.fn(), enabled: false },
  };
});

// Phase 3: mock delivery dependencies so existing tests are unaffected
vi.mock("@/workers/audit-delivery", () => ({
  DELIVERERS: {},
}));

vi.mock("@/lib/crypto/crypto-server", () => ({
  decryptServerData: vi.fn().mockReturnValue("{}"),
  getMasterKeyByVersion: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

vi.mock("@/lib/external-http", () => ({
  sanitizeErrorForStorage: vi.fn((msg: string) => msg),
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
  let outboxClaimCount = 0;
  return async function (fn: TxFn) {
    const txQueryRaw = vi.fn(async (...args: unknown[]) => {
      const sql = typeof args[0] === "string" ? args[0] : "";
      // Identify outbox claim by its unique SQL pattern: UPDATE audit_outbox + PENDING + SKIP LOCKED
      const isOutboxClaim = sql.includes("audit_outbox") && sql.includes("PENDING") && sql.includes("SKIP LOCKED");
      if (isOutboxClaim) {
        outboxClaimCount++;
        if (outboxClaimCount > 1) {
          stopFn();
          return [];
        }
        return mockQueryRawUnsafe(...args);
      }
      // Delivery claims, reaper, purge, or other queries — return empty/default
      if (sql.includes("DELETE FROM audit_outbox")) {
        // purgeRetention CTE — return 0 purged
        return [{ purged: BigInt(0), sample_tenant_id: null }];
      }
      return [];
    });

    const result = await fn({
      $executeRaw: mockExecuteRaw,
      $queryRawUnsafe: txQueryRaw,
      $executeRawUnsafe: mockExecuteRawUnsafe,
      auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
      auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    });

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
      // Phase 3: delivery model stubs
      auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
      auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
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

  it("rejects malformed userId (null with SYSTEM actorType) via UUID_RE guard — no INSERT, warn log emitted", async () => {
    // Phase 3: UUID_RE guard at L968 fires for SYSTEM actor with non-UUID userId.
    // parsePayload coerces null → ""; UUID_RE.test("") === false triggers the guard.
    // The row is dead-lettered via recordError and no INSERT is attempted.
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

    // INSERT INTO audit_logs must NOT be called
    const insertCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO audit_logs"),
    );
    expect(insertCall).toBeUndefined();
    // UUID_RE guard emits the skip warning
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ outboxId: ROW_ID }),
      "worker.invalid_userid_skipped",
    );
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
          auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
          auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
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
          auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
          auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
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
          auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
          auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
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
          auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
          auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
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

  it("rejects malformed userId (null with non-SYSTEM actorType) via UUID_RE guard — no INSERT, warn log emitted", async () => {
    // Phase 3: UUID_RE guard at L948 fires for non-SYSTEM actor with non-UUID userId.
    // parsePayload coerces null → ""; UUID_RE.test("") === false, actorType !== SYSTEM.
    // The row is dead-lettered via recordError and no INSERT is attempted.
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

    // INSERT INTO audit_logs must NOT be called
    const insertCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO audit_logs"),
    );
    expect(insertCall).toBeUndefined();
    // UUID_RE guard emits the skip warning
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ outboxId: ROW_ID }),
      "worker.invalid_userid_skipped",
    );
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

// ─── WEBHOOK_DISPATCH_SUPPRESS ────────────────────────────────────────────────
//
// dispatchWebhookForRow checks OUTBOX_BYPASS_AUDIT_ACTIONS first, then
// WEBHOOK_DISPATCH_SUPPRESS. These sets overlap for AUDIT_OUTBOX_* actions but
// WEBHOOK_DISPATCH_SUPPRESS also includes actions like AUDIT_OUTBOX_METRICS_VIEW
// and AUDIT_OUTBOX_PURGE_EXECUTED that are NOT in OUTBOX_BYPASS_AUDIT_ACTIONS.
// We test both guard paths here.

describe("webhook dispatch — WEBHOOK_DISPATCH_SUPPRESS", () => {
  beforeEach(resetMocks);

  it("skips webhook dispatch for actions in WEBHOOK_DISPATCH_SUPPRESS but NOT in OUTBOX_BYPASS_AUDIT_ACTIONS", async () => {
    // AUDIT_OUTBOX_METRICS_VIEW is in SUPPRESS but NOT in BYPASS (admin endpoint action)
    const suppressOnlyAction = AUDIT_ACTION.AUDIT_OUTBOX_METRICS_VIEW;
    expect(WEBHOOK_DISPATCH_SUPPRESS.has(suppressOnlyAction)).toBe(true);
    expect(OUTBOX_BYPASS_AUDIT_ACTIONS.has(suppressOnlyAction)).toBe(false);

    const row = makeRow({
      payload: {
        scope: AUDIT_SCOPE.TENANT,
        action: suppressOnlyAction,
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

    // Flush microtask queue so any fire-and-forget dispatch calls settle
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockDispatchWebhook).not.toHaveBeenCalled();
    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  }, 15000);

  it("skips webhook dispatch for AUDIT_OUTBOX_REAPED (in both suppression sets, TENANT scope)", async () => {
    const row = makeRow({
      payload: {
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
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

  it("skips webhook dispatch for AUDIT_OUTBOX_DEAD_LETTER (in both suppression sets, TEAM scope with teamId)", async () => {
    // Even with TEAM scope + teamId, WEBHOOK_DISPATCH_SUPPRESS must prevent dispatch
    const row = makeRow({
      payload: {
        scope: AUDIT_SCOPE.TEAM,
        action: AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER,
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

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockDispatchWebhook).not.toHaveBeenCalled();
    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  }, 15000);

  it("skips webhook dispatch for AUDIT_OUTBOX_RETENTION_PURGED (in both suppression sets, TENANT scope)", async () => {
    const row = makeRow({
      payload: {
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION.AUDIT_OUTBOX_RETENTION_PURGED,
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

// ─── Reaper invocation ────────────────────────────────────────────────────────
//
// runReaper() is called inside the worker loop when REAPER_INTERVAL_MS has
// elapsed since the last run. Because REAPER_INTERVAL_MS defaults to 30 s (in
// the test env AUDIT_OUTBOX.REAPER_INTERVAL_MS is whatever envInt resolves to),
// the reaper fires on the FIRST loop iteration (lastReaperRun starts at 0, so
// now - 0 >= threshold is always true on the first tick).
//
// reapStuckRows uses $transaction with $queryRawUnsafe internally.
// purgeRetention also uses $transaction with $queryRawUnsafe.
// We observe their SQL via mockQueryRawUnsafe argument inspection.

describe("reaper — invoked on first loop tick", () => {
  beforeEach(resetMocks);

  it("reapStuckRows UPDATE query is issued on the first loop iteration", async () => {
    // The reaper always fires on the first tick (lastReaperRun = 0).
    // reapStuckRows issues: UPDATE audit_outbox SET status = 'PENDING' ... WHERE status = 'PROCESSING'
    // We verify that SQL appears among the $queryRawUnsafe calls.

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    const reapCall = mockQueryRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("status = 'PROCESSING'"),
    );
    expect(reapCall).toBeDefined();
  }, 15000);

  it("reapStuckRows does not write a direct audit log when no rows are reaped (empty result)", async () => {
    // mockQueryRawUnsafe already returns [] by default.
    // With 0 reaped rows, writeDirectAuditLog should NOT be called for AUDIT_OUTBOX_REAPED.
    // writeDirectAuditLog emits an INSERT via $executeRawUnsafe with AUDIT_OUTBOX_REAPED action.

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    const reapedInsert = mockExecuteRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("INSERT INTO audit_logs") &&
        call[3] === AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
    );
    expect(reapedInsert).toBeUndefined();
  }, 15000);

  it("reapStuckRows writes a direct audit log for each reaped row", async () => {
    // Arrange: reapStuckRows' $queryRawUnsafe returns two reaped rows.
    // The claimBatch $queryRawUnsafe (for PENDING rows) continues to return [].
    // We distinguish the two calls by SQL content in a custom mockTransaction impl.

    const REAPED_ROW_1 = "aaaaaaaa-0000-4000-8000-000000000001";
    const REAPED_ROW_2 = "aaaaaaaa-0000-4000-8000-000000000002";

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });

    let txCallCount = 0;
    mockTransaction.mockImplementation(
      async function (fn: (tx: unknown) => Promise<unknown>) {
        txCallCount++;

        // Phase 3 flow:
        // tx 1 = claimBatch (outbox PENDING check): returns []
        // tx 2 = processDeliveryBatch (delivery claim): returns []
        // tx 3 = reapStuckRows (PROCESSING check): returns two reaped rows
        // tx 4 = reapStuckDeliveries
        // tx 5 = writeDirectAuditLog for REAPED_ROW_1 (REAPED)
        // tx 6 = writeDirectAuditLog for REAPED_ROW_2 (REAPED)
        // tx 7 = purgeRetention (DELETE CTE): returns 0 purged
        // tx 8-9 = delivery retention purge
        // tx 10 = next claimBatch iteration — stop here

        if (txCallCount >= 10) {
          worker.stop();
          return [];
        }

        const txQueryRaw = vi.fn(async (sql: string, ...args: unknown[]) => {
          if (txCallCount === 3) {
            // reapStuckRows — return two stuck rows (both below max_attempts)
            return [
              { id: REAPED_ROW_1, tenant_id: TENANT_ID, attempt_count: 1, new_status: "PENDING" },
              { id: REAPED_ROW_2, tenant_id: TENANT_ID, attempt_count: 2, new_status: "PENDING" },
            ];
          }
          if (txCallCount === 7) {
            // purgeRetention — return 0 purged
            return [{ purged: BigInt(0), sample_tenant_id: null }];
          }
          // claimBatch, delivery claim, and direct-audit transactions return []
          return mockQueryRawUnsafe(sql, ...args);
        });

        return fn({
          $executeRaw: mockExecuteRaw,
          $queryRawUnsafe: txQueryRaw,
          $executeRawUnsafe: mockExecuteRawUnsafe,
          auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
          auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
        });
      },
    );

    await worker.start();

    // writeDirectAuditLog inserts with AUDIT_OUTBOX_REAPED as the action (param index 3)
    const reapedInserts = mockExecuteRawUnsafe.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("INSERT INTO audit_logs") &&
        call[3] === AUDIT_ACTION.AUDIT_OUTBOX_REAPED,
    );
    expect(reapedInserts).toHaveLength(2);

    // Verify outboxId appears in the metadata JSON for each insert
    // writeDirectAuditLog params: sql($0), tenantId($1), scope($2), action($3), SYSTEM_ACTOR_ID($4), actorType($5), metadata($6)
    const metadataArgs = reapedInserts.map((call) => JSON.parse(call[6] as string));
    expect(metadataArgs.some((m: Record<string, unknown>) => m.outboxId === REAPED_ROW_1)).toBe(true);
    expect(metadataArgs.some((m: Record<string, unknown>) => m.outboxId === REAPED_ROW_2)).toBe(true);
  }, 15000);

  it("purgeRetention writes a direct audit log when rows are purged", async () => {
    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });

    let txCallCount = 0;
    mockTransaction.mockImplementation(
      async function (fn: (tx: unknown) => Promise<unknown>) {
        txCallCount++;

        // Phase 3 flow:
        // tx 1 = claimBatch: []
        // tx 2 = processDeliveryBatch: []
        // tx 3 = reapStuckRows: 0 reaped
        // tx 4 = reapStuckDeliveries
        // tx 5 = purgeRetention: 5 rows purged
        // tx 6-7 = delivery retention purge
        // tx 8 = writeDirectAuditLog for AUDIT_OUTBOX_RETENTION_PURGED
        // tx 9 = next claimBatch — stop

        if (txCallCount >= 9) {
          worker.stop();
          return [];
        }

        const txQueryRaw = vi.fn(async (sql: string, ...args: unknown[]) => {
          if (txCallCount === 3) {
            // reapStuckRows — 0 reaped
            return [];
          }
          if (txCallCount === 5) {
            // purgeRetention — 5 rows deleted with a sample tenant
            return [{ purged: BigInt(5), sample_tenant_id: TENANT_ID }];
          }
          return mockQueryRawUnsafe(sql, ...args);
        });

        return fn({
          $executeRaw: mockExecuteRaw,
          $queryRawUnsafe: txQueryRaw,
          $executeRawUnsafe: mockExecuteRawUnsafe,
          auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
          auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
        });
      },
    );

    await worker.start();

    // writeDirectAuditLog for AUDIT_OUTBOX_RETENTION_PURGED inserts with that action at param 3
    const purgeInsert = mockExecuteRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("INSERT INTO audit_logs") &&
        call[3] === AUDIT_ACTION.AUDIT_OUTBOX_RETENTION_PURGED,
    );
    expect(purgeInsert).toBeDefined();

    // metadata JSON at param index 6: sql($0), tenantId($1), scope($2), action($3), SYSTEM_ACTOR_ID($4), actorType($5), metadata($6)
    const metadata = JSON.parse(purgeInsert![6] as string);
    expect(metadata.purgedCount).toBe(5);
  }, 15000);

  it("reaper errors do not crash the worker loop", async () => {
    // If reapStuckRows throws, the worker should swallow the error (runReaper catches it)
    // and continue processing the next batch iteration normally.

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });

    let txCallCount = 0;
    mockTransaction.mockImplementation(
      async function (fn: (tx: unknown) => Promise<unknown>) {
        txCallCount++;

        // Phase 3 flow:
        // tx 1 = claimBatch: []
        // tx 2 = processDeliveryBatch: []
        // tx 3 = reapStuckRows: throw (caught by runReaper)
        // tx 4 = reapStuckDeliveries / purgeRetention: runs independently
        // ...
        // tx >= 8 = next claimBatch — stop
        if (txCallCount === 3) {
          throw new Error("reaper db error");
        }
        if (txCallCount >= 8) {
          worker.stop();
          return [];
        }

        const txQueryRaw = vi.fn(async (sql: string, ...args: unknown[]) => {
          if (txCallCount === 5) {
            // purgeRetention — 0 purged
            return [{ purged: BigInt(0), sample_tenant_id: null }];
          }
          return mockQueryRawUnsafe(sql, ...args);
        });

        return fn({
          $executeRaw: mockExecuteRaw,
          $queryRawUnsafe: txQueryRaw,
          $executeRawUnsafe: mockExecuteRawUnsafe,
          auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
          auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
        });
      },
    );

    await expect(worker.start()).resolves.toBeUndefined();

    // The reaper error should have been logged
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "worker.reaper.stuck_reset_failed",
    );
  }, 15000);
});

// ─── recordError — AUDIT_OUTBOX_DEAD_LETTER via writeDirectAuditLog ──────────

describe("recordError — AUDIT_OUTBOX_DEAD_LETTER written on dead-letter", () => {
  beforeEach(resetMocks);

  it("writeDirectAuditLog is called with AUDIT_OUTBOX_DEAD_LETTER when row is dead-lettered", async () => {
    // When attempt_count + 1 >= max_attempts, recordError must call writeDirectAuditLog
    // which issues an INSERT INTO audit_logs with action = AUDIT_OUTBOX_DEAD_LETTER.
    const row = makeRow({ attempt_count: 7, max_attempts: 8 });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    let txCallCount = 0;
    mockTransaction.mockImplementation(
      async function (fn: (tx: unknown) => Promise<unknown>) {
        txCallCount++;
        // tx 1 = claimBatch (returns [row])
        // tx 2 = deliverRow — throw to trigger recordError
        // tx 3 = recordError (UPDATE to FAILED)
        // tx 4 = writeDirectAuditLog (DEAD_LETTER INSERT)
        // tx 5 = reapStuckRows
        // tx 6 = purgeRetention
        // tx 7 = next claimBatch — stop
        if (txCallCount === 2) {
          throw new Error("deliver failed");
        }
        if (txCallCount === 7) {
          worker.stop();
          return [];
        }
        return fn({
          $executeRaw: mockExecuteRaw,
          $queryRawUnsafe: mockQueryRawUnsafe,
          $executeRawUnsafe: mockExecuteRawUnsafe,
          auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
          auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
        });
      },
    );

    await worker.start();

    // writeDirectAuditLog inserts with AUDIT_OUTBOX_DEAD_LETTER at param index 3
    const deadLetterInsert = mockExecuteRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("INSERT INTO audit_logs") &&
        call[3] === AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER,
    );
    expect(deadLetterInsert).toBeDefined();
  }, 15000);

  it("writeDirectAuditLog is NOT called when row is not yet dead-lettered (attempt_count < max_attempts)", async () => {
    const row = makeRow({ attempt_count: 2, max_attempts: 8 });

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    let txCallCount = 0;
    mockTransaction.mockImplementation(
      async function (fn: (tx: unknown) => Promise<unknown>) {
        txCallCount++;
        // tx 1 = claimBatch (returns [row])
        // tx 2 = deliverRow — throw
        // tx 3 = recordError (UPDATE to PENDING, not dead)
        // tx 4 = reapStuckRows
        // tx 5 = purgeRetention
        // tx 6 = next claimBatch — stop
        if (txCallCount === 2) {
          throw new Error("transient error");
        }
        if (txCallCount === 6) {
          worker.stop();
          return [];
        }
        return fn({
          $executeRaw: mockExecuteRaw,
          $queryRawUnsafe: mockQueryRawUnsafe,
          $executeRawUnsafe: mockExecuteRawUnsafe,
          auditDeliveryTarget: { findMany: vi.fn().mockResolvedValue([]) },
          auditDelivery: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
        });
      },
    );

    await worker.start();

    // No AUDIT_OUTBOX_DEAD_LETTER insert expected
    const deadLetterInsert = mockExecuteRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("INSERT INTO audit_logs") &&
        call[3] === AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER,
    );
    expect(deadLetterInsert).toBeUndefined();
  }, 15000);
});
