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

  it("rejects externalId path (not supported via PATCH)", () => {
    expect(() =>
      parseUserPatchOps([
        { op: "replace", path: "externalId", value: "ext-123" },
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

const USER_1 = "11111111-1111-4111-8111-111111111111";
const USER_2 = "22222222-2222-4222-8222-222222222222";

describe("parseGroupPatchOps", () => {
  it("parses add members", () => {
    const result = parseGroupPatchOps([
      {
        op: "add",
        path: "members",
        value: [{ value: USER_1 }, { value: USER_2 }],
      },
    ]);
    expect(result).toEqual([
      { op: "add", userId: USER_1 },
      { op: "add", userId: USER_2 },
    ]);
  });

  it("parses remove members", () => {
    const result = parseGroupPatchOps([
      {
        op: "remove",
        path: "members",
        value: [{ value: USER_1 }],
      },
    ]);
    expect(result).toEqual([{ op: "remove", userId: USER_1 }]);
  });

  it("parses Azure AD style remove (path filter)", () => {
    const result = parseGroupPatchOps([
      {
        op: "remove",
        path: `members[value eq "${USER_1}"]`,
      },
    ]);
    expect(result).toEqual([{ op: "remove", userId: USER_1 }]);
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

  // F2/S-F3: member values are validated as uuids, lowercased, and
  // de-duplicated per op kind at this boundary.
  it("rejects a non-uuid member value with scimType invalidValue", () => {
    expect.assertions(2);
    try {
      parseGroupPatchOps([
        { op: "add", path: "members", value: [{ value: "not-a-uuid" }] },
      ]);
    } catch (e) {
      expect(e).toBeInstanceOf(PatchParseError);
      expect((e as PatchParseError).scimType).toBe("invalidValue");
    }
  });

  it("rejects a non-uuid member value from the Azure filter path", () => {
    expect(() =>
      parseGroupPatchOps([
        { op: "remove", path: 'members[value eq "not-a-uuid"]' },
      ]),
    ).toThrow(PatchParseError);
  });

  it("lowercases a mixed-case uuid member value", () => {
    const result = parseGroupPatchOps([
      { op: "add", path: "members", value: [{ value: USER_1.toUpperCase() }] },
    ]);
    expect(result).toEqual([{ op: "add", userId: USER_1 }]);
  });

  it("lowercases a mixed-case uuid from the Azure filter path", () => {
    const result = parseGroupPatchOps([
      { op: "remove", path: `members[value eq "${USER_1.toUpperCase()}"]` },
    ]);
    expect(result).toEqual([{ op: "remove", userId: USER_1 }]);
  });

  it("de-duplicates a repeated id within the same op kind", () => {
    const result = parseGroupPatchOps([
      { op: "add", path: "members", value: [{ value: USER_1 }, { value: USER_1 }] },
    ]);
    expect(result).toEqual([{ op: "add", userId: USER_1 }]);
  });

  it("de-duplicates the same id repeated across add op entries, keeping the first", () => {
    const result = parseGroupPatchOps([
      { op: "add", path: "members", value: [{ value: USER_1 }] },
      { op: "add", path: "members", value: [{ value: USER_1 }] },
    ]);
    expect(result).toEqual([{ op: "add", userId: USER_1 }]);
  });

  it("keeps add-then-remove order for the same id across op kinds", () => {
    const result = parseGroupPatchOps([
      { op: "add", path: "members", value: [{ value: USER_1 }] },
      { op: "remove", path: "members", value: [{ value: USER_1 }] },
    ]);
    expect(result).toEqual([
      { op: "add", userId: USER_1 },
      { op: "remove", userId: USER_1 },
    ]);
  });
});
