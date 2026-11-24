import { describe, it, expect } from "vitest";
import { readNonEmptyStringField } from "./read-body-field";

describe("readNonEmptyStringField", () => {
  it("returns the string at the key", () => {
    expect(readNonEmptyStringField({ token: "tok-1", other: 1 }, "token")).toBe("tok-1");
  });

  it.each([
    ["an empty string", { token: "" }],
    ["a non-string value", { token: 42 }],
    ["a missing key", { other: "tok-1" }],
    ["an unreadable (null) body", null],
    ["a non-object body", "tok-1"],
  ])("returns null for %s", (_label, body) => {
    expect(readNonEmptyStringField(body, "token")).toBeNull();
  });
});
