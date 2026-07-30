import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("does not retry an unrelated error whose QUERY TEXT merely contains a SQLSTATE", () => {
    // Round-4 T10(b). `meta` carries the failing query and its bound
    // parameters, so a claim, slug or id containing "40001" would have made a
    // permanent failure look transient under the old substring match — and the
    // retry would then bury it behind four attempts and a warning.
    const err = new Error("Raw query failed. Code: `23505`.");
    Object.assign(err, {
      code: "P2010",
      meta: {
        driverAdapterError: { cause: { code: "23505" } },
        query: "DELETE FROM tenants WHERE external_id = $1",
        params: ["40001.example"],
      },
    });
    expect(isRetryableCleanupConflict(err)).toBe(false);
  });

  it("parses the SQLSTATE out of Prisma's `Code: \u0060…\u0060` message form", () => {
    // Round-5 T4: this used to be named "reads the SQLSTATE positionally" and
    // stayed green under the old substring classifier, because its fixture
    // answered `true` either way. The discriminating case is the sibling
    // above; this one covers the message-form parse, which is what its name
    // now says.
    const err = new Error("Raw query failed. Code: `23503`.");
    Object.assign(err, { code: "P2010", meta: { query: "…", params: [] } });
    expect(isRetryableCleanupConflict(err)).toBe(true);
  });

  it("ignores a retryable code that appears only in the query parameters", () => {
    // The half T4 said was never adjudicated: a non-retryable failure whose
    // BOUND PARAMETER happens to contain a retryable code — a claim, slug or
    // id like "40001.example" — must not be retried.
    const err = new Error("Raw query failed. Code: `42P01`.");
    Object.assign(err, { code: "P2010", meta: { query: "…", params: ["40001.example"] } });
    expect(isRetryableCleanupConflict(err)).toBe(false);
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

  it("is actually adopted by deleteTestData, its only production caller", () => {
    // Round-4 T10(a). Every case above proves the wrapper works; none proved
    // anything USES it. Unwrapping the one call site left this whole file
    // green while the flake it exists for came straight back — an R17
    // adoption gap, and the adoption is the entire point of the change.
    // Source-text, because the wrapper takes a thunk: no observable output of
    // `deleteTestData` differs between wrapped and unwrapped on the happy
    // path, and driving a real deadlock is not something a unit test can do.
    const source = readFileSync(resolve(__dirname, "helpers.ts"), "utf8");
    expect(source).toMatch(
      /async function deleteTestData\([^)]*\)[^{]*\{\s*await withCleanupConflictRetry\(/,
    );
  });
});
