import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  departedSince,
  actorDepartedSinceAdmission,
  isMembershipLockConflict,
  lockTenantRows,
  readTenantRows,
  TenantMemberLockTimeoutError,
} from "./tenant-row-lock";
import { createLockBudget, TeamRotationInProgressError } from "./team-key-rotation-lock";

/** A tx recording every raw statement in order, answering the row and record reads. */
function recordingTx(rows: { user_id: string; role?: string; deactivated_at: Date | null }[] = [], timeouts = { lock_timeout: "0", statement_timeout: "0" }, records: { user_id: string; departed_at: Date }[] = []) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const record = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    statements.push(strings.join("?"));
    values.push(vals);
  };
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => { record(strings, ...vals); return 1; }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      record(strings, ...vals);
      const sql = strings.join("?");
      if (sql.includes("current_setting('lock_timeout')")) return [timeouts];
      if (sql.includes("FROM tenant_member_departures")) return records;
      if (sql.includes("FROM tenant_members")) return rows;
      return [];
    }),
  };
  return { tx: tx as unknown as Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">, raw: tx, statements, values };
}

describe("lockTenantRows", () => {
  it("takes every user's advisory lock in one ordered statement, in id order, before the row lock", async () => {
    // The advisory lock is what serialises a user with NO row yet with a
    // writer about to create one deactivated (lockTenantMemberCreation). One
    // statement: a large write must not spend its deadline on round trips.
    const { tx, statements, values } = recordingTx();

    await lockTenantRows(tx, "tenant-1", ["user-b", "user-a"], "share");

    const advisory = statements.flatMap((s, i) => (s.includes("pg_advisory_xact_lock") ? [{ sql: s, keys: values[i][0], at: i }] : []));
    expect(advisory).toHaveLength(1);
    expect(advisory[0].keys).toEqual(["tenant-member:tenant-1:user-a", "tenant-member:tenant-1:user-b"]);
    expect(advisory[0].sql).toMatch(/ORDER BY k/);
    const rowLock = statements.findIndex((s) => s.includes("FROM tenant_members"));
    expect(advisory[0].at).toBeLessThan(rowLock);
  });

  it("locks the rows in one ordered statement, FOR SHARE or FOR UPDATE by mode", async () => {
    const share = recordingTx();
    await lockTenantRows(share.tx, "t", ["u"], "share");
    expect(share.statements.find((s) => s.includes("FROM tenant_members"))).toMatch(/ORDER BY user_id FOR SHARE/);

    const update = recordingTx();
    await lockTenantRows(update.tx, "t", ["u"], "update");
    expect(update.statements.find((s) => s.includes("FROM tenant_members"))).toMatch(/ORDER BY user_id FOR UPDATE/);
  });

  it("reports a user with no row, a deactivated row, and a departure record", async () => {
    const stamp = new Date("2026-06-01T00:00:00Z");
    const { tx } = recordingTx(
      [{ user_id: "row", role: "MEMBER", deactivated_at: stamp }],
      undefined,
      [{ user_id: "gone", departed_at: stamp }],
    );

    const result = await lockTenantRows(tx, "t", ["row", "gone"], "share");

    expect(result.get("row")).toEqual({ hasRow: true, role: "MEMBER", deactivatedAt: stamp, departedAt: null });
    expect(result.get("gone")).toEqual({ hasRow: false, role: null, deactivatedAt: null, departedAt: stamp });
  });

  it("fails with the tenant-row error, before waiting, when the shared budget is spent", async () => {
    const { tx, raw } = recordingTx();
    const spent = { deadline: Date.now() - 1 };

    await expect(lockTenantRows(tx, "t", ["u"], "share", spent)).rejects.toBeInstanceOf(TenantMemberLockTimeoutError);
    // lock_timeout = 0 would mean "no limit": nothing was set.
    expect(raw.$executeRaw).not.toHaveBeenCalled();
  });

  it("bounds each wait by what is left of the shared budget", async () => {
    const { tx, statements, values } = recordingTx();

    await lockTenantRows(tx, "t", ["u"], "share", createLockBudget(500));

    const set = statements.flatMap((s, i) => (s.includes("set_config('lock_timeout'") ? [values[i][0]] : []));
    expect(set.length).toBeGreaterThan(0);
    for (const v of set.filter((x) => x !== "0")) expect(Number(String(v).replace("ms", ""))).toBeLessThanOrEqual(500);
  });
});

describe("readTenantRows", () => {
  const tx = (
    rows: { userId: string; role: string; deactivatedAt: Date | null }[],
    records: { userId: string; departedAt: Date }[],
  ) => ({
    tenantMember: { findMany: vi.fn().mockResolvedValue(rows) },
    tenantMemberDeparture: { findMany: vi.fn().mockResolvedValue(records) },
  });

  it("answers each user as lockTenantRows would: row, departure record, or neither", async () => {
    const left = new Date("2026-05-01T00:00:00.000Z");
    const recorded = new Date("2026-06-01T00:00:00.000Z");
    const t = tx(
      [{ userId: "a", role: "MEMBER", deactivatedAt: left }],
      [{ userId: "b", departedAt: recorded }],
    );

    const result = await readTenantRows(t as unknown as Pick<Prisma.TransactionClient, "tenantMember" | "tenantMemberDeparture">, "tenant-1", ["a", "b", "c"]);

    expect(result.get("a")).toEqual({ hasRow: true, role: "MEMBER", deactivatedAt: left, departedAt: null });
    expect(result.get("b")).toEqual({ hasRow: false, role: null, deactivatedAt: null, departedAt: recorded });
    expect(result.get("c")).toEqual({ hasRow: false, role: null, deactivatedAt: null, departedAt: null });
    expect(t.tenantMember.findMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", userId: { in: ["a", "b", "c"] } },
      select: { userId: true, role: true, deactivatedAt: true },
    });
  });

  it("matches a caller's upper-case id to the database's lower-case row, answering by the caller's spelling", async () => {
    const left = new Date("2026-05-01T00:00:00.000Z");
    const t = tx([{ userId: "abc", role: "MEMBER", deactivatedAt: left }], [{ userId: "abc", departedAt: left }]);

    const result = await readTenantRows(t as unknown as Pick<Prisma.TransactionClient, "tenantMember" | "tenantMemberDeparture">, "tenant-1", ["ABC"]);

    // A miss here would answer as a guest: not departed, so the check would pass.
    expect(result.get("ABC")).toEqual({ hasRow: true, role: "MEMBER", deactivatedAt: left, departedAt: left });
    expect(t.tenantMember.findMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", userId: { in: ["abc"] } },
      select: { userId: true, role: true, deactivatedAt: true },
    });
  });

  it("reads nothing for no users", async () => {
    const t = tx([], []);

    expect((await readTenantRows(t as unknown as Pick<Prisma.TransactionClient, "tenantMember" | "tenantMemberDeparture">, "tenant-1", [])).size).toBe(0);
    expect(t.tenantMember.findMany).not.toHaveBeenCalled();
  });
});

describe("departedSince", () => {
  const issued = new Date("2026-06-01T00:00:00.000Z");
  const row = (deactivatedAt: Date | null, departedAt: Date | null = null) => ({ hasRow: true, role: null, deactivatedAt, departedAt });

  it("is true for a departure at or after the invitation (equal refuses)", () => {
    expect(departedSince(row(new Date(issued.getTime() + 1)), issued)).toBe(true);
    expect(departedSince(row(issued), issued)).toBe(true);
  });

  it("is false for a departure before the invitation, or none", () => {
    expect(departedSince(row(new Date(issued.getTime() - 1)), issued)).toBe(false);
    expect(departedSince(row(null), issued)).toBe(false);
    expect(departedSince(undefined, issued)).toBe(false);
  });

  it("counts a SCIM DELETE record even when the row was re-created active", () => {
    expect(departedSince(row(null, new Date(issued.getTime() + 1)), issued)).toBe(true);
  });
});

describe("actorDepartedSinceAdmission", () => {
  const admitted = new Date("2026-06-01T00:00:00.000Z");
  const at = (ms: number) => new Date(admitted.getTime() + ms);
  const row = (deactivatedAt: Date | null, departedAt: Date | null = null) => ({ hasRow: true, role: null, deactivatedAt, departedAt });

  it("is false for a guest with no row or departure record", () => {
    expect(actorDepartedSinceAdmission(undefined, admitted)).toBe(false);
    expect(actorDepartedSinceAdmission({ hasRow: false, role: null, deactivatedAt: null, departedAt: null }, admitted)).toBe(false);
  });

  it("is false for an active row with no departure", () => {
    expect(actorDepartedSinceAdmission(row(null), admitted)).toBe(false);
  });

  it("is true for a departure after admission, and when equal", () => {
    expect(actorDepartedSinceAdmission(row(at(1)), admitted)).toBe(true);
    expect(actorDepartedSinceAdmission(row(admitted), admitted)).toBe(true);
  });

  it("is false when the actor was re-admitted after the departure (admittedAt later, not created_at)", () => {
    // created_at < departure < admitted_at: the caller passes the later admittedAt.
    const departure = at(-1000);
    expect(actorDepartedSinceAdmission(row(departure), admitted)).toBe(false);
    expect(actorDepartedSinceAdmission(row(departure), at(-2000))).toBe(true);
  });

  it("is false for a departure one millisecond before the admission (the nearest allow case)", () => {
    expect(actorDepartedSinceAdmission(row(at(-1)), admitted)).toBe(false);
  });

  it("is true for a deleted tenant row whose departure record follows the admission", () => {
    // SCIM DELETE residue: no tenant row, the team row kept. C3's SQL refuses the same state.
    expect(actorDepartedSinceAdmission({ hasRow: false, role: null, deactivatedAt: null, departedAt: at(1) }, admitted)).toBe(true);
  });

  it("is false for a re-provisioned active row whose old departure record predates the membership", () => {
    // departedAt() returns the record's stamp for an active row; admission is later, so it does not void.
    expect(actorDepartedSinceAdmission(row(null, at(-1000)), admitted)).toBe(false);
  });
});

describe("isMembershipLockConflict", () => {
  it("covers rotation, tenant-row timeouts, deadlocks and an expired transaction", () => {
    expect(isMembershipLockConflict(new TeamRotationInProgressError())).toBe(true);
    expect(isMembershipLockConflict(new TenantMemberLockTimeoutError())).toBe(true);
    expect(isMembershipLockConflict(Object.assign(new Error("deadlock"), { code: "40P01" }))).toBe(true);
    expect(isMembershipLockConflict(
      new Prisma.PrismaClientKnownRequestError("expired", { code: "P2028", clientVersion: "7" }),
    )).toBe(true);
  });

  it("does not cover other errors", () => {
    expect(isMembershipLockConflict(new Error("boom"))).toBe(false);
    expect(isMembershipLockConflict(Object.assign(new Error("unique"), { code: "23505" }))).toBe(false);
  });
});

describe("lockTenantRows — timeouts and id spelling", () => {
  it("bounds lock_timeout by the wait, statement_timeout by the wait plus slack, and restores both", async () => {
    const { tx, statements, values } = recordingTx([], { lock_timeout: "5s", statement_timeout: "30s" });

    await lockTenantRows(tx, "t", ["u"], "share", createLockBudget(500));

    const sets = statements.flatMap((s, i) => (s.includes("set_config('lock_timeout'") ? [values[i]] : []));
    const bounded = sets.filter((v) => v[0] !== "5s");
    const restored = sets.filter((v) => v[0] === "5s");
    expect(bounded.length).toBeGreaterThan(0);
    for (const [lockMs, statementMs] of bounded) {
      const lock = Number(String(lockMs).replace("ms", ""));
      const statement = Number(String(statementMs).replace("ms", ""));
      expect(lock).toBeLessThanOrEqual(500);
      // statement_timeout also counts execution: a little more than the wait.
      expect(statement).toBeGreaterThan(lock);
      expect(statement - lock).toBeLessThanOrEqual(250);
    }
    expect(restored.length).toBe(bounded.length);
    for (const v of restored) expect(v).toEqual(["5s", "30s"]);
  });

  it("refuses to restore a malformed timeout", async () => {
    const { tx } = recordingTx([], { lock_timeout: "5s; reset all", statement_timeout: "0" });

    await expect(lockTenantRows(tx, "t", ["u"], "share")).rejects.toThrow(/not a timeout value/);
  });

  it("answers by the caller's spelling of an id, matching the database's lowercase", async () => {
    const upper = "AAAAAAAA-0000-4000-8000-000000000001";
    const { tx, values, statements } = recordingTx([{ user_id: upper.toLowerCase(), role: "MEMBER", deactivated_at: null }]);

    const result = await lockTenantRows(tx, "t", [upper], "share");

    expect(result.get(upper)).toMatchObject({ hasRow: true, deactivatedAt: null });
    const rowLock = statements.findIndex((s) => s.includes("FROM tenant_members"));
    expect(values[rowLock][1]).toEqual([upper.toLowerCase()]);
  });
});
