import { describe, it, expect } from "vitest";
import { isRekeyPending, itemKeyIdsMatch, normalizeTeamKeyVersion } from "./team-key-resolution";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

describe("itemKeyIdsMatch", () => {
  it("matches the same id", () => {
    expect(itemKeyIdsMatch(ID_A, ID_A)).toBe(true);
  });

  it("matches the same id regardless of hex case", () => {
    expect(itemKeyIdsMatch(ID_A, ID_A.toUpperCase())).toBe(true);
  });

  it("does not match different ids", () => {
    expect(itemKeyIdsMatch(ID_A, ID_B)).toBe(false);
  });

  it("never matches null against null", () => {
    expect(itemKeyIdsMatch(null, null)).toBe(false);
    expect(itemKeyIdsMatch(undefined, undefined)).toBe(false);
  });

  it("never matches a null on either side", () => {
    expect(itemKeyIdsMatch(null, ID_A)).toBe(false);
    expect(itemKeyIdsMatch(ID_A, null)).toBe(false);
    expect(itemKeyIdsMatch(undefined, ID_A)).toBe(false);
  });
});

describe("normalizeTeamKeyVersion", () => {
  it.each([
    [-1, 1],
    [0, 1],
    [1, 1],
    [2, 2],
    [7, 7],
  ])("maps %i to %i", (input, expected) => {
    expect(normalizeTeamKeyVersion(input)).toBe(expected);
  });
});

describe("isRekeyPending", () => {
  const CURRENT = 3;
  it.each([
    ["an ItemKey created under an older team key", { itemKeyVersion: 2, itemKeyId: ID_A, itemKeyTeamKeyVersion: 2 }, true],
    ["a v0 entry marked below the current version", { itemKeyVersion: 0, itemKeyId: null, itemKeyTeamKeyVersion: 0 }, true],
    ["a v1+ entry with a NULL id, marked current (previous-release write)", { itemKeyVersion: 1, itemKeyId: null, itemKeyTeamKeyVersion: CURRENT }, true],
    ["a v1+ entry with an absent id, marked current", { itemKeyVersion: 1, itemKeyTeamKeyVersion: CURRENT }, true],
    ["a v1+ entry with an id, marked current (control)", { itemKeyVersion: 1, itemKeyId: ID_A, itemKeyTeamKeyVersion: CURRENT }, false],
    ["a v0 entry marked current (control)", { itemKeyVersion: 0, itemKeyId: null, itemKeyTeamKeyVersion: CURRENT }, false],
  ])("%s → %s", (_label, entry, expected) => {
    expect(isRekeyPending(entry, CURRENT)).toBe(expected);
  });
});
