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

describe("errorLogFields — cause and independent degradation", () => {
  const E = (o: object, m = "boom") => Object.assign(new Error(m), o);

  it("reads a nested cause.code errno", () => {
    // undici puts the errno on `cause` and leaves the top level empty, so
    // `fetch failed` reduced to `{TypeError, unknown}` for every network fault.
    // That is the anchor-publisher's commonest failure — destination
    // unreachable — and the shape alerts.md promises an errno for.
    const undici = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    expect(errorLogFields(undici)).toEqual({ name: "TypeError", code: "ECONNREFUSED" });
  });

  it("prefers the top-level code over cause.code", () => {
    // The tie: Prisma's own code is the fault when it has one, and a cause
    // underneath it is transport detail. Boundary stated so the next reader
    // does not reorder the chain.
    expect(errorLogFields(E({ code: "P2028", cause: { code: "ENOTFOUND" } })).code)
      .toBe("P2028");
  });

  it("terminates on a self-referential cause chain", () => {
    // Exactly one level is read, so a cycle cannot hang the walk. A gate or a
    // logger that hangs reports nothing at all.
    const cyclic: { code?: string; cause?: unknown } = { code: undefined };
    cyclic.cause = cyclic;
    expect(errorLogFields(cyclic).code).toBe("unknown");
  });

  it("still resolves the code when the name getter throws", () => {
    // One try block over both reads let a hostile value suppress the SQLSTATE
    // this helper exists to surface by throwing from an unrelated accessor.
    const hostile = new Proxy(E({ code: "22P02" }), {
      get(t, p) {
        if (p === "name") throw new Error("boom");
        return Reflect.get(t, p);
      },
    });
    expect(errorLogFields(hostile)).toEqual({ name: "unknown", code: "22P02" });
  });

  it("still resolves the name when the code path throws", () => {
    // The mirror of the case above — neither field may depend on the other.
    // defineProperty, not Object.assign: assigning a getter INVOKES it, so the
    // fixture would throw during setup and test nothing.
    const hostile = new Error("x");
    Object.defineProperty(hostile, "code", {
      get() { throw new Error("boom"); },
      enumerable: true,
    });
    expect(errorLogFields(hostile)).toEqual({ name: "Error", code: "unknown" });
  });
});
