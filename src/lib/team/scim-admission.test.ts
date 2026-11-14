import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { mockLockTenantRows, mockLockTeamsAgainstRotation, mockLogAuditInTx, tx } = vi.hoisted(() => ({
  mockLockTenantRows: vi.fn(),
  mockLockTeamsAgainstRotation: vi.fn(),
  mockLogAuditInTx: vi.fn(),
  tx: { teamMember: { findFirst: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() } },
}));

// Only lockTenantRows is replaced: the module must call the real predicates
// next to it (see the departed-actor tripwire below).
vi.mock("@/lib/team/tenant-row-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTenantRows: mockLockTenantRows,
}));
vi.mock("@/lib/team/team-key-rotation-lock", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  lockTeamsAgainstRotation: mockLockTeamsAgainstRotation,
}));
vi.mock("@/lib/audit/audit", () => ({ logAuditInTx: mockLogAuditInTx }));

import { approveScimPending, rejectScimPending } from "./scim-admission";
import { TEAM_ROLE } from "@/lib/constants";
import { SCIM_APPROVE_OUTCOME, SCIM_REJECT_OUTCOME } from "@/lib/constants/team/scim-admission";

const TENANT_ID = "tenant-1";
const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const M1 = "33333333-3333-4333-8333-333333333331";
const M2 = "33333333-3333-4333-8333-333333333332";
const M3 = "33333333-3333-4333-8333-333333333333";
const U1 = "44444444-4444-4444-8444-444444444441";
const U2 = "44444444-4444-4444-8444-444444444442";
const U3 = "44444444-4444-4444-8444-444444444443";

const ctx = { teamId: TEAM_ID, actorUserId: ACTOR_ID, ip: "127.0.0.1", userAgent: "test" };
const txArg = tx as never;

const activeTenantRow = { hasRow: true, role: null, deactivatedAt: null, departedAt: null };

type PendingRow = { role: string } | null;
let actorRow: Record<string, unknown> | null;
let pendingRows: Record<string, PendingRow>;

function setTenantRows(overrides: Record<string, unknown> = {}) {
  mockLockTenantRows.mockResolvedValue(new Map(Object.entries({
    [ACTOR_ID]: activeTenantRow,
    [U1]: activeTenantRow,
    [U2]: activeTenantRow,
    [U3]: activeTenantRow,
    ...overrides,
  })));
}

const approveTarget = (memberId: string, userId: string, expectedRole: "ADMIN" | "MEMBER" | "VIEWER" = TEAM_ROLE.MEMBER) =>
  ({ memberId, userId, expectedRole });

function noWrites() {
  expect(tx.teamMember.updateMany).not.toHaveBeenCalled();
  expect(tx.teamMember.deleteMany).not.toHaveBeenCalled();
  expect(mockLogAuditInTx).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  actorRow = { role: TEAM_ROLE.ADMIN, keyDistributed: true };
  pendingRows = { [M1]: { role: TEAM_ROLE.MEMBER }, [M2]: { role: TEAM_ROLE.MEMBER }, [M3]: { role: TEAM_ROLE.MEMBER } };
  setTenantRows();
  mockLockTeamsAgainstRotation.mockResolvedValue(undefined);
  mockLogAuditInTx.mockResolvedValue(undefined);
  // The actor read carries no `id` in its where; a target read does.
  // Like Prisma, return only the selected columns, so a read that forgets a
  // column it later uses gets undefined here too.
  tx.teamMember.findFirst.mockReset().mockImplementation(async (args: { where: { id?: string }; select?: Record<string, boolean> }) => {
    const row: Record<string, unknown> | null = args.where.id === undefined ? actorRow : (pendingRows[args.where.id] ?? null);
    if (row === null || args.select === undefined) return row;
    return Object.fromEntries(Object.entries(row).filter(([key]) => args.select![key] === true));
  });
  tx.teamMember.updateMany.mockReset().mockResolvedValue({ count: 1 });
  tx.teamMember.deleteMany.mockReset().mockResolvedValue({ count: 1 });
});

describe("approveScimPending", () => {
  it("returns null and writes nothing when the actor has no active row", async () => {
    actorRow = null;
    expect(await approveScimPending(txArg, TENANT_ID, ctx, [approveTarget(M1, U1)])).toBeNull();
    expect(tx.teamMember.findFirst).toHaveBeenCalledTimes(1);
    noWrites();
  });

  it("returns null and writes nothing when the actor lacks MEMBER_INVITE", async () => {
    actorRow = { role: TEAM_ROLE.MEMBER, keyDistributed: true };
    expect(await approveScimPending(txArg, TENANT_ID, ctx, [approveTarget(M1, U1)])).toBeNull();
    noWrites();
  });

  it("returns null and writes nothing when the actor does not hold the key", async () => {
    actorRow = { role: TEAM_ROLE.ADMIN, keyDistributed: false };
    expect(await approveScimPending(txArg, TENANT_ID, ctx, [approveTarget(M1, U1)])).toBeNull();
    noWrites();
  });

  it("takes one tenant-row lock over the actor and every target user, then the team, before any read", async () => {
    await approveScimPending(txArg, TENANT_ID, ctx, [approveTarget(M1, U1), approveTarget(M2, U2)]);

    expect(mockLockTenantRows).toHaveBeenCalledTimes(1);
    expect(mockLockTenantRows).toHaveBeenCalledWith(txArg, TENANT_ID, [ACTOR_ID, U1, U2], "share", expect.anything());
    expect(mockLockTeamsAgainstRotation).toHaveBeenCalledWith(txArg, [TEAM_ID], expect.anything());
    expect(mockLockTenantRows.mock.invocationCallOrder[0]).toBeLessThan(mockLockTeamsAgainstRotation.mock.invocationCallOrder[0]);
    expect(mockLockTeamsAgainstRotation.mock.invocationCallOrder[0]).toBeLessThan(tx.teamMember.findFirst.mock.invocationCallOrder[0]);
  });

  it("admits a target with the CAS and audits it, without batchId when none is given", async () => {
    const outcomes = await approveScimPending(txArg, TENANT_ID, ctx, [approveTarget(M1, U1)]);

    expect(outcomes).toEqual(new Map([[M1, SCIM_APPROVE_OUTCOME.APPROVED]]));
    expect(tx.teamMember.findFirst).toHaveBeenCalledWith({
      where: { id: M1, teamId: TEAM_ID, userId: U1, scimApprovalPending: true },
      select: { role: true },
    });
    expect(tx.teamMember.updateMany).toHaveBeenCalledWith({
      where: { id: M1, teamId: TEAM_ID, role: TEAM_ROLE.MEMBER, scimApprovalPending: true, deactivatedAt: { not: null } },
      data: { deactivatedAt: null, scimApprovalPending: false, keyDistributed: false },
    });
    expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
    expect(mockLogAuditInTx).toHaveBeenCalledWith(txArg, TENANT_ID, {
      scope: "TEAM",
      action: "TEAM_MEMBER_SCIM_APPROVE",
      userId: ACTOR_ID,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      targetType: "TeamMember",
      targetId: U1,
      metadata: { memberId: M1, role: TEAM_ROLE.MEMBER },
      ip: "127.0.0.1",
      userAgent: "test",
    });
    expect(Object.keys(mockLogAuditInTx.mock.calls[0][2].metadata)).toEqual(["memberId", "role"]);
  });

  it("copies batchId into each audit row's metadata when the context carries one", async () => {
    pendingRows[M2] = { role: TEAM_ROLE.ADMIN };

    await approveScimPending(txArg, TENANT_ID, { ...ctx, batchId: "batch-1" }, [
      approveTarget(M1, U1),
      approveTarget(M2, U2, TEAM_ROLE.ADMIN),
    ]);

    expect(mockLogAuditInTx.mock.calls.map((c) => c[2].metadata)).toEqual([
      { memberId: M1, role: TEAM_ROLE.MEMBER, batchId: "batch-1" },
      { memberId: M2, role: TEAM_ROLE.ADMIN, batchId: "batch-1" },
    ]);
  });

  it("reports one outcome per target and a refused target does not stop the later ones", async () => {
    pendingRows[M1] = null; // withdrawn
    pendingRows[M2] = { role: TEAM_ROLE.ADMIN }; // raised since the page loaded
    const m4 = "33333333-3333-4333-8333-333333333334";
    const u4 = "44444444-4444-4444-8444-444444444444";
    pendingRows[m4] = { role: TEAM_ROLE.VIEWER };
    setTenantRows({
      [U3]: { hasRow: true, role: null, deactivatedAt: new Date(), departedAt: null },
      [u4]: activeTenantRow,
    });

    const outcomes = await approveScimPending(txArg, TENANT_ID, ctx, [
      approveTarget(M1, U1),
      approveTarget(M2, U2),
      approveTarget(M3, U3),
      approveTarget(m4, u4, TEAM_ROLE.VIEWER),
    ]);

    expect(outcomes).toEqual(new Map([
      [M1, SCIM_APPROVE_OUTCOME.NOT_FOUND],
      [M2, SCIM_APPROVE_OUTCOME.ROLE_CHANGED],
      [M3, SCIM_APPROVE_OUTCOME.TENANT_INACTIVE],
      [m4, SCIM_APPROVE_OUTCOME.APPROVED],
    ]));
    expect(tx.teamMember.updateMany).toHaveBeenCalledTimes(1);
    expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
    expect(mockLogAuditInTx.mock.calls[0][2].targetId).toBe(u4);
  });

  it("answers NOT_FOUND, not ROLE_CHANGED, for a row that is both missing and asked with another role", async () => {
    pendingRows[M1] = null;
    const outcomes = await approveScimPending(txArg, TENANT_ID, ctx, [approveTarget(M1, U1, TEAM_ROLE.ADMIN)]);
    expect(outcomes?.get(M1)).toBe(SCIM_APPROVE_OUTCOME.NOT_FOUND);
    noWrites();
  });

  it("answers ROLE_CHANGED, not TENANT_INACTIVE, for a stale role on a departed target", async () => {
    pendingRows[M1] = { role: TEAM_ROLE.ADMIN };
    setTenantRows({ [U1]: { hasRow: true, role: null, deactivatedAt: new Date(), departedAt: null } });
    const outcomes = await approveScimPending(txArg, TENANT_ID, ctx, [approveTarget(M1, U1)]);
    expect(outcomes?.get(M1)).toBe(SCIM_APPROVE_OUTCOME.ROLE_CHANGED);
    noWrites();
  });

  it("answers TENANT_INACTIVE for a target with no tenant row", async () => {
    setTenantRows({ [U1]: { hasRow: false, role: null, deactivatedAt: null, departedAt: null } });
    const outcomes = await approveScimPending(txArg, TENANT_ID, ctx, [approveTarget(M1, U1)]);
    expect(outcomes?.get(M1)).toBe(SCIM_APPROVE_OUTCOME.TENANT_INACTIVE);
    noWrites();
  });

  it("answers CAS_FAILED and writes no audit row when the CAS matches no row", async () => {
    tx.teamMember.updateMany.mockResolvedValue({ count: 0 });
    const outcomes = await approveScimPending(txArg, TENANT_ID, ctx, [approveTarget(M1, U1)]);
    expect(outcomes?.get(M1)).toBe(SCIM_APPROVE_OUTCOME.CAS_FAILED);
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("propagates a rejection of the audit write on the k-th target instead of returning outcomes", async () => {
    mockLogAuditInTx.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("audit down"));
    await expect(approveScimPending(txArg, TENANT_ID, ctx, [
      approveTarget(M1, U1),
      approveTarget(M2, U2),
      approveTarget(M3, U3),
    ])).rejects.toThrow("audit down");
  });

  it("propagates a lock failure without reading anything", async () => {
    mockLockTeamsAgainstRotation.mockRejectedValue(new Error("lock timeout"));
    await expect(approveScimPending(txArg, TENANT_ID, ctx, [approveTarget(M1, U1)])).rejects.toThrow("lock timeout");
    expect(tx.teamMember.findFirst).not.toHaveBeenCalled();
  });
});

describe("rejectScimPending", () => {
  const rejectTarget = (memberId: string, userId: string) => ({ memberId, userId });

  beforeEach(() => {
    actorRow = { role: TEAM_ROLE.ADMIN };
  });

  it("returns null and writes nothing when the actor has no active row", async () => {
    actorRow = null;
    expect(await rejectScimPending(txArg, TENANT_ID, ctx, [rejectTarget(M1, U1)])).toBeNull();
    noWrites();
  });

  it("returns null and writes nothing when the actor lacks MEMBER_INVITE", async () => {
    actorRow = { role: TEAM_ROLE.MEMBER };
    expect(await rejectScimPending(txArg, TENANT_ID, ctx, [rejectTarget(M1, U1)])).toBeNull();
    noWrites();
  });

  it("takes one tenant-row lock over the actor and every target user, then the team", async () => {
    await rejectScimPending(txArg, TENANT_ID, ctx, [rejectTarget(M1, U1), rejectTarget(M2, U2)]);

    expect(mockLockTenantRows).toHaveBeenCalledTimes(1);
    expect(mockLockTenantRows).toHaveBeenCalledWith(txArg, TENANT_ID, [ACTOR_ID, U1, U2], "share", expect.anything());
    expect(mockLockTenantRows.mock.invocationCallOrder[0]).toBeLessThan(mockLockTeamsAgainstRotation.mock.invocationCallOrder[0]);
  });

  it("rejects without the key requirement and audits the role read under the lock", async () => {
    pendingRows[M1] = { role: TEAM_ROLE.ADMIN };

    const outcomes = await rejectScimPending(txArg, TENANT_ID, ctx, [rejectTarget(M1, U1)]);

    expect(outcomes).toEqual(new Map([[M1, SCIM_REJECT_OUTCOME.REJECTED]]));
    expect(tx.teamMember.deleteMany).toHaveBeenCalledWith({
      where: { id: M1, teamId: TEAM_ID, scimApprovalPending: true },
    });
    expect(mockLogAuditInTx).toHaveBeenCalledWith(txArg, TENANT_ID, {
      scope: "TEAM",
      action: "TEAM_MEMBER_SCIM_REJECT",
      userId: ACTOR_ID,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      targetType: "TeamMember",
      targetId: U1,
      metadata: { memberId: M1, role: TEAM_ROLE.ADMIN },
      ip: "127.0.0.1",
      userAgent: "test",
    });
    expect(Object.keys(mockLogAuditInTx.mock.calls[0][2].metadata)).toEqual(["memberId", "role"]);
  });

  it("adds batchId to the audit metadata only when the context carries one", async () => {
    await rejectScimPending(txArg, TENANT_ID, { ...ctx, batchId: "batch-1" }, [rejectTarget(M1, U1)]);
    expect(mockLogAuditInTx.mock.calls[0][2].metadata).toEqual({ memberId: M1, role: TEAM_ROLE.MEMBER, batchId: "batch-1" });
  });

  it("answers NOT_FOUND for a row no longer pending and still rejects the later ones", async () => {
    pendingRows[M1] = null;

    const outcomes = await rejectScimPending(txArg, TENANT_ID, ctx, [rejectTarget(M1, U1), rejectTarget(M2, U2)]);

    expect(outcomes).toEqual(new Map([
      [M1, SCIM_REJECT_OUTCOME.NOT_FOUND],
      [M2, SCIM_REJECT_OUTCOME.REJECTED],
    ]));
    expect(tx.teamMember.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockLogAuditInTx).toHaveBeenCalledTimes(1);
  });

  it("answers NOT_FOUND and writes no audit row when the delete matches no row", async () => {
    tx.teamMember.deleteMany.mockResolvedValue({ count: 0 });
    const outcomes = await rejectScimPending(txArg, TENANT_ID, ctx, [rejectTarget(M1, U1)]);
    expect(outcomes?.get(M1)).toBe(SCIM_REJECT_OUTCOME.NOT_FOUND);
    expect(mockLogAuditInTx).not.toHaveBeenCalled();
  });

  it("propagates a rejection of the audit write on the k-th target", async () => {
    mockLogAuditInTx.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("audit down"));
    await expect(rejectScimPending(txArg, TENANT_ID, ctx, [
      rejectTarget(M1, U1),
      rejectTarget(M2, U2),
    ])).rejects.toThrow("audit down");
  });
});

// Departed-actor tripwire (scim-bulk-approve-plan.md C8). The departed-member
// authority check (actorDepartedSinceAdmission + TeamMember.admittedAt) is not
// on every branch; whichever branch merges second must carry the condition in
// approveScimPending's actor check, and this goes red until it does.
const tenantRowLockActual = await vi.importActual<Record<string, unknown>>("@/lib/team/tenant-row-lock");

const SCHEMA_PATH = fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url));

function teamMemberModelFields(): string[] {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const block = /^model TeamMember \{([\s\S]*?)^\}/m.exec(schema);
  if (!block) throw new Error(`model TeamMember not found in ${SCHEMA_PATH}`);
  return block[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("@@"))
    .map((line) => line.split(/\s+/)[0]);
}

const teamMemberFields = teamMemberModelFields();
const hasDepartedActorCheck =
  typeof tenantRowLockActual.actorDepartedSinceAdmission === "function" || teamMemberFields.includes("admittedAt");

describe("departed-actor tripwire", () => {
  it("reads the TeamMember model block of the schema", () => {
    expect(teamMemberFields).toContain("scimApprovalPending");
  });

  describe("departed-actor condition in the actor check", () => {
    const ADMITTED = new Date("2026-03-01T00:00:00.000Z");
    const BEFORE = new Date("2026-02-01T00:00:00.000Z");
    const AFTER = new Date("2026-04-01T00:00:00.000Z");

    function actorDeparted(departedAt: Date, admittedAt: Date | null, createdAt: Date) {
      actorRow = { role: TEAM_ROLE.ADMIN, keyDistributed: true, admittedAt, createdAt };
      setTenantRows({ [ACTOR_ID]: { hasRow: true, role: null, deactivatedAt: null, departedAt: departedAt } });
    }

    async function approveOne() {
      return approveScimPending(txArg, TENANT_ID, ctx, [approveTarget(M1, U1)]);
    }

    it.runIf(hasDepartedActorCheck)("refuses an actor whose tenant departure equals their admission time", async () => {
      actorDeparted(ADMITTED, ADMITTED, BEFORE);
      expect(await approveOne()).toBeNull();
      noWrites();
    });

    it.runIf(hasDepartedActorCheck)("refuses an actor who departed after their admission", async () => {
      actorDeparted(AFTER, ADMITTED, BEFORE);
      expect(await approveOne()).toBeNull();
      noWrites();
    });

    it.runIf(hasDepartedActorCheck)("refuses an actor with no admittedAt whose createdAt precedes the departure", async () => {
      actorDeparted(ADMITTED, null, BEFORE);
      expect(await approveOne()).toBeNull();
      noWrites();
    });

    it.runIf(hasDepartedActorCheck)("admits for an actor re-admitted after the departure", async () => {
      actorDeparted(BEFORE, AFTER, BEFORE);
      expect((await approveOne())?.get(M1)).toBe(SCIM_APPROVE_OUTCOME.APPROVED);
    });

    it.runIf(!hasDepartedActorCheck)("is pending: neither the predicate nor the admittedAt column exists yet", () => {
      expect(typeof tenantRowLockActual.actorDepartedSinceAdmission).not.toBe("function");
      expect(teamMemberFields).not.toContain("admittedAt");
    });
  });
});
