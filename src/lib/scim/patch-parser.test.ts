import { describe, it, expect } from "vitest";
import {
  parseUserPatchOps,
  parseGroupPatchOps,
  PatchParseError,
} from "./patch-parser";
import { scimGroupSchema } from "./validations";

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

  // The parser keeps every action: the service folds them to one per userId,
  // last op wins, and an earlier copy dropped here would change which op is
  // last ([remove X, add X, remove X] would lose its final remove).
  it("keeps a repeated id within one op", () => {
    const result = parseGroupPatchOps([
      { op: "add", path: "members", value: [{ value: USER_1 }, { value: USER_1 }] },
    ]);
    expect(result).toEqual([{ op: "add", userId: USER_1 }, { op: "add", userId: USER_1 }]);
  });

  it("keeps every op of a remove-add-remove sequence, in order", () => {
    const result = parseGroupPatchOps([
      { op: "remove", path: "members", value: [{ value: USER_1 }] },
      { op: "add", path: "members", value: [{ value: USER_1 }] },
      { op: "remove", path: `members[value eq "${USER_1}"]` },
    ]);
    expect(result).toEqual([
      { op: "remove", userId: USER_1 },
      { op: "add", userId: USER_1 },
      { op: "remove", userId: USER_1 },
    ]);
  });

  // The service (patchScimGroup, D) folds this array to one action per
  // userId, last op wins — the parser must preserve order in both
  // directions, not just the one example that happens to match the old
  // (buggy) always-add-then-remove processing order.
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

  it("keeps remove-then-add order for the same id across op kinds", () => {
    const result = parseGroupPatchOps([
      { op: "remove", path: "members", value: [{ value: USER_1 }] },
      { op: "add", path: "members", value: [{ value: USER_1 }] },
    ]);
    expect(result).toEqual([
      { op: "remove", userId: USER_1 },
      { op: "add", userId: USER_1 },
    ]);
  });

  it("normalises an upper-case spelling to the same lowercase id", () => {
    const result = parseGroupPatchOps([
      { op: "add", path: "members", value: [{ value: USER_1 }, { value: USER_1.toUpperCase() }] },
    ]);
    expect(result).toEqual([{ op: "add", userId: USER_1 }, { op: "add", userId: USER_1 }]);
  });
});

// C/F2/S-F3 (review round 2, F-N3/T-N3/T-N4): PATCH's member-value check
// (patch-parser.ts) and PUT/POST's (validations.ts's scimGroupSchema) must
// agree on what counts as a user id — both now run the same zod `.uuid()`
// validator. A hand-rolled regex previously disagreed with it on the nil and
// max uuids (no version/variant nibble to check against).
describe("PATCH/PUT member-value validation parity", () => {
  const NIL_UUID = "00000000-0000-0000-0000-000000000000";
  const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

  function parserAccepts(value: string): boolean {
    try {
      parseGroupPatchOps([{ op: "add", path: "members", value: [{ value }] }]);
      return true;
    } catch {
      return false;
    }
  }

  function schemaAccepts(value: string): boolean {
    return scimGroupSchema.safeParse({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: "ADMIN",
      members: [{ value }],
    }).success;
  }

  it.each([
    ["nil uuid", NIL_UUID],
    ["max uuid", MAX_UUID],
    ["upper-case uuid", USER_1.toUpperCase()],
    ["non-uuid", "not-a-uuid"],
  ])("agree on %s", (_label, value) => {
    expect(parserAccepts(value)).toBe(schemaAccepts(value));
  });
});
