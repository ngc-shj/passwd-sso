import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { assertRedisFailClosed, snapshotFactory } from "@/__tests__/helpers/fail-closed";

const {
  mockVerifyAdminToken,
  mockQueryRawUnsafe,
  mockRequireMaintenanceOperator,
  mockCheck,
  mockCreateRateLimiter,
  mockLogAudit,
  mockWithBypassRls,
} = vi.hoisted(() => {
  const mockCheck = vi.fn().mockResolvedValue({ allowed: true });
  return {
    mockVerifyAdminToken: vi.fn(),
    mockQueryRawUnsafe: vi.fn(),
    mockRequireMaintenanceOperator: vi.fn(),
    mockCheck,
    mockCreateRateLimiter: vi.fn(() => ({ check: mockCheck, clear: vi.fn() })),
    mockLogAudit: vi.fn(),
    mockWithBypassRls: vi.fn(
      async (prisma: unknown, fn: (tx: unknown) => unknown, _purpose?: unknown) => fn(prisma),
    ),
  };
});

vi.mock("@/lib/auth/tokens/admin-token", () => ({
  verifyAdminToken: mockVerifyAdminToken,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRawUnsafe: mockQueryRawUnsafe,
  },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: mockCreateRateLimiter,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "10.0.0.1",
    userAgent: "Test",
    acceptLanguage: null,
  }),
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/auth/access/maintenance-auth", () => ({
  requireMaintenanceOperator: mockRequireMaintenanceOperator,
}));

import { GET } from "./route";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";
// The real chain primitives — deliberately NOT mocked, so fixtures below carry
// genuine event hashes and the walk is exercised end-to-end rather than against
// a re-implementation of it.
import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
} from "@/lib/audit/audit-chain";

// Module-scope snapshot: route.ts's `rateLimiter = createRateLimiter(...)` runs
// at import time above, before any beforeEach's vi.clearAllMocks() can wipe it.
const chainVerifyLimiterFactorySnapshot = snapshotFactory(mockCreateRateLimiter);
const chainVerifyLimiter = mockCreateRateLimiter.mock.results[0]!.value as {
  check: typeof mockCheck;
};

const SUBJECT_USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const TOKEN_ID = "op-token-id-1";
// tenantId as a valid UUID for Zod validation
const TENANT_ID = "550e8400-e29b-41d4-a716-446655440001";
const OTHER_TENANT_ID = "550e8400-e29b-41d4-a716-446655440002";

const VALID_OP_TOKEN = `${OPERATOR_TOKEN_PREFIX}${"a".repeat(43)}`;

const VALID_AUTH = {
  subjectUserId: SUBJECT_USER_ID,
  tenantId: TENANT_ID,
  tokenId: TOKEN_ID,
  scopes: ["maintenance"] as const,
};

function createRequest(params: Record<string, string>, token?: string): NextRequest {
  const url = new URL("http://localhost/api/maintenance/audit-chain-verify");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {
    "x-forwarded-for": "10.0.0.1",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new NextRequest(url, {
    method: "GET",
    headers,
  });
}

describe("GET /api/maintenance/audit-chain-verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true });
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "MISSING_OR_MALFORMED" });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: true,
      operator: { tenantId: TENANT_ID, role: "ADMIN" },
    });
    // Default: anchor lookup returns empty (no anchors → early exit with totalVerified: 0)
    mockQueryRawUnsafe.mockResolvedValue([]);
  });

  // ─── Auth ──────────────────────────────────────────────────

  it("returns 401 without authorization header", async () => {
    const req = createRequest({ tenantId: TENANT_ID });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when verifyAdminToken returns INVALID", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: false, reason: "INVALID" });
    const req = createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  // ─── Rate Limit ────────────────────────────────────────────

  it("returns 429 when rate limited", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockCheck.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const req = createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(429);

    // #629 headline property: the maintenance rate-limit key is tenant-scoped
    // so one tenant's operator cannot 429 another tenant's op. A regression
    // dropping `${auth.tenantId}` (global key) or swapping in subjectUserId
    // would still pass the 429/503 behavior tests — only an exact-key assertion
    // pinning the route discriminator + tenantId segment catches it. The key is
    // passed to check() before the limiter's verdict, so asserting it here
    // needs no route-specific success mocks.
    expect(mockCheck).toHaveBeenCalledWith(`rl:maintenance:chain-verify:${TENANT_ID}`);
  });

  it("fails closed (503, no mutation) when Redis is unavailable", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    await assertRedisFailClosed({
      invoke: () => GET(createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN)),
      limiter: chainVerifyLimiter,
      expectation: { envelope: "canonical" },
      assertNoMutation: [mockQueryRawUnsafe],
      limiterFactory: chainVerifyLimiterFactorySnapshot.replay(),
      failure: { allowed: false, redisErrored: true },
    });
  });

  // ─── Query Validation ────────────────────────────────────

  it("returns 400 when tenantId query param is missing", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    const req = createRequest({}, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  // ─── Cross-tenant check ───────────────────────────────────

  it("returns 403 when query tenantId does not match token tenantId", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    // OTHER_TENANT_ID is a valid UUID but differs from VALID_AUTH.tenantId
    const req = createRequest({ tenantId: OTHER_TENANT_ID }, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  // ─── Operator Membership Check ────────────────────────────

  it("returns 400 when operator is not an active admin", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockRequireMaintenanceOperator.mockResolvedValue({
      ok: false,
      response: new Response(
        JSON.stringify({ error: "operatorId is not an active tenant admin" }),
        { status: 400 },
      ),
    });

    const req = createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  // ─── Success (empty anchors short-circuit) ────────────────

  it("returns 200 with ok=true and totalVerified=0 when no chain anchors exist", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    // Empty anchor array triggers the early-exit path
    mockQueryRawUnsafe.mockResolvedValue([]);

    const req = createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN);
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.totalVerified).toBe(0);
  });

  // ─── Audit ────────────────────────────────────────────────

  it("does not emit audit when anchors are empty (early exit before audit)", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    mockQueryRawUnsafe.mockResolvedValue([]);

    const req = createRequest({ tenantId: TENANT_ID }, VALID_OP_TOKEN);
    await GET(req);

    // The early-exit path returns before the audit log call
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // ─── Seed row missing (partial verification) ──────────────

  it("returns 400 with AUDIT_CHAIN_SEED_NOT_FOUND when partial walk seed row is missing", async () => {
    mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    // Sequential mock returns:
    //  1) anchor lookup → non-empty (anchorSeq = 10)
    //  2) fromRows lookup → minSeq = 5 (triggers fromSeq > 1 branch)
    //  3) seedRows lookup → empty array (seed row missing)
    mockQueryRawUnsafe
      .mockResolvedValueOnce([{ chain_seq: "10" }])
      .mockResolvedValueOnce([{ chain_seq: "5" }])
      .mockResolvedValueOnce([]);

    const req = createRequest(
      { tenantId: TENANT_ID, from: "2026-01-01T00:00:00Z" },
      VALID_OP_TOKEN,
    );
    const res = await GET(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("AUDIT_CHAIN_SEED_NOT_FOUND");
  });

  // ─── Chain walk ───────────────────────────────────────────
  //
  // Everything below drives the real walk in route.ts. Fixtures are built with
  // the production hash primitives (imported above, unmocked), so a change to
  // buildChainInput / computeEventHash that the route did not follow shows up
  // here as a tamper rather than as a silently-still-green test.

  const GENESIS = Buffer.from([0x00]);
  const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");

  interface ChainFixtureRow {
    id: string;
    created_at: Date;
    chain_seq: string;
    event_hash: Uint8Array;
    chain_prev_hash: Uint8Array;
    metadata: Record<string, unknown>;
  }

  /**
   * Build a genuinely-chained run of rows. `seqs` drives both chain_seq and the
   * per-row timestamp, so a non-contiguous list produces a real gap and a
   * decreasing list produces a real timestamp violation.
   */
  function buildChain(
    seqs: number[],
    opts: { createdAtFor?: (seq: number, index: number) => Date } = {},
  ): ChainFixtureRow[] {
    let prevHash: Buffer = GENESIS;
    return seqs.map((seq, index) => {
      const createdAt =
        opts.createdAtFor?.(seq, index) ?? new Date(BASE_TIME.getTime() + index * 1000);
      const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
      const metadata = { action: "TEST_EVENT", seq };
      const eventHash = computeEventHash(
        prevHash,
        computeCanonicalBytes(
          buildChainInput({
            id,
            createdAt,
            chainSeq: BigInt(seq),
            prevHash,
            payload: metadata,
          }),
        ),
      );
      const row: ChainFixtureRow = {
        id,
        created_at: createdAt,
        chain_seq: String(seq),
        event_hash: eventHash,
        chain_prev_hash: prevHash,
        metadata,
      };
      prevHash = eventHash;
      return row;
    });
  }

  /** Corrupt a stored hash so it cannot match what the walk recomputes. */
  function tamper(hash: Uint8Array): Buffer {
    const corrupted = Buffer.from(hash);
    corrupted[0] ^= 0xff;
    return corrupted;
  }

  /** Wire the anchor lookup then the chain-row query (no from/to params). */
  function mockWalk(anchorSeq: number, rows: ChainFixtureRow[]) {
    mockQueryRawUnsafe
      .mockResolvedValueOnce([{ chain_seq: String(anchorSeq) }])
      .mockResolvedValueOnce(rows);
  }

  async function walk(params: Record<string, string> = {}) {
    const res = await GET(createRequest({ tenantId: TENANT_ID, ...params }, VALID_OP_TOKEN));
    return { res, body: await res.json() };
  }

  // Nested so the authenticated default stays scoped to the walk tests — a
  // describe-level beforeEach here would run after the outer one and override
  // the unauthenticated default the 401 tests rely on.
  describe("with a valid operator token", () => {
    beforeEach(() => {
      mockVerifyAdminToken.mockResolvedValue({ ok: true, auth: VALID_AUTH });
    });

  it("reports ok for a fully-covered valid chain", async () => {
    mockWalk(3, buildChain([1, 2, 3]));

    const { res, body } = await walk();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.reason).toBeUndefined();
    expect(body.totalVerified).toBe(3);
    expect(body.walkedThrough).toBe(3);
    expect(body.verifiedUpToSeq).toBe(3);
    expect(body.truncated).toBe(false);
  });

  it("bails at the first tampered row and does not count it as verified", async () => {
    const rows = buildChain([1, 2, 3]);
    // Flip a byte in row 2's stored hash — row 1 still verifies, row 2 does not,
    // and row 3 must NOT be counted (C15/OWASP A08-2: continuing past a tamper
    // re-seeds from a hash the attacker controls). XOR rather than assignment:
    // overwriting with a constant is a no-op when the byte already holds it.
    rows[1].event_hash = tamper(rows[1].event_hash);
    mockWalk(3, rows);

    const { body } = await walk();

    expect(body.ok).toBe(false);
    expect(body.reason).toBe("TAMPER_DETECTED");
    expect(body.firstTamperedSeq).toBe(2);
    expect(body.totalVerified).toBe(1);
    expect(body.walkedThrough).toBe(1);
  });

  it("reports GAP_DETECTED when chain_seq skips a value", async () => {
    // buildChain hashes each row against its real predecessor, so the run is
    // internally valid — the only defect is the missing seq 2.
    mockWalk(3, buildChain([1, 3]));

    const { body } = await walk();

    expect(body.ok).toBe(false);
    expect(body.reason).toBe("GAP_DETECTED");
    expect(body.firstGapAfterSeq).toBe(1);
    expect(body.firstTamperedSeq).toBeNull();
  });

  it("reports TIMESTAMP_VIOLATION when created_at moves backwards", async () => {
    mockWalk(
      3,
      buildChain([1, 2, 3], {
        // seq 3 lands before seq 2
        createdAtFor: (seq) =>
          new Date(BASE_TIME.getTime() + (seq === 3 ? 0 : seq * 1000)),
      }),
    );

    const { body } = await walk();

    expect(body.ok).toBe(false);
    expect(body.reason).toBe("TIMESTAMP_VIOLATION");
    expect(body.firstTimestampViolationSeq).toBe(3);
    expect(body.firstTamperedSeq).toBeNull();
  });

  // ─── Fail-closed coverage (SEC-1) ─────────────────────────

  it("fails closed with RANGE_INCOMPLETE when rows above the walk are missing", async () => {
    // The anchor says the chain reached seq 5, but only 1..2 survive — rows
    // deleted at the head leave no gap BETWEEN the returned rows, so every
    // per-row check passes and only the coverage comparison catches it.
    mockWalk(5, buildChain([1, 2]));

    const { body } = await walk();

    expect(body.ok).toBe(false);
    expect(body.reason).toBe("RANGE_INCOMPLETE");
    expect(body.truncated).toBe(false);
    expect(body.firstTamperedSeq).toBeNull();
    expect(body.firstGapAfterSeq).toBeNull();
    expect(body.verifiedUpToSeq).toBe(2);
  });

  it("fails closed with RANGE_INCOMPLETE when every chained row is gone but the anchor remains", async () => {
    mockWalk(5, []);

    const { body } = await walk();

    expect(body.ok).toBe(false);
    expect(body.reason).toBe("RANGE_INCOMPLETE");
    expect(body.totalVerified).toBe(0);
  });

  it("fails closed with ANCHOR_MISSING when the anchor is gone but chained rows survive", async () => {
    // 1) anchor lookup → empty, 2) chained-row count → non-zero
    mockQueryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 7n }]);

    const { res, body } = await walk();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("ANCHOR_MISSING");
    expect(body.totalVerified).toBe(0);
    // A vanished anchor is a security event, not a quiet 200
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit.mock.calls[0][0].metadata).toMatchObject({
      ok: false,
      reason: "ANCHOR_MISSING",
    });
  });

  it("stays ok when the anchor is absent and no chained row exists", async () => {
    // Distinguishes "never anchored" from ANCHOR_MISSING above — the count is
    // what separates them, so a regression dropping it fails here.
    mockQueryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0n }]);

    const { body } = await walk();

    expect(body.ok).toBe(true);
    expect(body.totalVerified).toBe(0);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // ─── Seed lookup: the allow half (RT10) ───────────────────

  it("seeds a partial walk from the preceding row's hash and verifies from there", async () => {
    // The deny half (seed row missing → 400) is covered above; this pins the
    // success leg, which re-seeds prevHash instead of starting from genesis.
    const full = buildChain([1, 2, 3]);
    mockQueryRawUnsafe
      .mockResolvedValueOnce([{ chain_seq: "3" }]) // anchor
      .mockResolvedValueOnce([{ chain_seq: "2" }]) // fromRows → fromSeq = 2
      .mockResolvedValueOnce([{ event_hash: full[0].event_hash }]) // seed = seq 1's hash
      .mockResolvedValueOnce(full.slice(1)); // rows 2..3

    const { body } = await walk({ from: "2026-01-01T00:00:00Z" });

    expect(body.ok).toBe(true);
    expect(body.totalVerified).toBe(2);
    expect(body.verifiedUpToSeq).toBe(3);
  });

  it("narrows the upper bound to the `to` parameter", async () => {
    const full = buildChain([1, 2, 3]);
    mockQueryRawUnsafe
      .mockResolvedValueOnce([{ chain_seq: "3" }]) // anchor
      .mockResolvedValueOnce([{ chain_seq: "2" }]) // toRows → toSeq = min(3, 2) = 2
      .mockResolvedValueOnce(full.slice(0, 2)); // rows 1..2

    const { body } = await walk({ to: "2026-06-01T00:00:00Z" });

    // Covered up to the narrowed bound, so this is ok despite seq 3 existing
    expect(body.ok).toBe(true);
    expect(body.reason).toBeUndefined();
    expect(body.totalVerified).toBe(2);
  });

  // ─── Audit on the walked path ─────────────────────────────

  it("emits one audit entry carrying the verdict for a walked chain", async () => {
    const rows = buildChain([1, 2, 3]);
    rows[2].event_hash = tamper(rows[2].event_hash);
    mockWalk(3, rows);

    await walk();

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit.mock.calls[0][0].metadata).toMatchObject({
      ok: false,
      reason: "TAMPER_DETECTED",
      totalVerified: 2,
      firstTamperedSeq: 3,
      targetTenantId: TENANT_ID,
    });
  });
  });
});
