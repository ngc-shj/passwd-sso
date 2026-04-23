import { describe, expect, it } from "vitest";
import { isProtoKey, safeRecord } from "./safe-keys";
import { sanitizeMetadata } from "@/lib/audit/audit";

describe("isProtoKey", () => {
  it.each(["__proto__", "constructor", "prototype"])(
    "returns true for %s",
    (key) => {
      expect(isProtoKey(key)).toBe(true);
    },
  );

  it.each(["name", "value", ""])(
    "returns false for normal key %j",
    (key) => {
      expect(isProtoKey(key)).toBe(false);
    },
  );

  it.each(["__proto", "Constructor", "PROTOTYPE", "proto__", "__prototype__"])(
    "returns false for similar-but-different string %s",
    (key) => {
      expect(isProtoKey(key)).toBe(false);
    },
  );
});

describe("safeRecord", () => {
  it("builds a record from entries", () => {
    const result = safeRecord([["a", 1], ["b", 2]]);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("skips __proto__ key", () => {
    const result = safeRecord([["__proto__", { polluted: true }], ["safe", "ok"]]);
    expect(Object.keys(result)).toEqual(["safe"]);
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("skips constructor and prototype keys", () => {
    const result = safeRecord([["constructor", "x"], ["prototype", "y"], ["ok", "z"]]);
    expect(Object.keys(result)).toEqual(["ok"]);
  });

  it("returns empty object for empty entries", () => {
    const result = safeRecord([]);
    expect(result).toEqual({});
  });

  it("handles entries with undefined values", () => {
    const result = safeRecord([["key", undefined]]);
    expect("key" in result).toBe(true);
    expect(result["key"]).toBeUndefined();
  });
});

describe("sanitizeMetadata integration", () => {
  it("strips __proto__ key from input", () => {
    const input = { "__proto__": { polluted: true }, safe: "ok" };
    const result = sanitizeMetadata(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["safe"]);
    expect(result["safe"]).toBe("ok");
  });

  it("does not pollute Object.prototype", () => {
    sanitizeMetadata({ "__proto__": { polluted: true }, safe: "ok" });
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
