import { describe, it, expect } from "vitest";
import {
  parseUserPatchOps,
  parseGroupPatchOps,
  PatchParseError,
} from "./patch-parser";

describe("parseUserPatchOps", () => {
  it("parses active=false replace", () => {
    const result = parseUserPatchOps([
      { op: "replace", path: "active", value: false },
    ]);
    expect(result).toEqual({ active: false });
  });

  it("parses active=true replace", () => {
    const result = parseUserPatchOps([
      { op: "replace", path: "active", value: true },
    ]);
    expect(result).toEqual({ active: true });
  });

  it("parses name.formatted add", () => {
    const result = parseUserPatchOps([
      { op: "add", path: "name.formatted", value: "John Doe" },
    ]);
    expect(result).toEqual({ name: "John Doe" });
  });

  it("parses object-form value (no path)", () => {
    const result = parseUserPatchOps([
      {
        op: "replace",
        value: { active: false, name: { formatted: "Test" } },
      },
    ]);
    expect(result).toEqual({ active: false, name: "Test" });
  });

  it("rejects remove op for User", () => {
    expect(() =>
      parseUserPatchOps([{ op: "remove", path: "active" }]),
    ).toThrow(PatchParseError);
  });

  it("rejects unsupported path", () => {
    expect(() =>
      parseUserPatchOps([
        { op: "replace", path: "emails", value: "test" },
      ]),
    ).toThrow(PatchParseError);
  });

  it("rejects non-boolean active", () => {
    expect(() =>
      parseUserPatchOps([
        { op: "replace", path: "active", value: "false" },
      ]),
    ).toThrow(PatchParseError);
  });
});

describe("parseGroupPatchOps", () => {
  it("parses add members", () => {
    const result = parseGroupPatchOps([
      {
        op: "add",
        path: "members",
        value: [{ value: "user-1" }, { value: "user-2" }],
      },
    ]);
    expect(result).toEqual([
      { op: "add", userId: "user-1" },
      { op: "add", userId: "user-2" },
    ]);
  });

  it("parses remove members", () => {
    const result = parseGroupPatchOps([
      {
        op: "remove",
        path: "members",
        value: [{ value: "user-1" }],
      },
    ]);
    expect(result).toEqual([{ op: "remove", userId: "user-1" }]);
  });

  it("parses Azure AD style remove (path filter)", () => {
    const result = parseGroupPatchOps([
      {
        op: "remove",
        path: 'members[value eq "user-1"]',
      },
    ]);
    expect(result).toEqual([{ op: "remove", userId: "user-1" }]);
  });

  it("rejects invalid members value", () => {
    expect(() =>
      parseGroupPatchOps([
        { op: "add", path: "members", value: "not-array" },
      ]),
    ).toThrow(PatchParseError);
  });

  it("rejects unsupported op/path combination", () => {
    expect(() =>
      parseGroupPatchOps([
        { op: "replace", path: "displayName", value: "NEW" },
      ]),
    ).toThrow(PatchParseError);
  });
});
