/**
 * RT7 self-test for check-override-key-disjointness.mjs.
 *
 * The guard exists because npm resolves overlapping `overrides` keys by silent
 * first-match in JSON key order, so a CVE fix added beside a stale key can
 * resolve to the vulnerable version with exit 0 and no diagnostic. These cases
 * are the shapes that reached a review round before being caught by hand —
 * each one must make the guard go red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  findOverlappingKeys,
  splitOverrideKey,
} from "../checks/check-override-key-disjointness.mjs";

describe("splitOverrideKey", () => {
  it("splits a plain package key at its selector", () => {
    expect(splitOverrideKey("brace-expansion@1")).toEqual({
      name: "brace-expansion",
      range: "1",
    });
  });

  it("splits a scoped package at the second @, not the leading one", () => {
    expect(splitOverrideKey("@scope/thing@>=2.0.0 <3.0.0")).toEqual({
      name: "@scope/thing",
      range: ">=2.0.0 <3.0.0",
    });
  });

  it("treats a bare scoped name as selector-less, not as a range of ''", () => {
    expect(splitOverrideKey("@hono/node-server")).toEqual({
      name: "@hono/node-server",
      range: "*",
    });
  });

  it("gives a selector-less key the everything range, since that is what npm applies", () => {
    expect(splitOverrideKey("lodash")).toEqual({ name: "lodash", range: "*" });
  });
});

describe("findOverlappingKeys", () => {
  it("returns no violation for disjoint keys written in different forms", () => {
    // The three forms this repo actually ships: bare major, bare major, explicit range.
    expect(
      findOverlappingKeys({
        "brace-expansion@1": "^1.1.17",
        "brace-expansion@2": "^2.1.3",
        "brace-expansion@>=3.0.0 <5.0.8": "^5.0.8",
      }),
    ).toEqual([]);
  });

  it("flags an inclusive upper bound that overlaps the next key by one version", () => {
    // <=1.1.17 and >=1.1.17 both select 1.1.17; which one wins depends on key order.
    const violations = findOverlappingKeys({
      "brace-expansion@<=1.1.17": "1.1.17",
      "brace-expansion@>=1.1.17 <2.0.0": "1.1.16",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("brace-expansion");
  });

  it("flags a whole-package key beside a ranged key for the same package", () => {
    // A selector-less key is `*`, so it overlaps every ranged sibling.
    expect(
      findOverlappingKeys({
        "js-yaml": "^4.3.0",
        "js-yaml@>=3.0.0 <3.15.0": "^3.15.0",
      }),
    ).toHaveLength(1);
  });

  it("flags forms no hand-written interval table enumerated", () => {
    // Hyphen range, tilde and an exact pin all overlap a bare major.
    expect(findOverlappingKeys({ "pkg@1.0.0 - 2.0.0": "x", "pkg@>=2.0.0 <3.0.0": "y" })).toHaveLength(1);
    expect(findOverlappingKeys({ "pkg@~1.1.7": "x", "pkg@1": "y" })).toHaveLength(1);
    expect(findOverlappingKeys({ "pkg@1.1.9": "x", "pkg@1": "y" })).toHaveLength(1);
  });

  it("names the nested scope when the overlap is inside a parent override", () => {
    const violations = findOverlappingKeys({
      "@crxjs/vite-plugin": { "rollup@1": "^1.0.0", "rollup@>=0.5.0 <2.0.0": "^2.80.0" },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("@crxjs/vite-plugin");
  });

  it("does not collide the same package across two different parent scopes", () => {
    expect(
      findOverlappingKeys({
        "parent-a": { "rollup@1": "^1.0.0" },
        "parent-b": { "rollup@1": "^1.0.0" },
      }),
    ).toEqual([]);
  });

  it("skips a selector npm itself rejects rather than throwing", () => {
    // `latest` is not a valid range; npm fails loudly on it, so the guard stays quiet.
    expect(() => findOverlappingKeys({ "pkg@latest": "1.0.0", "pkg@1": "^1.2.3" })).not.toThrow();
  });

  it("ignores the '.' key, which addresses the parent package rather than a dependency", () => {
    expect(findOverlappingKeys({ ".": "1.2.3", "pkg@1": "^1.0.0" })).toEqual([]);
  });
});

describe("the repository's own overrides blocks", () => {
  it.each(["package.json", "cli/package.json", "extension/package.json"])(
    "%s has no overlapping override keys",
    (path) => {
      const { overrides } = JSON.parse(readFileSync(path, "utf8"));
      expect(findOverlappingKeys(overrides, path)).toEqual([]);
    },
  );
});
