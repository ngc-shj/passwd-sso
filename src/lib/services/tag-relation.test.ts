import { describe, it, expect } from "vitest";
import { dedupeTagIds, tagConnect, tagSet } from "./tag-relation";

describe("tag-relation", () => {
  it("dedupeTagIds removes duplicates and preserves first-seen order", () => {
    expect(dedupeTagIds(["t1", "t1", "t2"])).toEqual(["t1", "t2"]);
  });

  it("dedupeTagIds returns [] for an empty input", () => {
    expect(dedupeTagIds([])).toEqual([]);
  });

  it("tagConnect dedupes before shaping the connect relation write", () => {
    // A duplicate connect is malformed input to Prisma — only the unique tag survives.
    expect(tagConnect(["t1", "t1"])).toEqual({ connect: [{ id: "t1" }] });
  });

  it("tagSet dedupes before shaping the set relation write", () => {
    expect(tagSet(["t1", "t2", "t2"])).toEqual({ set: [{ id: "t1" }, { id: "t2" }] });
  });
});
