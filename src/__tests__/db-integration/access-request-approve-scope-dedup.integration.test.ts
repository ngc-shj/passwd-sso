/**
 * Real-DB integration test for C5 (CF16) — the approval-time scope dedup.
 *
 * `parseSaTokenScopes` (service-account-token.ts) is the adjudicator consulted
 * inside the approve route's transaction, AFTER the request has already been
 * flipped to APPROVED. Without its dedup, a `requested_scope` CSV containing
 * repeated scopes re-joins past `service_account_tokens.scope`'s
 * VarChar(1024) and the INSERT's 22001 rolls back the whole transaction —
 * including the APPROVED transition — leaving the request permanently stuck
 * PENDING. This drives the real create + approve route handlers against a
 * real Postgres to prove both the ordinary (ingress-bounded) path and the
 * pathological (pre-existing, duplicate-laden) path approve successfully.
 *
 * Auth boundary mocked (precedent: reauth-credential-binding.integration.test.ts,
 * team-rotate-key.integration.test.ts); prisma, RLS, and the VarChar(1024)
 * constraint are real.
 *
 * Run:
 *   docker compose stop audit-outbox-worker retention-gc-worker
 *   npm run test:integration -- access-request-approve-scope-dedup
 *   docker compose start audit-outbox-worker retention-gc-worker
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
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import {
  createRequest,
  createParams,
  parseResponse,
} from "@/__tests__/helpers/request-builder";
import { SA_TOKEN_SCOPE, SA_TOKEN_SCOPES } from "@/lib/constants/auth/service-account";

const hasDatabase = !!process.env.DATABASE_URL;

// ── Auth boundary + supporting gates mocked; everything downstream
// (Prisma, tenant-context RLS transactions, the DB column width) is real.
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));

import { POST as createAccessRequest } from "@/app/api/tenant/access-requests/route";
import { POST as approveAccessRequest } from "@/app/api/tenant/access-requests/[id]/approve/route";

describe.skipIf(!hasDatabase)("access-request approve: scope dedup (real DB)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let creatorId: string;
  let approverId: string;
  let saId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    // Two distinct OWNER members: the approve route rejects an approver who
    // is also the request's own creator (self-approval guard, C8).
    creatorId = await ctx.createUser(tenantId);
    approverId = await ctx.createUser(tenantId);
    saId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO service_accounts (id, tenant_id, name, created_by_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, now(), now())`,
        saId,
        tenantId,
        `dedup-test-sa-${saId.slice(0, 8)}`,
        creatorId,
      );
    });
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  it("approves a maximum-size request (full SA_TOKEN_SCOPES set) created through the bounded ingress", async () => {
    mockAuth.mockResolvedValue({ user: { id: creatorId } });
    const createReq = createRequest("POST", "http://localhost/api/tenant/access-requests", {
      body: { serviceAccountId: saId, requestedScope: [...SA_TOKEN_SCOPES] },
    });
    const createRes = await createAccessRequest(createReq);
    const { status: createStatus, json: created } = await parseResponse(createRes);
    expect(createStatus).toBe(201);
    expect(created.requestedScope).toBe(SA_TOKEN_SCOPES.join(","));

    mockAuth.mockResolvedValue({ user: { id: approverId } });
    const approveReq = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${created.id}/approve`,
    );
    const approveRes = await approveAccessRequest(approveReq, createParams({ id: created.id }));
    const { status: approveStatus, json: approved } = await parseResponse(approveRes);
    expect(approveStatus).toBe(200);
    expect(typeof approved.token).toBe("string");

    const token = await ctx.su.prisma.serviceAccountToken.findFirst({
      where: { serviceAccountId: saId },
    });
    expect(token?.scope).toBe(SA_TOKEN_SCOPES.join(","));
    expect(token!.scope.length).toBeLessThan(1024);

    const request = await ctx.su.prisma.accessRequest.findUnique({ where: { id: created.id } });
    expect(request?.status).toBe("APPROVED");
  });

  it("approves a PENDING row seeded with 200 repetitions of one legal scope, via the parseSaTokenScopes dedup", async () => {
    const repeated = Array(200).fill(SA_TOKEN_SCOPE.PASSWORDS_READ).join(",");
    // The un-deduped join already exceeds service_account_tokens.scope's
    // VarChar(1024) — this is the shape that rolls back the approval
    // transition without the parseSaTokenScopes dedup (CF16).
    expect(repeated.length).toBeGreaterThan(1024);

    const reqId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO access_requests
           (id, tenant_id, service_account_id, requested_scope, status, requester_user_id, expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'PENDING', $5::uuid, now() + interval '1 hour', now())`,
        reqId,
        tenantId,
        saId,
        repeated,
        creatorId,
      );
    });

    mockAuth.mockResolvedValue({ user: { id: approverId } });
    const approveReq = createRequest(
      "POST",
      `http://localhost/api/tenant/access-requests/${reqId}/approve`,
    );
    const approveRes = await approveAccessRequest(approveReq, createParams({ id: reqId }));
    const { status, json } = await parseResponse(approveRes);

    expect(status).toBe(200);
    expect(typeof json.token).toBe("string");

    const token = await ctx.su.prisma.serviceAccountToken.findFirst({
      where: { serviceAccountId: saId },
    });
    expect(token?.scope).toBe(SA_TOKEN_SCOPE.PASSWORDS_READ);

    const request = await ctx.su.prisma.accessRequest.findUnique({ where: { id: reqId } });
    expect(request?.status).toBe("APPROVED");
  });
});
