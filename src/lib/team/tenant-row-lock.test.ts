import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  departedSince,
  isMembershipLockConflict,
  lockTenantRows,
  TenantMemberLockTimeoutError,
} from "./tenant-row-lock";
import { createLockBudget, TeamRotationInProgressError } from "./team-key-rotation-lock";

/** A tx recording every raw statement in order, answering the row and record reads. */
function recordingTx(rows: { user_id: string; deactivated_at: Date | null }[] = [], records: { user_id: string; departed_at: Date }[] = []) {
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
      if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: "0", statement_timeout: "0" }];
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
      [{ user_id: "row", deactivated_at: stamp }],
      [{ user_id: "gone", departed_at: stamp }],
    );

    const result = await lockTenantRows(tx, "t", ["row", "gone"], "share");

    expect(result.get("row")).toEqual({ hasRow: true, deactivatedAt: stamp, departedAt: null });
    expect(result.get("gone")).toEqual({ hasRow: false, deactivatedAt: null, departedAt: stamp });
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

describe("departedSince", () => {
  const issued = new Date("2026-06-01T00:00:00.000Z");
  const row = (deactivatedAt: Date | null, departedAt: Date | null = null) => ({ hasRow: true, deactivatedAt, departedAt });

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
