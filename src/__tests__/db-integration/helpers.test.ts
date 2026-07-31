import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RETRYABLE_CLEANUP_SQLSTATES,
  isRetryableCleanupConflict,
  withCleanupConflictRetry,
  sweepLeakedTenants,
  runCleanupSweep,
  TenantClaimEventsPurgeError,
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

/**
 * QA-3: `sweepLeakedTenants` (the loop `sweepOutstandingTenants` runs) had
 * three defects — message-prefix keying, an early throw that abandoned the
 * rest of the sweep and the report with it, and a `cleanup()` with no
 * try/finally around the pool disconnects. A real tenant_claim_events purge
 * failure is a cross-process race that, like round-3 M4's deadlock retry,
 * does not happen on demand — so the mechanism is driven here with a
 * fabricated `deleteTestData`, never against the real routine or database.
 */
describe("sweepLeakedTenants", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns without calling deleteTestData when nothing leaked", async () => {
    const deleteTestData = vi.fn();
    await sweepLeakedTenants([], deleteTestData);
    expect(deleteTestData).not.toHaveBeenCalled();
  });

  it("sweeps every leaked tenant that deletes cleanly, without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deleted: string[] = [];
    const deleteTestData = vi.fn(async (id: string) => {
      deleted.push(id);
    });
    await sweepLeakedTenants(["a", "b", "c"], deleteTestData);
    expect(deleted).toEqual(["a", "b", "c"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("swept 3 leaked test tenant(s)"));
  });

  it(
    "an ordinary (non-purge) failure is reported as unresolved and does not abort the sweep or throw",
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const attempted: string[] = [];
      const deleteTestData = vi.fn(async (id: string) => {
        attempted.push(id);
        if (id === "b") throw new Error("FK ordering conflict");
      });
      await expect(sweepLeakedTenants(["a", "b", "c"], deleteTestData)).resolves.toBeUndefined();
      // Every leaked tenant was still attempted (QA-3b's property applies to
      // the ordinary path too — one failure must not skip the rest).
      expect(attempted).toEqual(["a", "b", "c"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could NOT delete 1 test tenant(s)"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("b (FK ordering conflict)"));
    },
  );

  it(
    "a TenantClaimEventsPurgeError does not abort the loop: every other leaked tenant is still attempted, the report is still printed, and the error is re-thrown only after the loop finishes (QA-3b)",
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const attempted: string[] = [];
      const deleteTestData = vi.fn(async (id: string) => {
        attempted.push(id);
        if (id === "a") throw new TenantClaimEventsPurgeError("tenant_claim_events purge failed for tenant a");
      });
      await expect(sweepLeakedTenants(["a", "b", "c"], deleteTestData)).rejects.toThrow(
        TenantClaimEventsPurgeError,
      );
      // The whole point: "b" and "c" were still attempted after "a" failed —
      // the old implementation threw immediately and never reached them.
      expect(attempted).toEqual(["a", "b", "c"]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("UNDELETABLE tenant_claim_events rows"),
      );
    },
  );

  it(
    "combines a fatal purge failure with an ordinary failure into one thrown AggregateError, and still names both in the printed report (QA-3b)",
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const deleteTestData = vi.fn(async (id: string) => {
        if (id === "a") throw new TenantClaimEventsPurgeError("tenant_claim_events purge failed for tenant a");
        if (id === "b") throw new TenantClaimEventsPurgeError("tenant_claim_events purge failed for tenant b");
      });
      let caught: unknown;
      try {
        await sweepLeakedTenants(["a", "b"], deleteTestData);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("purge failed for tenant a"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("purge failed for tenant b"));
    },
  );

  it(
    "keys the fatal path on the error CLASS, not on message text (QA-3a): a plain Error carrying the exact old wording is treated as an ordinary, non-fatal failure",
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const attempted: string[] = [];
      const deleteTestData = vi.fn(async (id: string) => {
        attempted.push(id);
        if (id === "a") {
          // Same text the real purge failure used to carry, deliberately
          // NOT a TenantClaimEventsPurgeError. Under the old string-prefix
          // match this would have aborted the sweep; it must not.
          throw new Error("tenant_claim_events purge failed for tenant a (undeletable rows may remain): x");
        }
      });
      await expect(sweepLeakedTenants(["a", "b"], deleteTestData)).resolves.toBeUndefined();
      expect(attempted).toEqual(["a", "b"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could NOT delete 1 test tenant(s)"));
    },
  );

  it(
    "cleanup() wraps the sweep in try/finally, so a sweep failure still disconnects every pool (QA-3c)",
    async () => {
      // Driving this through a real TestContext would need a live DB and a
      // real purge failure — the cross-process race this whole mechanism
      // exists for, which does not happen on demand. Driven instead through
      // runCleanupSweep, the extracted try/finally mechanism cleanup() calls,
      // with both the sweep and the disconnect fabricated at the boundary:
      // no real pool or database is touched.
      const disconnectAll = vi.fn(async () => {});
      const sweep = vi.fn(async () => {
        throw new Error("sweep failed");
      });
      await expect(runCleanupSweep(sweep, disconnectAll)).rejects.toThrow("sweep failed");
      expect(disconnectAll).toHaveBeenCalledTimes(1);
    },
  );
});
