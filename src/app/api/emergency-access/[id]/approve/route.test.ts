import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

// The tenant the approval's RLS context is opened on. A canonical, non-sentinel
// UUID because the REAL `withTenantRls` runs here (only `withBypassRls` is
// overridden below) and `assertOpenableTenantContext` refuses anything else.
const TENANT_ID = "11111111-1111-4111-8111-111111111111";

const {
  mockAuth,
  mockPrismaGrant,
  mockPrismaUser,
  mockSendEmail,
  mockWithUserTenantRls,
  mockWithBypassRls,
  mockResolveUserTenantId,
  mockLogAuditInTx,
  mockTransaction,
  mockExecuteRaw,
  mockTxClient,
} = vi.hoisted(() => {
  const grant = { findUnique: vi.fn(), updateMany: vi.fn() };
  const user = { findUnique: vi.fn() };
  const executeRaw = vi.fn();
  // The transaction client the real withTenantRls hands to the callback. It is
  // the SAME model spies as the top-level client, so `transition({ db: tx })`
  // drives `mockPrismaGrant.updateMany` exactly as it did before the route
  // switched from `db: prisma` to `db: tx`.
  const tx = { emergencyAccessGrant: grant, user, $executeRaw: executeRaw };
  return {
    mockAuth: vi.fn(),
    mockPrismaGrant: grant,
    mockPrismaUser: user,
    mockSendEmail: vi.fn(),
    mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
    mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (t: unknown) => unknown) => fn(prisma)),
    mockResolveUserTenantId: vi.fn(async () => TENANT_ID),
    mockLogAuditInTx: vi.fn(),
    mockTransaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    mockExecuteRaw: executeRaw,
    mockTxClient: tx,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emergencyAccessGrant: mockPrismaGrant,
    user: mockPrismaUser,
    $transaction: mockTransaction,
    $executeRaw: mockExecuteRaw,
  },
}));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: mockLogAuditInTx,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
// `resolveUserTenantId` is a plain spy, NOT an importOriginal spread: the real
// one opens its own withBypassRls, which would add a second call and break the
// `toHaveBeenCalledTimes(1)` assertions on the grantee lookup below.
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
  resolveUserTenantId: mockResolveUserTenantId,
}));
// Only `withBypassRls` is overridden. `withTenantRls` stays REAL, so the CAS and
// its audit row genuinely run inside a transaction callback — stubbing it as a
// passthrough would make C0's whole change unobservable here.
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { POST } from "./route";
import { EA_STATUS } from "@/lib/constants";

const requestedGrant = {
  id: "grant-1",
  ownerId: "owner-1",
  granteeId: "grantee-1",
  granteeEmail: "grantee@test.com",
  status: EA_STATUS.REQUESTED,
  waitDays: 7,
};

describe("POST /api/emergency-access/[id]/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "owner-1" } });
    mockPrismaGrant.findUnique.mockResolvedValue(requestedGrant);
    mockPrismaGrant.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaUser.findUnique.mockResolvedValue({ email: "grantee@test.com", name: "Grantee Name" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when grant not found", async () => {
    mockPrismaGrant.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when not owner", async () => {
    mockAuth.mockResolvedValue({ user: { id: "other-user" } });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when status CAS finds no eligible row (e.g. concurrent revoke)", async () => {
    // Simulates the race: findUnique sees REQUESTED, but by the time the CAS
    // updateMany runs, the row's status has moved out of the permitted from-set.
    mockPrismaGrant.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(400);
    // The CAS loser writes no activation row. Asserted here rather than only on
    // the success path because "emit on every path the CAS succeeded on" is one
    // half of the contract and "and on no path it did not" is the other.
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("approves successfully even when grantee user not found (deleted account)", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    expect(res.status).toBe(200);
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("approves REQUESTED grant successfully", async () => {
    const res = await POST(
      createRequest("POST", "http://localhost/api/emergency-access/grant-1/approve"),
      createParams({ id: "grant-1" })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe(EA_STATUS.ACTIVATED);
    expect(mockPrismaGrant.updateMany).toHaveBeenCalledWith({
      where: {
        id: "grant-1",
        ownerId: "owner-1",
        status: { in: expect.arrayContaining([EA_STATUS.REQUESTED]) },
      },
      data: {
        status: EA_STATUS.ACTIVATED,
        activatedAt: expect.any(Date),
      },
    });
    // The activation row is written INSIDE the CAS transaction, on the client
    // the real withTenantRls handed the callback and under the tenant the
    // context was opened on. Asserting the client identity is what distinguishes
    // an atomic emit from a post-commit one that happens to run afterwards.
    expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
    const [txArg, tenantArg, params] = mockLogAuditInTx.mock.calls[0];
    expect(txArg).toBe(mockTxClient);
    expect(tenantArg).toBe(TENANT_ID);
    expect(params).toMatchObject({
      action: "EMERGENCY_ACCESS_ACTIVATE",
      targetId: "grant-1",
      metadata: expect.objectContaining({ earlyApproval: true, outcome: "released" }),
    });
    // Cross-tenant grantee lookup uses withBypassRls — still exactly once, and
    // still OUTSIDE the transaction (a nested bypass would be refused).
    expect(mockWithBypassRls).toHaveBeenCalledTimes(1);
    // Sends approved email to grantee
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "grantee@test.com",
        subject: expect.stringContaining("approved"),
      })
    );
  });
});
