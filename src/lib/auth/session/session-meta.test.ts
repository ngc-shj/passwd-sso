import { describe, expect, it } from "vitest";
import { sessionMetaStorage, type SessionMeta } from "./session-meta";

describe("sessionMetaStorage", () => {
  it("returns undefined outside of a run context", () => {
    expect(sessionMetaStorage.getStore()).toBeUndefined();
  });

  it("provides stored metadata inside a run context", () => {
    const meta: SessionMeta = {
      ip: "127.0.0.1",
      userAgent: "Mozilla/5.0",
      acceptLanguage: "en-US",
    };

    let captured: SessionMeta | undefined;
    sessionMetaStorage.run(meta, () => {
      captured = sessionMetaStorage.getStore();
    });

    expect(captured).toEqual(meta);
  });

  it("supports null values for all fields", () => {
    const meta: SessionMeta = {
      ip: null,
      userAgent: null,
      acceptLanguage: null,
    };

    let captured: SessionMeta | undefined;
    sessionMetaStorage.run(meta, () => {
      captured = sessionMetaStorage.getStore();
    });

    expect(captured).toEqual({ ip: null, userAgent: null, acceptLanguage: null });
  });

  it("isolates context between nested run calls", () => {
    const outer: SessionMeta = { ip: "1.1.1.1", userAgent: "outer", acceptLanguage: null };
    const inner: SessionMeta = { ip: "2.2.2.2", userAgent: "inner", acceptLanguage: null };

    let outerSeen: SessionMeta | undefined;
    let innerSeen: SessionMeta | undefined;

    sessionMetaStorage.run(outer, () => {
      sessionMetaStorage.run(inner, () => {
        innerSeen = sessionMetaStorage.getStore();
      });
      outerSeen = sessionMetaStorage.getStore();
    });

    expect(innerSeen?.ip).toBe("2.2.2.2");
    expect(outerSeen?.ip).toBe("1.1.1.1");
  });

  it("does not leak context after the run callback completes", () => {
    const meta: SessionMeta = { ip: "10.0.0.1", userAgent: "agent", acceptLanguage: "ja" };
    sessionMetaStorage.run(meta, () => {/* no-op */});
    expect(sessionMetaStorage.getStore()).toBeUndefined();
  });
});
