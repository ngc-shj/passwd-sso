import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockTenantMemberFindFirst,
  mockWithBypassRls,
  mockLogAuditInTx,
  mockRealignOwningTenantColumn,
  mockCountStrandedRows,
} = vi.hoisted(() => {
  const mockTenantMemberFindFirst = vi.fn();
  const tx = { tenantMember: { findFirst: mockTenantMemberFindFirst } };
  return {
    mockTenantMemberFindFirst,
    mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: (tx: unknown) => unknown) => fn(tx)),
    mockLogAuditInTx: vi.fn(),
    mockRealignOwningTenantColumn: vi.fn(),
    mockCountStrandedRows: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/audit/audit", () => ({ logAuditInTx: mockLogAuditInTx }));
vi.mock("@/lib/tenant-context", () => ({
  realignOwningTenantColumn: mockRealignOwningTenantColumn,
  countStrandedRows: mockCountStrandedRows,
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { realignAfterActivation, realignToMembershipInTx } from "./tenant-realignment";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";

const USER_ID = "user-1";
const JOINED = "tenant-joined";
const RELEASED = "tenant-released";

describe("realignToMembershipInTx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCountStrandedRows.mockResolvedValue({ passwordEntry: 3 });
  });

  it("records nothing and counts nothing when the column already names the tenant", async () => {
    mockRealignOwningTenantColumn.mockResolvedValue(null);

    const previous = await realignToMembershipInTx({} as never, { userId: USER_ID, memberId: "m-1", tenantId: JOINED });

    expect(previous).toBeNull();
    expect(mockCountStrandedRows).not.toHaveBeenCalled();
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("moves the column and records the move for both tenants, naming the joined tenant only to itself", async () => {
    mockRealignOwningTenantColumn.mockResolvedValue(RELEASED);
    const tx = {};

    const previous = await realignToMembershipInTx(tx as never, { userId: USER_ID, memberId: "m-1", tenantId: JOINED });

    expect(previous).toBe(RELEASED);
    expect(mockCountStrandedRows).toHaveBeenCalledWith(tx, USER_ID, RELEASED);
    expect(mockLogAuditInTx).toHaveBeenCalledTimes(2);
    const [joined, released] = mockLogAuditInTx.mock.calls;
    expect(joined[0]).toBe(tx);
    expect(joined[1]).toBe(JOINED);
    expect(joined[2]).toMatchObject({
      action: "USER_TENANT_REALIGNED",
      targetId: "m-1",
      metadata: { previousTenantId: RELEASED, leftBehind: { passwordEntry: 3 } },
    });
    expect(released[1]).toBe(RELEASED);
    expect(JSON.stringify(released[2])).not.toContain(JOINED);
  });
});

describe("realignAfterActivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCountStrandedRows.mockResolvedValue({});
  });

  it("follows the membership only while it is still active in that tenant", async () => {
    mockTenantMemberFindFirst.mockResolvedValue(null);

    expect(await realignAfterActivation(USER_ID, JOINED)).toBeNull();

    expect(mockTenantMemberFindFirst).toHaveBeenCalledWith({
      where: { userId: USER_ID, tenantId: JOINED, deactivatedAt: null },
      select: { id: true },
    });
    expect(mockRealignOwningTenantColumn).not.toHaveBeenCalled();
  });

  it("realigns onto the active membership under its own bypass", async () => {
    mockTenantMemberFindFirst.mockResolvedValue({ id: "m-9" });
    mockRealignOwningTenantColumn.mockResolvedValue(RELEASED);

    expect(await realignAfterActivation(USER_ID, JOINED)).toBe(RELEASED);

    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
    );
    expect(mockRealignOwningTenantColumn).toHaveBeenCalledWith(expect.anything(), USER_ID, JOINED);
    expect(mockLogAuditInTx.mock.calls[0][2]).toMatchObject({ targetId: "m-9" });
  });
});
