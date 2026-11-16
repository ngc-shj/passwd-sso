import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";

const { mockLogAuditInTx } = vi.hoisted(() => ({ mockLogAuditInTx: vi.fn() }));
vi.mock("@/lib/audit/audit", () => ({ logAuditInTx: mockLogAuditInTx }));
const { mockEndCreatorFootholds } = vi.hoisted(() => ({ mockEndCreatorFootholds: vi.fn() }));
vi.mock("@/lib/tenant/departure-footholds", () => ({ endCreatorFootholdsInTx: mockEndCreatorFootholds }));

import { departCreatedMembership, departFromTenant, returnToTenant } from "./team-departure";
import { createLockBudget } from "./team-key-rotation-lock";
import { userAuthLockKey } from "@/lib/auth/session/user-auth-serialization";

const TENANT = "tenant-1";
const USER = "user-1";
const ACTOR = { userId: "actor", actorType: "SYSTEM" as const, ip: null, userAgent: null };
const REVOKED_MODELS = [
  "extensionToken",
  "apiKey",
  "mcpAccessToken",
  "mcpRefreshToken",
  "delegationSession",
  "operatorToken",
  "extensionBridgeCode",
  "mobileBridgeCode",
  "mcpAuthorizationCode",
] as const;

/**
 * A transaction recording every raw statement in order. The departing user
 * transitions; `teams` are their active memberships of the tenant's teams.
 */
function departureTx(teams: string[]) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const record = (strings: TemplateStringsArray, values: unknown[]) => {
    const sql = strings.join("?");
    statements.push({ sql, values });
    return sql;
  };
  const updateMany = () => vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = record(strings, values);
      // departCreatedMembership's restamp: one row per created id.
      return sql.includes("UPDATE tenant_members") ? (values[1] as string[]).length : 0;
    }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = record(strings, values);
      if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: "0", statement_timeout: "0" }];
      if (sql.includes("UPDATE tenant_members")) return [{ user_id: USER }];
      if (sql.includes("SELECT DISTINCT team_id")) return teams.map((team_id) => ({ team_id }));
      if (sql.includes("FROM teams")) return teams.map((id) => ({ id }));
      if (sql.includes("UPDATE team_members")) return teams.map((team_id) => ({ team_id, user_id: USER }));
      return [];
    }),
    session: {
      findMany: vi.fn().mockResolvedValue([{ sessionToken: "digest-1" }]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    ...(Object.fromEntries(REVOKED_MODELS.map((model) => [model, { updateMany: updateMany() }])) as Record<
      (typeof REVOKED_MODELS)[number],
      { updateMany: ReturnType<typeof updateMany> }
    >),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, statements };
}

const userAuthLock = (statements: { sql: string; values: unknown[] }[]) =>
  statements.findIndex((s) => s.sql.includes("pg_advisory_xact_lock") && s.sql.includes("unnest"));

describe("departFromTenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The caller's transition budget is spent by the run's own work (directory
  // sync), so the revocation waits on a budget of its own (plan C1, F-R3-1).
  it("revokes with a spent transition budget when no budgeted lock precedes the revocation", async () => {
    const { tx, raw, statements } = departureTx([]);
    const spent = { deadline: Date.now() - 1 };

    const result = await departFromTenant(tx, TENANT, [USER], { actor: ACTOR, budget: spent, alreadyLocked: true });

    const lockAt = userAuthLock(statements);
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(statements[lockAt]!.values).toEqual([[userAuthLockKey(USER)]]);
    expect(raw.session.deleteMany).toHaveBeenCalledWith({ where: { userId: { in: [USER] }, tenantId: TENANT } });
    expect(result.userIds).toEqual([USER]);
    expect(result.revocation.sessionTokens).toEqual(["digest-1"]);
  });

  it("with a live budget and teams, ends the team memberships and then revokes, last", async () => {
    const { tx, raw, statements } = departureTx(["team-1"]);

    const result = await departFromTenant(tx, TENANT, [USER], {
      actor: ACTOR,
      budget: createLockBudget(),
      alreadyLocked: true,
    });

    const ended = statements.findIndex((s) => s.sql.includes("UPDATE team_members"));
    const lockAt = userAuthLock(statements);
    expect(ended).toBeGreaterThanOrEqual(0);
    // The credential lock after every row write of the departure.
    expect(lockAt).toBeGreaterThan(ended);
    expect(statements.findIndex((s) => s.sql.includes("FROM teams"))).toBeLessThan(lockAt);
    expect(raw.session.deleteMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockLogAuditInTx.mock.invocationCallOrder[0]!,
    );
    expect(result.revocation.counts).toMatchObject({ sessions: 1, operatorTokens: 1, mcpAuthorizationCodes: 1 });
  });

  it("revokes for exactly the transitioned users, in the tenant, with a bounded wait", async () => {
    const { tx, raw, statements } = departureTx([]);

    await departFromTenant(tx, TENANT, [USER, "user-already-inactive"], { actor: ACTOR, alreadyLocked: true });

    expect(statements[userAuthLock(statements)]!.values).toEqual([[userAuthLockKey(USER)]]);
    // Bounded: lock_timeout is set around the lock statement.
    expect(statements[userAuthLock(statements) - 1]!.sql).toContain("lock_timeout");
    expect(raw.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: [USER] }, revokedAt: null, tenantId: TENANT },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("revokes nothing when nobody transitions", async () => {
    const { tx, raw, statements } = departureTx([]);
    raw.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ sql: strings.join("?"), values });
      return [];
    });

    const result = await departFromTenant(tx, TENANT, [USER], { actor: ACTOR, alreadyLocked: true });

    expect(result.userIds).toEqual([]);
    expect(result.revocation.sessionTokens).toEqual([]);
    expect(userAuthLock(statements)).toBe(-1);
    expect(raw.session.deleteMany).not.toHaveBeenCalled();
  });

  it("ends the creator footholds of exactly the transitioned users, after the revocation", async () => {
    const { tx, raw } = departureTx([]);

    await departFromTenant(tx, TENANT, [USER, "user-already-inactive"], { actor: ACTOR, alreadyLocked: true });

    expect(mockEndCreatorFootholds).toHaveBeenCalledExactlyOnceWith(tx, TENANT, [USER], ACTOR);
    expect(mockEndCreatorFootholds.mock.invocationCallOrder[0]).toBeGreaterThan(
      raw.session.deleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("ends the footholds of no one when nobody transitions", async () => {
    const { tx, raw } = departureTx([]);
    raw.$queryRaw.mockImplementation(async () => []);

    await departFromTenant(tx, TENANT, [USER], { actor: ACTOR, alreadyLocked: true });

    expect(mockEndCreatorFootholds).toHaveBeenCalledExactlyOnceWith(tx, TENANT, [], ACTOR);
  });

  it("propagates a revocation failure", async () => {
    const { tx, raw } = departureTx([]);
    raw.session.deleteMany.mockRejectedValueOnce(new Error("revocation failed"));

    await expect(departFromTenant(tx, TENANT, [USER], { actor: ACTOR, alreadyLocked: true })).rejects.toThrow(
      "revocation failed",
    );
  });
});

describe("departCreatedMembership", () => {
  it("revokes what the created-deactivated user holds in the tenant, after ending their team memberships", async () => {
    const { tx, raw, statements } = departureTx(["team-1"]);

    const revocation = await departCreatedMembership(tx, TENANT, [USER], { actor: ACTOR, budget: createLockBudget() });

    expect(userAuthLock(statements)).toBeGreaterThan(statements.findIndex((s) => s.sql.includes("UPDATE team_members")));
    expect(raw.session.deleteMany).toHaveBeenCalledWith({ where: { userId: { in: [USER] }, tenantId: TENANT } });
    expect(revocation.sessionTokens).toEqual(["digest-1"]);
  });

  it("ends the creator footholds of the created users, after the revocation", async () => {
    const { tx, raw } = departureTx(["team-1"]);

    await departCreatedMembership(tx, TENANT, [USER], { actor: ACTOR, budget: createLockBudget() });

    expect(mockEndCreatorFootholds).toHaveBeenCalledExactlyOnceWith(tx, TENANT, [USER], ACTOR);
    expect(mockEndCreatorFootholds.mock.invocationCallOrder[0]).toBeGreaterThan(
      raw.session.deleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("makes no statement for no users", async () => {
    const { tx, raw } = departureTx([]);

    const revocation = await departCreatedMembership(tx, TENANT, [], { actor: ACTOR });
    expect(mockEndCreatorFootholds).not.toHaveBeenCalled();

    expect(raw.$executeRaw).not.toHaveBeenCalled();
    expect(raw.$queryRaw).not.toHaveBeenCalled();
    expect(revocation.sessionTokens).toEqual([]);
  });
});

// A return revokes what the user holds in the tenant: it was minted before the
// departure or without an active membership (code-review round-1 S1).
describe("returnToTenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revokes the returned users' credentials in the tenant, last, after restoring their team memberships", async () => {
    const { tx, raw, statements } = departureTx(["team-1"]);

    const result = await returnToTenant(tx, TENANT, [USER], {
      actor: ACTOR,
      budget: createLockBudget(),
      alreadyLocked: true,
    });

    const restored = statements.findIndex((s) => s.sql.includes("UPDATE team_members"));
    const lockAt = userAuthLock(statements);
    expect(restored).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeGreaterThan(restored);
    expect(statements[lockAt]!.values).toEqual([[userAuthLockKey(USER)]]);
    // Bounded: lock_timeout is set around the lock statement.
    expect(statements[lockAt - 1]!.sql).toContain("lock_timeout");
    expect(raw.session.deleteMany).toHaveBeenCalledWith({ where: { userId: { in: [USER] }, tenantId: TENANT } });
    expect(raw.session.deleteMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockLogAuditInTx.mock.invocationCallOrder[0]!,
    );
    expect(result.userIds).toEqual([USER]);
    expect(result.revocation.sessionTokens).toEqual(["digest-1"]);
    expect(result.revocation.counts).toMatchObject({ sessions: 1, apiKeys: 1, extensionTokens: 1 });
  });

  it("ends the creator footholds of the returned users, after the revocation", async () => {
    const { tx, raw } = departureTx(["team-1"]);

    await returnToTenant(tx, TENANT, [USER], { actor: ACTOR, budget: createLockBudget(), alreadyLocked: true });

    expect(mockEndCreatorFootholds).toHaveBeenCalledExactlyOnceWith(tx, TENANT, [USER], ACTOR);
    expect(mockEndCreatorFootholds.mock.invocationCallOrder[0]).toBeGreaterThan(
      raw.session.deleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("does not end creator footholds when nobody returns", async () => {
    const { tx, raw } = departureTx([]);
    raw.$queryRaw.mockImplementation(async () => []);

    await returnToTenant(tx, TENANT, [USER], { actor: ACTOR, alreadyLocked: true });

    expect(mockEndCreatorFootholds).not.toHaveBeenCalled();
  });

  it("revokes nothing when nobody returns", async () => {
    const { tx, raw, statements } = departureTx([]);
    raw.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ sql: strings.join("?"), values });
      return [];
    });

    const result = await returnToTenant(tx, TENANT, [USER], { actor: ACTOR, alreadyLocked: true });

    expect(result.userIds).toEqual([]);
    expect(result.revocation.sessionTokens).toEqual([]);
    expect(userAuthLock(statements)).toBe(-1);
    expect(raw.session.deleteMany).not.toHaveBeenCalled();
    expect(raw.apiKey.updateMany).not.toHaveBeenCalled();
  });

  it("makes no statement for no users", async () => {
    const { tx, raw } = departureTx([]);

    const result = await returnToTenant(tx, TENANT, [], { actor: ACTOR });

    expect(raw.$executeRaw).not.toHaveBeenCalled();
    expect(raw.$queryRaw).not.toHaveBeenCalled();
    expect(result).toEqual({ userIds: [], revocation: expect.objectContaining({ sessionTokens: [] }) });
  });
});
