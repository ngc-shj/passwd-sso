/**
 * RT7 self-test for check-override-key-disjointness.mjs.
 *
 * npm matches an override key against the range a depending package *asks for*
 * and takes the first key that intersects it, in JSON key order, silently. Two
 * shapes break order-independence and both must make the guard go red:
 * overlapping keys, and disjoint keys straddled by one dependency edge.
 *
 * Every case here is a shape that reached a review round before being caught by
 * hand.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  collectScopes,
  discoverManifests,
  findAmbiguousEdges,
  findOverlappingKeys,
  splitOverrideKey,
  topLevelScope,
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

  it("reports a selector semver cannot parse instead of skipping it", () => {
    // npm errors on `pkg@latest` only when it evaluates the key: `{"pkg@latest": x}`
    // fails the install, but `{"pkg": y, "pkg@latest": x}` exits 0 and ignores it.
    // Skipping it here would inherit that order-dependence.
    const violations = findOverlappingKeys({ "pkg": "1.0.0", "pkg@latest": "1.0.0" });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("cannot parse");
  });

  it("ignores the '.' key, which addresses the parent package rather than a dependency", () => {
    expect(findOverlappingKeys({ ".": "1.2.3", "pkg@1": "^1.0.0" })).toEqual([]);
  });
});

describe("findAmbiguousEdges", () => {
  // The hazard an earlier revision of this guard missed entirely: the keys are
  // disjoint from each other, so the pairwise check passes, but one dependency
  // edge asks for a range that reaches both. Verified against npm 11.17.0:
  // a parent requesting `>=1 <3` resolves 1.1.17 with @1 first, 2.1.3 reversed.
  const disjointKeys = { "brace-expansion@1": "1.1.17", "brace-expansion@2": "2.1.3" };

  it("flags an edge whose requested range straddles two non-overlapping keys", () => {
    const violations = findAmbiguousEdges(disjointKeys, {
      "node_modules/wide-parent": { dependencies: { "brace-expansion": ">=1 <3" } },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("wide-parent");
    expect(violations[0]).toContain("straddles");
  });

  it("passes when every edge reaches exactly one key", () => {
    expect(
      findAmbiguousEdges(disjointKeys, {
        "node_modules/minimatch": { dependencies: { "brace-expansion": "^1.1.7" } },
        "node_modules/other/node_modules/minimatch": {
          dependencies: { "brace-expansion": "^2.0.2" },
        },
      }),
    ).toEqual([]);
  });

  it("passes when an edge reaches no key at all", () => {
    expect(
      findAmbiguousEdges(disjointKeys, {
        "node_modules/minimatch": { dependencies: { "brace-expansion": "^5.0.8" } },
      }),
    ).toEqual([]);
  });

  it("checks every dependency field, not just `dependencies`", () => {
    expect(
      findAmbiguousEdges(disjointKeys, {
        "node_modules/a": { devDependencies: { "brace-expansion": ">=1 <3" } },
        "node_modules/b": { peerDependencies: { "brace-expansion": ">=1 <3" } },
        "node_modules/c": { optionalDependencies: { "brace-expansion": ">=1 <3" } },
      }),
    ).toHaveLength(3);
  });

  it("stays quiet when only one key exists for the package, since order cannot matter", () => {
    expect(
      findAmbiguousEdges({ "brace-expansion@1": "1.1.17" }, {
        "node_modules/wide-parent": { dependencies: { "brace-expansion": ">=1 <3" } },
      }),
    ).toEqual([]);
  });

  it("still checks the top-level scope when a nested override is present", () => {
    // collectScopes is post-order, so the array's first element is the nested
    // scope. An earlier revision took element 0 as the top level and skipped
    // this check entirely on any manifest with a nested override — which
    // extension/package.json has.
    const violations = findAmbiguousEdges(
      { parent: { child: "1.0.0" }, ...disjointKeys },
      { "node_modules/wide-parent": { dependencies: { "brace-expansion": ">=1 <3" } } },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("straddles");
  });

  it("reports an edge spec semver cannot compare when the package has several keys", () => {
    // npm reduces `npm:pkg@>=1 <3` to the range and applies the overrides to it
    // order-dependently; semver.validRange returns null for the same string, so
    // treating it as safe would be a false negative.
    const violations = findAmbiguousEdges(disjointKeys, {
      "node_modules/aliased": {
        dependencies: { "brace-expansion": "npm:brace-expansion@>=1 <3" },
      },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("cannot compare");
  });

  it("does not report an incomparable spec when only one key exists", () => {
    // One key cannot be order-dependent, so this must not become noise —
    // the repo's single non-semver edge (`tailwindcss`) is this shape.
    expect(
      findAmbiguousEdges({ "brace-expansion@1": "1.1.17" }, {
        "node_modules/aliased": {
          dependencies: { "brace-expansion": "npm:brace-expansion@>=1 <3" },
        },
      }),
    ).toEqual([]);
  });
});

describe("scope depth", () => {
  it("labels the top-level scope by depth, not by position in the walk", () => {
    const scopes = collectScopes({ parent: { child: "1.0.0" }, "pkg@1": "1.0.0" });
    expect(scopes[0].scopePath).toBe("overrides > parent"); // post-order: nested first
    expect(topLevelScope(scopes).scopePath).toBe("overrides");
    expect(topLevelScope(scopes).depth).toBe(0);
  });

  it("rejects two selectors for one package inside a nested scope", () => {
    // A nested scope governs only edges under its parent, and the lockfile does
    // not record which scope produced an edge — so it cannot be edge-checked.
    // Undecidable means red.
    const violations = findOverlappingKeys({ parent: { "pkg@1": "1.0.0", "pkg@2": "2.0.0" } });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("nested scope");
  });

  it("accepts a single selector inside a nested scope", () => {
    // extension/package.json's actual shape.
    expect(findOverlappingKeys({ "@crxjs/vite-plugin": { rollup: "^2.80.0" } })).toEqual([]);
  });
});

describe("discoverManifests", () => {
  it("finds every tracked package.json rather than a hardcoded list", () => {
    const found = discoverManifests();
    expect(found).toContain("package.json");
    expect(found).toContain("cli/package.json");
    expect(found).toContain("extension/package.json");
    // node_modules manifests must not leak in — git ls-files excludes them.
    expect(found.some((p) => p.includes("node_modules"))).toBe(false);
  });
});

describe("the repository's own overrides blocks", () => {
  const manifests = discoverManifests().filter((p) => {
    try {
      return Boolean(JSON.parse(readFileSync(p, "utf8")).overrides);
    } catch {
      return false;
    }
  });

  it("has at least one manifest with overrides, so the cases below are not vacuous", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it.each(manifests)("%s has no overlapping override keys", (path) => {
    const { overrides } = JSON.parse(readFileSync(path, "utf8"));
    expect(findOverlappingKeys(overrides, path)).toEqual([]);
  });

  it.each(manifests)("%s has no dependency edge straddling two keys", (path) => {
    const { overrides } = JSON.parse(readFileSync(path, "utf8"));
    const lockPath = path.replace(/package\.json$/, "package-lock.json");
    const { packages } = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(findAmbiguousEdges(overrides, packages, lockPath)).toEqual([]);
  });
});
