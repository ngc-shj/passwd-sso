import { describe, expect, it, vi, afterEach } from "vitest";
import {
  RETRYABLE_CLEANUP_SQLSTATES,
  isRetryableCleanupConflict,
  withCleanupConflictRetry,
} from "./helpers";

/**
 * Round-3 M4's retry, proven directly.
 *
 * It exists for a race with the live audit-outbox worker, which by definition
 * does not happen on demand: six consecutive local suite runs never fired it,
 * so "the integration suite is green" says nothing about whether the retry
 * works. These cases drive the classifier and the loop with fabricated errors
 * of the exact shapes Postgres and the Prisma pg adapter produce, so the
 * mechanism is verified even on the runs where the race does not occur.
 *
 * A unit test, deliberately: this is the one part of the helper that is pure
 * control flow over an error value, and it needs no database.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** The `meta.driverAdapterError.cause.code` nesting the pg adapter produces. */
function adapterError(sqlstate: string): Error {
  const err = new Error("\nInvalid `prisma.$executeRaw()` invocation:\n\nRaw query failed.");
  Object.assign(err, {
    code: "P2010",
    meta: { driverAdapterError: { cause: { code: sqlstate } } },
  });
  return err;
}

/** The flatter shape where the SQLSTATE only appears in the message text. */
function messageError(sqlstate: string): Error {
  return new Error(`Raw query failed. Code: \`${sqlstate}\`. Message: \`deadlock detected\``);
}

describe("isRetryableCleanupConflict", () => {
  it.each(RETRYABLE_CLEANUP_SQLSTATES)("recognises %s carried in meta", (sqlstate) => {
    expect(isRetryableCleanupConflict(adapterError(sqlstate))).toBe(true);
  });

  it.each(RETRYABLE_CLEANUP_SQLSTATES)("recognises %s carried in the message", (sqlstate) => {
    expect(isRetryableCleanupConflict(messageError(sqlstate))).toBe(true);
  });

  it("names exactly the three transient conflicts, and no others", () => {
    // 23505 (unique_violation) and 42P01 (undefined_table) are permanent: a
    // retry would loop over the same failure and turn a clear error into a
    // slow one. Pinned so a future widening is a deliberate edit.
    expect([...RETRYABLE_CLEANUP_SQLSTATES]).toEqual(["40P01", "40001", "23503"]);
    for (const sqlstate of ["23505", "42P01", "22P02", "25P02"]) {
      expect(isRetryableCleanupConflict(adapterError(sqlstate))).toBe(false);
    }
  });

  it("does not treat an arbitrary error as retryable", () => {
    expect(isRetryableCleanupConflict(new Error("connection terminated"))).toBe(false);
    expect(isRetryableCleanupConflict("not an error at all")).toBe(false);
    expect(isRetryableCleanupConflict(undefined)).toBe(false);
  });

  it("survives a meta object that cannot be serialised", () => {
    const err = new Error("boom");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    Object.assign(err, { meta: circular });
    expect(() => isRetryableCleanupConflict(err)).not.toThrow();
  });
});

describe("withCleanupConflictRetry", () => {
  it("returns the value when the first attempt succeeds, without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    return withCleanupConflictRetry(async () => "done").then((result) => {
      expect(result).toBe("done");
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("retries a transient conflict and returns the later success", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    const result = await withCleanupConflictRetry(async () => {
      attempts++;
      if (attempts < 3) throw adapterError("40P01");
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
    // Announced, not silent: a green run that retried twice is a different
    // fact from a green run that never conflicted.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("rethrows a non-retryable error immediately, without retrying", async () => {
    let attempts = 0;
    await expect(
      withCleanupConflictRetry(async () => {
        attempts++;
        throw adapterError("23505");
      }),
    ).rejects.toThrow(/Raw query failed/);
    expect(attempts).toBe(1);
  });

  it("gives up after a bounded number of attempts rather than looping", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    await expect(
      withCleanupConflictRetry(async () => {
        attempts++;
        throw adapterError("23503");
      }),
    ).rejects.toThrow(/Raw query failed/);
    // A repeatable FK violation is a real ordering bug in deleteTestData's
    // delete list, and it has to surface as a failure — this is what stops
    // the retry from masking one.
    expect(attempts).toBe(4);
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
