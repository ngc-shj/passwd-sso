/**
 * Integration test (real DB): POST /api/internal/audit-emit
 *
 * Verifies that the route writes a PENDING audit_outbox row for
 * SETTINGS_IA_MIGRATION_V1_SEEN, enforces the per-action scope whitelist,
 * rejects metadata for client-attested actions, and preserves backward
 * compatibility for PASSKEY_ENFORCEMENT_BLOCKED.
 *
 * checkAuth is mocked to inject a real DB user without spinning up Auth.js;
 * everything downstream (logAuditAsync → enqueueAudit → audit_outbox) hits
 * the real database so the outbox write path is exercised end-to-end.
 *
 * Run: docker compose up -d db && npm run test:integration -- \
 *      audit-emit-settings-ia.integration
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { NextRequest } from "next/server";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_ACTION } from "@/lib/constants";

// ── checkAuth mock ────────────────────────────────────────────────────────────
// Allows tests to inject a real userId without a live Auth.js session.

const { mockCheckAuth } = vi.hoisted(() => ({
  mockCheckAuth: vi.fn(),
}));

vi.mock("@/lib/auth/session/check-auth", () => ({
  checkAuth: mockCheckAuth,
}));

// Rate-limiter: always allow in integration tests (Redis may be absent)
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: vi.fn().mockResolvedValue({ allowed: true }),
  }),
}));

// Import after mock registration to pick up the hoisted mocks
import { POST } from "@/app/api/internal/audit-emit/route";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeAuthOk(userId: string) {
  return { ok: true as const, auth: { type: "session" as const, userId } };
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/internal/audit-emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── test suite ────────────────────────────────────────────────────────────────

describe("POST /api/internal/audit-emit — integration (real DB)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    mockCheckAuth.mockResolvedValue(makeAuthOk(userId));
  });

  afterEach(async () => {
    // Clear audit_outbox rows before deleting tenant data so the
    // before-delete trigger (blocks PENDING/PROCESSING deletes) is bypassed.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
         WHERE tenant_id = $1::uuid AND status IN ('PENDING', 'PROCESSING')`,
        tenantId,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  /** Read PENDING outbox rows for this test's tenant. */
  async function readPendingOutbox(): Promise<Array<{ payload: Record<string, unknown> }>> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ payload: Record<string, unknown> }>>(
        `SELECT payload FROM audit_outbox
         WHERE tenant_id = $1::uuid AND status = 'PENDING'::"AuditOutboxStatus"
         ORDER BY created_at ASC`,
        tenantId,
      );
    });
  }

  // ── test 1 ──────────────────────────────────────────────────────────────────

  it("SETTINGS_IA_MIGRATION_V1_SEEN with scope PERSONAL → 200 + one PENDING outbox row", async () => {
    const res = await POST(
      makeRequest({ action: AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN, scope: "PERSONAL" }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true });

    const rows = await readPendingOutbox();
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload;
    expect(payload.action).toBe(AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN);
    expect(payload.userId).toBe(userId);
    expect(payload.scope).toBe("PERSONAL");
  });

  // ── test 2 ──────────────────────────────────────────────────────────────────

  it("SETTINGS_IA_MIGRATION_V1_SEEN with scope TENANT → 400 (scope whitelist violation)", async () => {
    const res = await POST(
      makeRequest({ action: AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN, scope: "TENANT" }),
    );
    expect(res.status).toBe(400);

    // No outbox row created
    const rows = await readPendingOutbox();
    expect(rows).toHaveLength(0);
  });

  // ── test 3 ──────────────────────────────────────────────────────────────────

  it("SETTINGS_IA_MIGRATION_V1_SEEN with any metadata → 400 (client-attested action rejects metadata)", async () => {
    const res = await POST(
      makeRequest({
        action: AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN,
        scope: "PERSONAL",
        metadata: { extra: "data" },
      }),
    );
    expect(res.status).toBe(400);

    const rows = await readPendingOutbox();
    expect(rows).toHaveLength(0);
  });

  // ── test 4 ──────────────────────────────────────────────────────────────────

  it("PASSKEY_ENFORCEMENT_BLOCKED with no scope → 200, scope defaults to TENANT", async () => {
    const res = await POST(
      makeRequest({ action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED }),
    );
    expect(res.status).toBe(200);

    const rows = await readPendingOutbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.action).toBe(AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED);
    expect(rows[0].payload.scope).toBe("TENANT");
  });

  // ── test 5 ──────────────────────────────────────────────────────────────────

  it("non-allowlisted action → 400", async () => {
    const res = await POST(
      makeRequest({ action: "SOME_UNKNOWN_ACTION" }),
    );
    expect(res.status).toBe(400);

    const rows = await readPendingOutbox();
    expect(rows).toHaveLength(0);
  });

  // ── test 6 ──────────────────────────────────────────────────────────────────

  it("unauthenticated request → 401", async () => {
    mockCheckAuth.mockResolvedValue({ ok: false as const, response: new Response("{}", { status: 401 }) });

    const res = await POST(
      makeRequest({ action: AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN, scope: "PERSONAL" }),
    );
    expect(res.status).toBe(401);

    const rows = await readPendingOutbox();
    expect(rows).toHaveLength(0);
  });
});
