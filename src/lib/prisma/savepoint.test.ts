import { describe, it, expect, vi } from "vitest";
import type { TxOrPrisma } from "@/lib/prisma";
import { attemptInSavepoint } from "./savepoint";

function fakeTx(failOn?: string) {
  const statements: string[] = [];
  const $executeRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join("");
    statements.push(sql);
    if (sql === failOn) throw new Error(`${sql} failed`);
    return 0;
  });
  return { db: { $executeRaw } as unknown as TxOrPrisma, statements };
}

describe("attemptInSavepoint", () => {
  it("releases the savepoint and returns the value when fn succeeds", async () => {
    const { db, statements } = fakeTx();
    const fn = vi.fn(async () => {
      statements.push("fn");
      return 42;
    });

    await expect(attemptInSavepoint(db, fn)).resolves.toEqual({ ok: true, value: 42 });
    expect(statements).toEqual([
      "SAVEPOINT attempt_in_savepoint",
      "fn",
      "RELEASE SAVEPOINT attempt_in_savepoint",
    ]);
  });

  it("rolls back to the savepoint opened before fn and returns fn's error", async () => {
    const { db, statements } = fakeTx();
    const error = new Error("P2002");
    const fn = async () => {
      statements.push("fn");
      throw error;
    };

    await expect(attemptInSavepoint(db, fn)).resolves.toEqual({ ok: false, error });
    expect(statements).toEqual([
      "SAVEPOINT attempt_in_savepoint",
      "fn",
      "ROLLBACK TO SAVEPOINT attempt_in_savepoint",
      "RELEASE SAVEPOINT attempt_in_savepoint",
    ]);
  });

  it("throws when the rollback itself fails, so the caller cannot continue on an aborted transaction", async () => {
    const { db } = fakeTx("ROLLBACK TO SAVEPOINT attempt_in_savepoint");
    const fnError = new Error("P2002");

    const thrown = await attemptInSavepoint(db, async () => {
      throw fnError;
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors as Error[];
    expect(errors[0]).toBe(fnError);
    expect(errors[1].message).toBe("ROLLBACK TO SAVEPOINT attempt_in_savepoint failed");
  });

  it("keeps fn's error when the release after a rollback fails", async () => {
    const { db } = fakeTx("RELEASE SAVEPOINT attempt_in_savepoint");
    const fnError = new Error("P2002");

    const thrown = await attemptInSavepoint(db, async () => {
      throw fnError;
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect((thrown as AggregateError).errors[0]).toBe(fnError);
  });

  it("rejects when fn succeeds but the release fails", async () => {
    const { db } = fakeTx("RELEASE SAVEPOINT attempt_in_savepoint");

    await expect(attemptInSavepoint(db, async () => 42)).rejects.toThrow(
      "RELEASE SAVEPOINT attempt_in_savepoint failed",
    );
  });

  it("does not run fn when the savepoint cannot be opened", async () => {
    const { db } = fakeTx("SAVEPOINT attempt_in_savepoint");
    const fn = vi.fn(async () => 1);

    await expect(attemptInSavepoint(db, fn)).rejects.toThrow("SAVEPOINT attempt_in_savepoint failed");
    expect(fn).not.toHaveBeenCalled();
  });
});
