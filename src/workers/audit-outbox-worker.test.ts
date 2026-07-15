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
  mockDeliverToWebhookRecords,
  mockAuditLogsInsert,
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

  const mockDeliverToWebhookRecords = vi.fn().mockResolvedValue(undefined);

  // Dedicated spy for deliverRow/deliverRowWithChain's audit_logs INSERT ...
  // RETURNING id call (routed through the tx's $queryRawUnsafe, distinct from
  // the shared mockQueryRawUnsafe used for claimBatch's one-time resolved
  // values). Tests inspect this to verify the INSERT params without disturbing
  // mockQueryRawUnsafe's claim-specific queueing.
  const mockAuditLogsInsert = vi.fn();

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
    mockDeliverToWebhookRecords,
    mockAuditLogsInsert,
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

vi.mock("@/lib/http/external-http", () => ({
  sanitizeErrorForStorage: vi.fn((msg: string) => msg),
  sanitizeForExternalDelivery: vi.fn((data: unknown) => data),
}));

vi.mock("@/lib/url/url-validation", () => ({
  maskUrlForDisplay: vi.fn((url: string) => url),
}));

vi.mock("@/lib/http/backoff", () => ({
  computeBackoffMs: mockComputeBackoffMs,
  withFullJitter: mockWithFullJitter,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  deliverToWebhookRecords: mockDeliverToWebhookRecords,
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

// Structural type matching the txClient mock in vi.hoisted (see line ~31).
// Prisma's full Prisma.TransactionClient is too wide for the partial mock
// the tests build (would force fully-typed delegate stubs). The tests need
// the SAME `Mock<Procedure>` shape that vitest infers for inline `vi.fn()`
// — anything narrower fails the assignability check at the
// `mockTransaction.mockImplementation` call sites. Per
// ~/.claude/rules/typescript/coding-style.md: avoids `any` by binding to
// vitest's official Mock type.
import type { Mock } from "vitest";
interface MockTxClient {
  $executeRaw: Mock;
  $queryRawUnsafe: Mock;
  $executeRawUnsafe: Mock;
  auditDeliveryTarget: { findMany: Mock };
  auditDelivery: { upsert: Mock; findMany: Mock; update: Mock };
}
type TxFn = (tx: MockTxClient) => Promise<unknown>;

/**
 * Build a $transaction implementation that stops the worker after the first
 * claimBatch round-trip. Returns the worker's stop() handle so tests that
 * override $transaction can call it themselves.
 *
 * claimBatch is the only transaction that calls $queryRawUnsafe inside the callback.
 * deliverRow's audit_logs INSERT ALSO goes through $queryRawUnsafe now (RETURNING id,
 * to detect the ON CONFLICT winner) — identified by its distinct SQL shape
 * (`INSERT INTO audit_logs` + `RETURNING id`). Default: the INSERT "wins" (returns
 * a row), matching the common case where deliverRow is the sole writer for a fresh
 * outbox row — tests that need the ON-CONFLICT-loser path pass `auditLogsInsertResult: []`.
 * We detect the second claimBatch by tracking whether a previous tx already used
 * $queryRawUnsafe.
 */
function makeOneShotTxImpl(
  stopFn: () => void,
  opts: { auditLogsInsertResult?: { id: string }[] } = {},
): (fn: TxFn) => Promise<unknown> {
  let outboxClaimCount = 0;
  const auditLogsInsertResult = opts.auditLogsInsertResult ?? [{ id: "11111111-1111-4111-8111-111111111111" }];
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
      // deliverRow's audit_logs INSERT ... ON CONFLICT (outbox_id) DO NOTHING RETURNING id
      if (sql.includes("INSERT INTO audit_logs") && sql.includes("RETURNING id")) {
        mockAuditLogsInsert(...args);
        return auditLogsInsertResult;
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
async function runWorkerOnce(
  worker: ReturnType<typeof createWorker>,
  opts: { auditLogsInsertResult?: { id: string }[] } = {},
): Promise<void> {
  mockTransaction.mockImplementation(makeOneShotTxImpl(() => worker.stop(), opts));
  await worker.start();
}

/**
 * Find the `INSERT INTO webhook_deliveries` enqueue call issued by
 * enqueueWebhookDeliveryInTx (called from inside deliverRow/deliverRowWithChain
 * only when the audit_logs INSERT won the ON CONFLICT race). Params (per the
 * production SQL): [0]=sql, [1]=outboxId, [2]=tenantId, [3]=scope, [4]=teamId, [5]=action.
 */
function findWebhookEnqueueCall(
  calls: unknown[][],
): unknown[] | undefined {
  return calls.find(
    (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO webhook_deliveries"),
  );
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

    const insertCall = mockAuditLogsInsert.mock.calls.find(
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

    const insertCall = mockAuditLogsInsert.mock.calls.find(
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

    const insertCall = mockAuditLogsInsert.mock.calls.find(
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
    const insertCall = mockAuditLogsInsert.mock.calls.find(
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

    const insertCall = mockAuditLogsInsert.mock.calls.find(
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
    const insertCall = mockAuditLogsInsert.mock.calls.find(
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
      async function (fn: TxFn) {
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
      async function (fn: TxFn) {
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
      async function (fn: TxFn) {
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
      async function (fn: TxFn) {
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
    const insertCall = mockAuditLogsInsert.mock.calls.find(
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

// ─── Webhook delivery enqueue ─────────────────────────────────────────────────
//
// The worker no longer fire-and-forget dispatches (dispatchWebhookForRow was
// removed). Instead, deliverRow enqueues exactly one webhook_deliveries work
// item via enqueueWebhookDeliveryInTx, gated on the audit_logs INSERT winner
// (see mockAuditLogsInsert / makeOneShotTxImpl — the winner path is the
// default). These tests assert the enqueue INSERT itself, not an HTTP dispatch
// call (that now happens later, in processWebhookDeliveryBatch, driven by
// deliverToWebhookRecords — covered by the real-DB integration suite).

describe("webhook delivery enqueue", () => {
  beforeEach(resetMocks);

  it("enqueues a TEAM-scope webhook_deliveries row for TEAM scope with teamId", async () => {
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

    const enqueueCall = findWebhookEnqueueCall(mockExecuteRawUnsafe.mock.calls);
    expect(enqueueCall).toBeDefined();
    expect(enqueueCall![1]).toBe(ROW_ID); // outbox_id
    expect(enqueueCall![3]).toBe("TEAM"); // scope
    expect(enqueueCall![4]).toBe(TEAM_ID); // team_id
    expect(enqueueCall![5]).toBe(AUDIT_ACTION.ENTRY_CREATE); // action
  }, 15000);

  it("enqueues a TENANT-scope webhook_deliveries row (team_id null) for TENANT scope", async () => {
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

    const enqueueCall = findWebhookEnqueueCall(mockExecuteRawUnsafe.mock.calls);
    expect(enqueueCall).toBeDefined();
    expect(enqueueCall![3]).toBe("TENANT"); // scope
    expect(enqueueCall![4]).toBeNull(); // team_id
    expect(enqueueCall![5]).toBe(AUDIT_ACTION.ENTRY_CREATE); // action
  }, 15000);

  it("skips enqueue for PERSONAL scope", async () => {
    const row = makeRow();
    // payload defaults to PERSONAL scope

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    await runWorkerOnce(worker);

    expect(findWebhookEnqueueCall(mockExecuteRawUnsafe.mock.calls)).toBeUndefined();
  }, 15000);

  it("skips enqueue for OUTBOX_BYPASS_AUDIT_ACTIONS", async () => {
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

    expect(findWebhookEnqueueCall(mockExecuteRawUnsafe.mock.calls)).toBeUndefined();
  }, 15000);

  it("does not enqueue when the audit_logs INSERT loses the ON CONFLICT race (inserted=false)", async () => {
    // Mirrors the reaper re-delivery scenario: a concurrent/earlier delivery
    // already won the ON CONFLICT (outbox_id) — deliverRow's INSERT returns
    // zero rows, and enqueueWebhookDeliveryInTx must NOT be reached at all.
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
    await runWorkerOnce(worker, { auditLogsInsertResult: [] });

    expect(mockAuditLogsInsert).toHaveBeenCalled();
    expect(findWebhookEnqueueCall(mockExecuteRawUnsafe.mock.calls)).toBeUndefined();
    // The outbox row must still be marked SENT regardless (deliverRow's
    // unconditional SENT update — see the "ON CONFLICT DO NOTHING dedup" suite).
    const sentUpdate = mockExecuteRawUnsafe.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("status = 'SENT'"),
    );
    expect(sentUpdate).toBeDefined();
  }, 15000);
});

// ─── ON CONFLICT DO NOTHING dedup ────────────────────────────────────────────

describe("ON CONFLICT DO NOTHING dedup", () => {
  beforeEach(resetMocks);

  it("deliverRow marks SENT even if audit_logs INSERT was a no-op (ON CONFLICT — 0 rows returned)", async () => {
    const row = makeRow();

    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    // deliverRow's audit_logs INSERT ... RETURNING id returns [] (conflict/no-op).
    await runWorkerOnce(worker, { auditLogsInsertResult: [] });

    // SENT update must still be called regardless of INSERT return value
    const sentUpdate = mockExecuteRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("status = 'SENT'"),
    );
    expect(sentUpdate).toBeDefined();
    // The no-op (conflict) path must not enqueue a webhook delivery either.
    expect(findWebhookEnqueueCall(mockExecuteRawUnsafe.mock.calls)).toBeUndefined();
  }, 15000);
});

// ─── WEBHOOK_DISPATCH_SUPPRESS ────────────────────────────────────────────────
//
// enqueueWebhookDeliveryInTx checks OUTBOX_BYPASS_AUDIT_ACTIONS first, then
// WEBHOOK_DISPATCH_SUPPRESS. These sets overlap for AUDIT_OUTBOX_* actions but
// WEBHOOK_DISPATCH_SUPPRESS also includes actions like AUDIT_OUTBOX_METRICS_VIEW
// and AUDIT_OUTBOX_PURGE_EXECUTED that are NOT in OUTBOX_BYPASS_AUDIT_ACTIONS.
// We test both guard paths here.

describe("webhook delivery enqueue — WEBHOOK_DISPATCH_SUPPRESS", () => {
  beforeEach(resetMocks);

  it("skips enqueue for actions in WEBHOOK_DISPATCH_SUPPRESS but NOT in OUTBOX_BYPASS_AUDIT_ACTIONS", async () => {
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

    expect(findWebhookEnqueueCall(mockExecuteRawUnsafe.mock.calls)).toBeUndefined();
  }, 15000);

  it("skips enqueue for AUDIT_OUTBOX_REAPED (in both suppression sets, TENANT scope)", async () => {
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

    expect(findWebhookEnqueueCall(mockExecuteRawUnsafe.mock.calls)).toBeUndefined();
  }, 15000);

  it("skips enqueue for AUDIT_OUTBOX_DEAD_LETTER (in both suppression sets, TEAM scope with teamId)", async () => {
    // Even with TEAM scope + teamId, WEBHOOK_DISPATCH_SUPPRESS must prevent enqueue
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

    expect(findWebhookEnqueueCall(mockExecuteRawUnsafe.mock.calls)).toBeUndefined();
  }, 15000);

  it("skips enqueue for AUDIT_OUTBOX_RETENTION_PURGED (in both suppression sets, TENANT scope)", async () => {
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

    expect(findWebhookEnqueueCall(mockExecuteRawUnsafe.mock.calls)).toBeUndefined();
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

  it("reapStuckRows UPDATE query is issued on the first loop iteration, capped with LIMIT and ordered oldest-first (C1)", async () => {
    // The reaper always fires on the first tick (lastReaperRun = 0).
    // reapStuckRows issues: UPDATE audit_outbox ... WHERE status = 'PROCESSING' ... LIMIT $2.
    //
    // runWorkerOnce()'s makeOneShotTxImpl intercepts ANY $queryRawUnsafe call whose SQL
    // matches audit_outbox + PENDING + SKIP LOCKED as "the outbox claim" (reapStuckRows'
    // CASE...ELSE 'PENDING' branch also matches this shape) and short-circuits without
    // forwarding to mockQueryRawUnsafe — so the real reapStuckRows SQL text is never
    // observable through that helper. Use a dedicated one-shot $transaction here instead
    // so we can capture and assert on the actual reaper SQL (C1/C8 alignment).
    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    let txCallCount = 0;
    mockTransaction.mockImplementation(
      async function (fn: TxFn) {
        txCallCount++;
        // tx 1 = claimBatch: []
        // tx 2 = processDeliveryBatch: []
        // tx 3 = reapStuckRows: [] (captured below)
        // tx 4 = reapStuckDeliveries
        // tx 5 = purgeRetention SENT-branch
        // tx 6 = purgeRetention FAILED-branch
        // tx 7 = delivery retention purge
        // tx 8 = next claimBatch — stop
        if (txCallCount >= 8) {
          worker.stop();
          return [];
        }
        const txQueryRaw = vi.fn(async (sql: string, ...args: unknown[]) => {
          if (txCallCount === 5 || txCallCount === 6) {
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

    await worker.start();

    // Match reapStuckRows specifically by its subselect WHERE clause
    // (`WHERE status = 'PROCESSING'`) — claimBatch's WHERE clause filters
    // 'PENDING', not 'PROCESSING', so this cannot match the wrong call.
    const reapCall = mockQueryRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("WHERE status = 'PROCESSING'"),
    );
    expect(reapCall).toBeDefined();
    // C1/C8: the reaper UPDATE must be capped with LIMIT and ordered oldest-first
    // so the mock actually verifies the boundedness change (not just tolerates it).
    expect(reapCall![0] as string).toContain("LIMIT");
    expect(reapCall![0] as string).toContain("ORDER BY processing_started_at");
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
      async function (fn: TxFn) {
        txCallCount++;

        // Durable webhook delivery flow (processWebhookDeliveryBatch +
        // reapStuckWebhookDeliveries + its purge branch are new sibling txs):
        // tx 1 = claimBatch (outbox PENDING check): returns []
        // tx 2 = processDeliveryBatch (delivery claim): returns []
        // tx 3 = processWebhookDeliveryBatch (webhook delivery claim): returns []
        // tx 4 = reapStuckRows (PROCESSING check): returns two reaped rows
        // tx 5 = writeDirectAuditLog for REAPED_ROW_1 (REAPED)
        // tx 6 = writeDirectAuditLog for REAPED_ROW_2 (REAPED)
        // tx 7 = reapStuckDeliveries
        // tx 8 = reapStuckWebhookDeliveries
        // tx 9 = purgeRetention SENT-branch DELETE CTE: returns 0 purged
        // tx 10 = purgeRetention FAILED-branch DELETE CTE: returns 0 purged
        // tx 11 = delivery retention purge
        // tx 12 = webhook delivery retention purge
        // tx 13 = next claimBatch iteration — stop here

        if (txCallCount >= 13) {
          worker.stop();
          return [];
        }

        const txQueryRaw = vi.fn(async (sql: string, ...args: unknown[]) => {
          if (txCallCount === 4) {
            // reapStuckRows — return two stuck rows (both below max_attempts)
            return [
              { id: REAPED_ROW_1, tenant_id: TENANT_ID, attempt_count: 1, new_status: "PENDING" },
              { id: REAPED_ROW_2, tenant_id: TENANT_ID, attempt_count: 2, new_status: "PENDING" },
            ];
          }
          if (txCallCount === 9 || txCallCount === 10) {
            // purgeRetention SENT/FAILED branches — return 0 purged
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
      async function (fn: TxFn) {
        txCallCount++;

        // Durable webhook delivery flow (processWebhookDeliveryBatch +
        // reapStuckWebhookDeliveries + its purge branch are new sibling txs).
        // writeDirectAuditLogInTx for AUDIT_OUTBOX_RETENTION_PURGED runs INSIDE
        // the SENT-branch purgeRetention tx (not a separate transaction).
        // tx 1 = claimBatch: []
        // tx 2 = processDeliveryBatch: []
        // tx 3 = processWebhookDeliveryBatch: []
        // tx 4 = reapStuckRows: 0 reaped
        // tx 5 = reapStuckDeliveries
        // tx 6 = reapStuckWebhookDeliveries
        // tx 7 = purgeRetention SENT-branch: 5 rows purged (+ inline writeDirectAuditLogInTx)
        // tx 8 = purgeRetention FAILED-branch: 0 rows purged
        // tx 9 = delivery retention purge
        // tx 10 = webhook delivery retention purge
        // tx 11 = next claimBatch — stop

        if (txCallCount >= 11) {
          worker.stop();
          return [];
        }

        const txQueryRaw = vi.fn(async (sql: string, ...args: unknown[]) => {
          if (txCallCount === 4) {
            // reapStuckRows — 0 reaped
            return [];
          }
          if (txCallCount === 7) {
            // purgeRetention SENT-branch — 5 rows deleted with a sample tenant
            return [{ purged: BigInt(5), sample_tenant_id: TENANT_ID }];
          }
          if (txCallCount === 8) {
            // purgeRetention FAILED-branch — 0 rows deleted
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
      async function (fn: TxFn) {
        txCallCount++;

        // Durable webhook delivery flow (processWebhookDeliveryBatch +
        // reapStuckWebhookDeliveries + its purge branch are new sibling txs):
        // tx 1 = claimBatch: []
        // tx 2 = processDeliveryBatch: []
        // tx 3 = processWebhookDeliveryBatch: []
        // tx 4 = reapStuckRows: throw (caught by runReaper)
        // tx 5 = reapStuckDeliveries / tx 6 = reapStuckWebhookDeliveries / purgeRetention: run independently
        // ...
        // tx >= 11 = next claimBatch — stop
        if (txCallCount === 4) {
          throw new Error("reaper db error");
        }
        if (txCallCount >= 11) {
          worker.stop();
          return [];
        }

        const txQueryRaw = vi.fn(async (sql: string, ...args: unknown[]) => {
          if (txCallCount === 7 || txCallCount === 8) {
            // purgeRetention SENT/FAILED branches — 0 purged
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

// ─── recordError — sanitize before persist ──────────────────────────────────

describe("recordError — sanitizes error message before persisting", () => {
  beforeEach(resetMocks);

  it("passes raw err.message to sanitizeErrorForStorage and writes the sanitized form to UPDATE last_error", async () => {
    // Override sanitize to return a recognizable marker; we then assert the
    // marker reaches both the UPDATE statement and the dead-letter metadata.
    const { sanitizeErrorForStorage } = await import("@/lib/http/external-http");
    const sanitizeMock = sanitizeErrorForStorage as unknown as Mock;
    sanitizeMock.mockReturnValueOnce("[SANITIZED]");

    const row = makeRow({ attempt_count: 7, max_attempts: 8 });
    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const worker = createWorker({ databaseUrl: TEST_DB_URL, pollIntervalMs: 50 });
    const RAW_MESSAGE = "request to https://upstream.example.com/api?token=secret123 failed";
    let txCallCount = 0;
    mockTransaction.mockImplementation(
      async function (fn: TxFn) {
        txCallCount++;
        // tx 1 = claimBatch (returns [row])
        // tx 2 = deliverRow — throw the raw URL-bearing message
        // tx 3 = recordError (UPDATE to FAILED with sanitized msg)
        // tx 4 = writeDirectAuditLog (DEAD_LETTER INSERT with sanitized msg)
        // tx 5 = reapStuckRows
        // tx 6 = reapStuckDeliveries
        // tx 7 = purgeRetention SENT-branch
        // tx 8 = purgeRetention FAILED-branch
        // tx 9 = delivery retention purge
        // tx 10 = next claimBatch — stop
        if (txCallCount === 2) {
          throw new Error(RAW_MESSAGE);
        }
        if (txCallCount === 10) {
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

    // 1. sanitize was called with the raw error message exactly once
    expect(sanitizeMock).toHaveBeenCalledWith(RAW_MESSAGE);

    // 2. The UPDATE audit_outbox SET last_error = LEFT($2, 1024) statement
    //    received the sanitized form (param at call[2]), not the raw message.
    const updateCall = mockExecuteRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("UPDATE audit_outbox") &&
        call[0].includes("status = 'FAILED'"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall?.[2]).toBe("[SANITIZED]");
    expect(updateCall?.[2]).not.toContain("token=secret123");

    // 3. The dead-letter INSERT metadata (param $6 at call[6]) contains
    //    the sanitized form in lastError, not the raw secret.
    const deadLetterInsert = mockExecuteRawUnsafe.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("INSERT INTO audit_logs") &&
        call[3] === AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER,
    );
    expect(deadLetterInsert).toBeDefined();
    const metadata = JSON.parse(deadLetterInsert![6] as string);
    expect(metadata.lastError).toBe("[SANITIZED]");
    expect(metadata.lastError).not.toContain("token=secret123");
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
      async function (fn: TxFn) {
        txCallCount++;
        // tx 1 = claimBatch (returns [row])
        // tx 2 = deliverRow — throw to trigger recordError
        // tx 3 = recordError (UPDATE to FAILED)
        // tx 4 = writeDirectAuditLog (DEAD_LETTER INSERT)
        // tx 5 = reapStuckRows
        // tx 6 = reapStuckDeliveries
        // tx 7 = purgeRetention SENT-branch
        // tx 8 = purgeRetention FAILED-branch
        // tx 9 = delivery retention purge
        // tx 10 = next claimBatch — stop
        if (txCallCount === 2) {
          throw new Error("deliver failed");
        }
        if (txCallCount === 10) {
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
      async function (fn: TxFn) {
        txCallCount++;
        // tx 1 = claimBatch (returns [row])
        // tx 2 = deliverRow — throw
        // tx 3 = recordError (UPDATE to PENDING, not dead)
        // tx 4 = reapStuckRows
        // tx 5 = reapStuckDeliveries
        // tx 6 = purgeRetention SENT-branch
        // tx 7 = purgeRetention FAILED-branch
        // tx 8 = delivery retention purge
        // tx 9 = next claimBatch — stop
        if (txCallCount === 2) {
          throw new Error("transient error");
        }
        if (txCallCount === 9) {
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
