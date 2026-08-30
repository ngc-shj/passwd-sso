import { describe, expect, it } from "vitest";
import { errorLogFields } from "./error-fields";

describe("errorLogFields", () => {
  it("keeps only a stable Error name and errno-style code", () => {
    const error = Object.assign(new TypeError("postgres://role:secret@db/internal"), {
      code: "ECONNREFUSED",
    });

    expect(errorLogFields(error)).toEqual({
      name: "TypeError",
      code: "ECONNREFUSED",
    });
    expect(errorLogFields(error)).not.toHaveProperty("message");
    expect(errorLogFields(error)).not.toHaveProperty("stack");
  });

  it("uses explicit unknown sentinels when no stable shape exists", () => {
    expect(errorLogFields("free-form failure text")).toEqual({
      name: "unknown",
      code: "unknown",
    });
  });

  it("rejects free-form custom names and codes", () => {
    const error = Object.assign(new Error("hidden message"), {
      name: "Error for tenant admin@example.com",
      code: "failed against db.internal.example",
    });

    expect(errorLogFields(error)).toEqual({
      name: "unknown",
      code: "unknown",
    });
  });

  it("does not throw when a caught value has a hostile code getter", () => {
    const error = new Error("original failure");
    Object.defineProperty(error, "code", {
      get() {
        throw new Error("getter failure");
      },
    });

    expect(errorLogFields(error)).toEqual({ name: "Error", code: "unknown" });
  });
});

describe("errorLogFields — driver SQLSTATE", () => {
  const wrap = (o: object, m = "boom") => Object.assign(new Error(m), o);

  /**
   * The top-level `code` on a Prisma raw-query failure is `P2010` — the
   * wrapper, not the fault. Reading it reports "raw query failed" for every SQL
   * error alike, which collapses the recovery procedure
   * docs/operations/alerts.md documents for `outbox.depth.check_failed`: tell
   * 22P02 (ran outside a bypass transaction — a bug) from P2028 (the aggregate
   * outgrew the transaction budget — a real backlog) by this field.
   */
  it.each([
    ["the pg adapter's nested shape", wrap({ code: "P2010", meta: { driverAdapterError: { cause: { code: "22P02" } } } })],
    ["P2010 with a flat meta.code", wrap({ code: "P2010", meta: { code: "22P02" } })],
    ["a SQLSTATE rendered into the message", new Error("Raw query failed. Code: `22P02`. Message: `x`")],
  ])("surfaces the driver SQLSTATE from %s", (_label, err) => {
    expect(errorLogFields(err).code).toBe("22P02");
  });

  it("keeps Prisma's own code when there is no driver error underneath", () => {
    // The allow side, and the other half of the documented pair: P2028 is a
    // transaction timeout with nothing nested, so it must survive unchanged.
    // A fix that reached only for SQLSTATEs would report `unknown` here.
    expect(errorLogFields(wrap({ code: "P2028" })).code).toBe("P2028");
  });

  it("keeps a plain Node errno", () => {
    expect(errorLogFields(wrap({ code: "ENOTFOUND" }, "getaddrinfo ENOTFOUND db.internal")).code)
      .toBe("ENOTFOUND");
  });

  it("does not throw when the meta chain has a hostile getter", () => {
    // pgErrorCode walks meta/cause, so the try/catch has to cover that walk and
    // not only the direct `code` read.
    expect(errorLogFields({ get meta() { throw new Error("boom"); } }))
      .toEqual({ name: "unknown", code: "unknown" });
  });
});
