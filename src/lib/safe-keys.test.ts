import { describe, expect, it } from "vitest";
import { safeSet } from "./safe-keys";
import { sanitizeMetadata } from "@/lib/audit";

describe("safeSet", () => {
  // Proto key guards (no-op, no pollution)

  it("__proto__ key is a no-op and does not pollute Object.prototype", () => {
    const obj: Record<string, unknown> = {};
    safeSet(obj, "__proto__", { polluted: true });
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.keys(obj)).not.toContain("__proto__");
  });

  it("constructor key is a no-op", () => {
    const obj: Record<string, unknown> = {};
    safeSet(obj, "constructor", "evil");
    expect(Object.keys(obj)).not.toContain("constructor");
  });

  it("prototype key is a no-op", () => {
    const obj: Record<string, unknown> = {};
    safeSet(obj, "prototype", "evil");
    expect(Object.keys(obj)).not.toContain("prototype");
  });

  // Normal operation

  it("sets a normal key with the given value and makes it enumerable", () => {
    const obj: Record<string, unknown> = {};
    safeSet(obj, "foo", "bar");
    expect(obj["foo"]).toBe("bar");
    expect(Object.keys(obj)).toContain("foo");
  });

  it("works on an Object.create(null) target", () => {
    const obj = Object.create(null) as Record<string, unknown>;
    safeSet(obj, "key", 42);
    expect(obj["key"]).toBe(42);
    expect(Object.keys(obj)).toContain("key");
  });

  it("overwrites an existing property", () => {
    const obj: Record<string, unknown> = { key: "old" };
    safeSet(obj, "key", "new");
    expect(obj["key"]).toBe("new");
  });

  it("handles undefined value — property is still defined and appears in Object.keys", () => {
    const obj: Record<string, unknown> = {};
    safeSet(obj, "undef", undefined);
    expect(Object.keys(obj)).toContain("undef");
    expect(obj["undef"]).toBeUndefined();
  });

  // Integration: sanitizeMetadata with __proto__ input

  it("sanitizeMetadata with __proto__ input returns only safe keys", () => {
    const input = { "__proto__": { polluted: true }, safe: "ok" };
    const result = sanitizeMetadata(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["safe"]);
    expect(result["safe"]).toBe("ok");
    expect(result["__proto__"]).toBeUndefined();
  });

  it("sanitizeMetadata does not pollute Object.prototype", () => {
    const input = { "__proto__": { polluted: true }, safe: "ok" };
    sanitizeMetadata(input);
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
