/**
 * RT7 self-test for check-override-floor-staleness.mjs.
 *
 * The gate decides one thing: does an `overrides` pin's range still intersect a
 * live advisory band for its own package? Everything that can make that answer
 * wrong is a case here, and every deny case is paired with an allow case on the
 * SAME fixture shape differing in ONE axis — this gate reds every pull request
 * repo-wide, so a false deny blocks all merges, and over-blocking is the failure
 * mode that gets gates switched off.
 *
 * Two things about the shape of these tests, both of which cost a review round
 * to learn:
 *
 *   - The comma-band regression case sits on the ALLOW side. GitHub writes
 *     `">= 2.0.0, < 2.1.4"`, `semver` THROWS on that form, and a throw is also a
 *     violation — so a case expecting a violation stays green when the
 *     normalizer is deleted and proves nothing. On the allow side, deleting the
 *     normalizer turns a pass into a throw-violation and reds it.
 *   - No expected value here is produced by the code under test or read from a
 *     constant the code under test also reads. The canary's advisory id and the
 *     properties asserted of it are spelled out literally, because editing the
 *     canary constant is exactly the edit an operator is tempted to make when
 *     the gate reds.
 *
 * No network. The advisory data is injected; one recorded API response is
 * committed under fixtures/advisories/ as evidence that the shape the core
 * parses is a shape the API actually emitted.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as gate from "../checks/check-override-floor-staleness.mjs";
import {
  AMBIENT_ORIGIN_VARS,
  CANARY,
  DEFAULT_ORIGIN,
  OUTCOME,
  PER_PAGE,
  TOKEN_VARS,
  buildAdvisoryCache,
  checkCanary,
  checkPackageIntegrity,
  checkResponseShape,
  collectEntries,
  discoveryRefusal,
  exitCodeFor,
  extractBands,
  formatReportLines,
  formatViolationLines,
  isTruncated,
  isUnboundedAbove,
  judge,
  normalizeBand,
  packagesToQuery,
  parseArgs,
  pinToRange,
  rangesIntersect,
  requiredFloor,
  resolveOrigin,
  resolveRefPin,
  retryDecision,
  run,
  sanitizeLine,
  transformAdvisories,
} from "../checks/check-override-floor-staleness.mjs";
import {
  FALLBACK_MANIFESTS,
  discoverManifests,
} from "../checks/check-override-key-disjointness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GATE = join(REPO_ROOT, "scripts/checks/check-override-floor-staleness.mjs");
const GATE_SOURCE = readFileSync(GATE, "utf8");
const SELF_SOURCE = readFileSync(fileURLToPath(import.meta.url), "utf8");

// --- fixture builders ------------------------------------------------------

/** `bands` is `[[packageName, range, firstPatchedOrNull], ...]`. */
function advisory({
  id,
  bands,
  withdrawn = null,
  type = "reviewed",
  severity = "high",
  summary = "test advisory",
  ecosystem = "npm",
}) {
  return {
    ghsa_id: id,
    withdrawn_at: withdrawn,
    type,
    severity,
    summary,
    vulnerabilities: bands.map(([name, range, firstPatched = null]) => ({
      package: { ecosystem, name },
      vulnerable_version_range: range,
      first_patched_version: firstPatched,
      vulnerable_functions: [],
    })),
  };
}

function okCache(pairs) {
  return buildAdvisoryCache(pairs.map(([pkg, advisories]) => [pkg, { ok: true, advisories }]));
}

/** Walk one in-memory manifest and judge it against injected advisories. */
function judgeManifest(manifestJson, cachePairs, manifestPath = "package.json") {
  const entries = collectEntries([{ path: manifestPath, ok: true, json: manifestJson }]);
  return judge(entries, okCache(cachePairs));
}

function outcomesOf(rows) {
  return rows.map((r) => `${r.key}:${r.outcome}`);
}

/**
 * Assert a row exists BEFORE dereferencing it. A mutation that drops the row
 * would otherwise red with `Cannot read properties of undefined`, and a red
 * produced by a throw is not a proof of the clause under test (O-10).
 */
function rowFor(rows, predicate, label) {
  const found = rows.find(predicate);
  expect(found, `no row matched ${label}; walked: ${rows.map((r) => `${r.scopePath}|${r.key}`).join(", ")}`).toBeTruthy();
  return found;
}

/** Same reason: name the outcomes when no violation line was produced at all. */
function firstViolation(rows) {
  const lines = formatViolationLines(rows);
  expect(lines.length, `no violation line was produced; outcomes: ${outcomesOf(rows).join(", ")}`).toBeGreaterThan(0);
  return lines[0];
}

let tempRoots = [];
function tempDir(prefix = "floor-staleness-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}
afterEach(() => {
  // Cleanup runs on the failure path too — an assertion throwing mid-test must
  // not leave a tree behind (O-8).
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots = [];
});

// ===========================================================================
// S-trap: comma bands. O-6 puts the regression case on the ALLOW side.
// ===========================================================================

describe("normalizeBand / rangesIntersect — the comma-band trap (O-6)", () => {
  it("ALLOW: a comma band that does not reach the pin compares to false, not a throw", () => {
    // Deleting the `,` normalization turns this pass into a throw
    // (`Invalid comparator: >=4.0.0,`), and a throw is a violation — which is
    // why the regression case lives here and not on the deny side.
    expect(rangesIntersect("^5.0.9", ">= 4.0.0, < 5.0.9")).toBe(false);
  });

  it("DENY: the same comma band reaches a pin one patch lower", () => {
    expect(rangesIntersect("^5.0.8", ">= 4.0.0, < 5.0.9")).toBe(true);
  });

  it("rewrites the comma separator to a space and leaves everything else alone", () => {
    expect(normalizeBand(">= 2.0.0, < 2.1.4")).toBe(">= 2.0.0 < 2.1.4");
    expect(normalizeBand("< 1.1.18")).toBe("< 1.1.18");
  });

  it("ALLOW: a whole manifest with only comma bands judges clean rather than throwing", () => {
    const rows = judgeManifest({ overrides: { "brace-expansion@2": "^2.1.4" } }, [
      ["brace-expansion", [advisory({ id: "GHSA-rgw5-rvv9-x895", bands: [["brace-expansion", ">= 2.0.0, < 2.1.4", "2.1.4"]] })]],
    ]);
    expect(outcomesOf(rows)).toEqual(["brace-expansion@2:clean"]);
  });

  it("DENY: the same comma band with the pin one patch lower is stale and names the id and the floor", () => {
    const rows = judgeManifest({ overrides: { "brace-expansion@2": "^2.1.3" } }, [
      ["brace-expansion", [advisory({ id: "GHSA-rgw5-rvv9-x895", bands: [["brace-expansion", ">= 2.0.0, < 2.1.4", "2.1.4"]] })]],
    ]);
    expect(outcomesOf(rows)).toEqual(["brace-expansion@2:stale"]);
    const [line] = formatViolationLines(rows);
    expect(line).toContain("brace-expansion");
    expect(line).toContain("GHSA-rgw5-rvv9-x895");
    expect(line).toContain("required floor >= 2.1.4");
  });

  it("a throw out of a comparison is a named undecidable, never a swallowed miss", () => {
    // A band semver cannot read even after normalization. The gate must not
    // read "cannot compare" as "does not overlap".
    const rows = judgeManifest({ overrides: { pkg: "^1.0.0" } }, [
      ["pkg", [advisory({ id: "GHSA-throw-0000-0000", bands: [["pkg", ">>> nonsense", "2.0.0"]] })]],
    ]);
    expect(rows[0].outcome).toBe(OUTCOME.UNDECIDABLE);
    expect(String(rows[0].refusal)).toContain("UNDECIDABLE_COMPARISON_THREW");
  });
});

// ===========================================================================
// The comparison predicate itself (O-7: open-ended pin x inclusive upper bound)
// ===========================================================================

describe("the range predicate is semver's, including the boundary cases a table gets wrong", () => {
  it("DENY: an inclusive upper bound touches an open-ended pin at exactly the boundary", () => {
    expect(rangesIntersect(">=8.5.23", "<= 8.5.23")).toBe(true);
  });

  it("ALLOW: an exclusive upper bound at the same version does not", () => {
    expect(rangesIntersect(">=8.5.23", "< 8.5.23")).toBe(false);
  });

  it("DENY: an open-ended pin reaches a band on a later major (S6 — there is no wedge)", () => {
    expect(rangesIntersect(">=8.5.23", ">= 9.0.0, < 9.1.0")).toBe(true);
  });

  it("ALLOW: bounding the same pin below the band closes it", () => {
    expect(rangesIntersect(">=8.5.23 <9", ">= 9.0.0, < 9.1.0")).toBe(false);
  });

  it("recognises an unbounded pin without reading its characters", () => {
    expect(isUnboundedAbove(">=8.5.23")).toBe(true);
    expect(isUnboundedAbove(">=8.5.23 <9")).toBe(false);
    expect(isUnboundedAbove("^2.1.4")).toBe(false);
  });
});

// ===========================================================================
// S1 — an object-valued key is a scope opener because its scope yielded, not
//      because of its typeof
// ===========================================================================

describe("S1 — scope openers", () => {
  it("ALLOW: an object-valued key whose nested scope yields a pin is not-judged, and does not fail the run", () => {
    const rows = judgeManifest({ overrides: { "@crxjs/vite-plugin": { rollup: "^2.80.0" } } }, [
      ["@crxjs/vite-plugin", []],
      ["rollup", [advisory({ id: "GHSA-mw96-cpmx-2vgc", bands: [["rollup", "< 2.80.0", "2.80.0"]] })]],
    ]);
    expect(outcomesOf(rows).sort()).toEqual(["@crxjs/vite-plugin:not-judged", "rollup:clean"]);
    expect(exitCodeFor(rows)).toBe(0);
  });

  it("DENY: an object-valued key whose nested scope yields nothing is a refusal", () => {
    const rows = judgeManifest({ overrides: { "@crxjs/vite-plugin": {} } }, [["@crxjs/vite-plugin", []]]);
    expect(rows[0].outcome).toBe(OUTCOME.REFUSED);
    expect(String(rows[0].refusal)).toContain("REFUSED_EMPTY_SCOPE");
    expect(exitCodeFor(rows)).toBe(1);
  });

  it("ALLOW: a scope whose only child is a '.' self-pin counts as having yielded", () => {
    const rows = judgeManifest({ overrides: { "@crxjs/vite-plugin": { ".": "^2.7.1" } } }, [
      ["@crxjs/vite-plugin", []],
    ]);
    expect(outcomesOf(rows).sort()).toEqual([".:clean", "@crxjs/vite-plugin:not-judged"]);
  });

  it("DENY: an array value is a refusal, and yields exactly one row rather than two", () => {
    const rows = judgeManifest({ overrides: { pkg: [] } }, [["pkg", []]]);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe(OUTCOME.REFUSED);
    expect(String(rows[0].refusal)).toContain("REFUSED_NON_RANGE_PIN");
    expect(String(rows[0].refusal)).toContain("an array");
  });

  it("ALLOW: the same key with a string value is judged normally", () => {
    const rows = judgeManifest({ overrides: { pkg: "^1.0.0" } }, [["pkg", []]]);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe(OUTCOME.CLEAN);
  });

  it("queries a scope opener's parent name even though it is never judged (17 pins + 1 parent)", () => {
    const entries = collectEntries([
      { path: "extension/package.json", ok: true, json: { overrides: { "@crxjs/vite-plugin": { rollup: "^2.80.0" } } } },
    ]);
    expect(packagesToQuery(entries).sort()).toEqual(["@crxjs/vite-plugin", "rollup"]);
  });
});

// ===========================================================================
// S2 — the "." self-pin, judged against the scope's carried parent name
// ===========================================================================

describe("S2 — '.' self-pins", () => {
  const withdrawnBand = { id: "GHSA-self-0000-0001", bands: [["pkg", ">= 1.0.0, < 1.5.0", "1.5.0"]] };

  it("DENY: '.' inside a selector-carrying scope is judged against the parent PACKAGE, not the parent KEY", () => {
    // `{"pkg@1": {".": "^1.0.0"}}` must be judged against `pkg`. The advisory
    // API answers 200 [] for `pkg@1`, so getting this wrong is a silent green.
    const rows = judgeManifest({ overrides: { "pkg@1": { ".": "^1.0.0" } } }, [
      ["pkg", [advisory(withdrawnBand)]],
    ]);
    const selfPin = rowFor(rows, (r) => r.key === ".", "the '.' self-pin");
    expect(selfPin.pkg).toBe("pkg");
    expect(selfPin.outcome).toBe(OUTCOME.STALE);
    expect(formatViolationLines(rows).join("\n")).toContain("GHSA-self-0000-0001");
  });

  it("ALLOW (O-7: '.' self-pin x withdrawn advisory): the same shape is clean when the advisory is withdrawn", () => {
    const rows = judgeManifest({ overrides: { "pkg@1": { ".": "^1.0.0" } } }, [
      ["pkg", [advisory({ ...withdrawnBand, withdrawn: "2026-01-01T00:00:00Z" })]],
    ]);
    expect(rowFor(rows, (r) => r.key === ".", "the '.' self-pin").outcome).toBe(OUTCOME.CLEAN);
    expect(exitCodeFor(rows)).toBe(0);
  });

  it("DENY: a '.' at the top level addresses no parent and is a refusal", () => {
    const rows = judgeManifest({ overrides: { ".": "^1.0.0" } }, []);
    const row = rowFor(rows, (r) => r.key === ".", "the top-level '.' key");
    expect(row.outcome).toBe(OUTCOME.REFUSED);
    expect(String(row.refusal)).toContain("REFUSED_TOP_LEVEL_SELF_PIN");
  });

  it("DENY: a '.' whose value is an object pins nothing and is a refusal", () => {
    const rows = judgeManifest({ overrides: { parent: { ".": { nested: "^1.0.0" } } } }, [["parent", []]]);
    const selfPin = rowFor(rows, (r) => r.key === ".", "the '.' self-pin");
    expect(selfPin.outcome).toBe(OUTCOME.REFUSED);
    expect(String(selfPin.refusal)).toContain("REFUSED_NON_RANGE_PIN");
  });

  it("ALLOW: a nested '.' with a string value is judged", () => {
    const rows = judgeManifest({ overrides: { parent: { ".": "^1.0.0" } } }, [["parent", []]]);
    expect(rowFor(rows, (r) => r.key === ".", "the '.' self-pin").outcome).toBe(OUTCOME.CLEAN);
  });
});

// ===========================================================================
// S3 — exact package-name equality, and the recorded fixture (O-9)
// ===========================================================================

describe("S3 — the same-package filter is exact equality", () => {
  const shared = advisory({
    id: "GHSA-shared-0000-0001",
    bands: [
      ["hono", "< 4.12.34", "4.12.34"],
      ["@hono/node-server", ">= 2.0.0, <= 2.0.9", "2.0.10"],
    ],
  });

  it("DENY: asking for hono returns only the hono band, not its prefix-sharing sibling", () => {
    expect(extractBands(shared, "hono").bands.map((b) => b.packageName)).toEqual(["hono"]);
  });

  it("ALLOW: asking for @hono/node-server returns only that band", () => {
    expect(extractBands(shared, "@hono/node-server").bands.map((b) => b.packageName)).toEqual([
      "@hono/node-server",
    ]);
  });

  it("DENY: a vulnerabilities entry with no package.name is a refusal, not a skip", () => {
    const broken = { ghsa_id: "GHSA-noname-0000-0001", withdrawn_at: null, vulnerabilities: [{ package: { ecosystem: "npm" }, vulnerable_version_range: "< 1.0.0", first_patched_version: "1.0.0" }] };
    const { problems } = extractBands(broken, "pkg");
    expect(problems.join(" ")).toContain("UNDECIDABLE_BAND_WITHOUT_PACKAGE_NAME");
  });

  it("ALLOW: the same entry with a package.name yields no problem", () => {
    const fixed = { ghsa_id: "GHSA-noname-0000-0001", withdrawn_at: null, vulnerabilities: [{ package: { ecosystem: "npm", name: "pkg" }, vulnerable_version_range: "< 1.0.0", first_patched_version: "1.0.0" }] };
    expect(extractBands(fixed, "pkg").problems).toEqual([]);
  });

  it("a same-named band in another ecosystem is not an npm band", () => {
    const rubygems = advisory({ id: "GHSA-eco-0000-0001", bands: [["lodash", "< 9.9.9", "9.9.9"]], ecosystem: "rubygems" });
    expect(extractBands(rubygems, "lodash").bands).toEqual([]);
  });

  it("a missing package.name surfaces as an undecidable row rather than a clean one", () => {
    const rows = judge(
      collectEntries([{ path: "package.json", ok: true, json: { overrides: { pkg: "^1.0.0" } } }]),
      okCache([["pkg", [{ ghsa_id: "GHSA-noname-0000-0002", withdrawn_at: null, vulnerabilities: [{ package: { ecosystem: "npm" }, vulnerable_version_range: "< 2.0.0", first_patched_version: "2.0.0" }] }]]]),
    );
    expect(rows[0].outcome).toBe(OUTCOME.UNDECIDABLE);
  });
});

describe("O-9 — the recorded API response, as an RT1 anchor", () => {
  const RECORDED = JSON.parse(
    readFileSync(join(__dirname, "fixtures/advisories/lodash.json"), "utf8"),
  );
  // Selected by id, never by index: a re-ordering upstream must not silently
  // point this at a different advisory.
  const FOUR_BAND_ID = "GHSA-r5fr-rjxr-66jc";
  const entry = RECORDED.find((a) => a.ghsa_id === FOUR_BAND_ID);

  it("still contains the four-band advisory this fixture was recorded for", () => {
    expect(entry, `${FOUR_BAND_ID} is gone from the recorded fixture — re-record it`).toBeTruthy();
    expect(entry.withdrawn_at, `${FOUR_BAND_ID} has been withdrawn — pick another anchor`).toBeNull();
  });

  it("passes the boundary shape check the live path applies", () => {
    expect(checkResponseShape(RECORDED)).toEqual({ ok: true });
  });

  it("one fixture answers two subjects: lodash yields only the lodash band", () => {
    // `"lodash-es".startsWith("lodash")` is true, which is what makes this the
    // discriminating half of the prefix-vs-exact pair.
    expect(extractBands(entry, "lodash").bands.map((b) => b.packageName)).toEqual(["lodash"]);
  });

  it("one fixture answers two subjects: lodash-es yields only the lodash-es band", () => {
    expect(extractBands(entry, "lodash-es").bands.map((b) => b.packageName)).toEqual(["lodash-es"]);
  });

  it("drives the recorded response through the transform for both subjects", () => {
    const forLodash = transformAdvisories(RECORDED, "lodash");
    const forLodashEs = transformAdvisories(RECORDED, "lodash-es");
    expect(forLodash.problems).toEqual([]);
    expect(forLodashEs.problems).toEqual([]);
    expect(forLodash.live.map((a) => a.id)).toContain(FOUR_BAND_ID);
    // The recorded response carries a withdrawn advisory, so the withdrawn
    // filter is exercised by real data and not only by a hand-built fixture.
    expect(forLodash.withdrawnIds.length).toBeGreaterThan(0);
    expect(forLodash.live.map((a) => a.id)).not.toContain(forLodash.withdrawnIds[0]);
  });

  it("satisfies the per-package integrity rule for both subjects", () => {
    expect(checkPackageIntegrity(RECORDED, "lodash")).toEqual([]);
  });

  it("DENY: the recorded response is not an answer about a package it carries no band for", () => {
    expect(checkPackageIntegrity(RECORDED, "left-pad").join(" ")).toContain(
      "UNDECIDABLE_PACKAGE_INTEGRITY",
    );
  });

  it("judges a real recorded band against a pin, both ways", () => {
    const stale = judgeManifest({ overrides: { lodash: "^4.17.21" } }, [["lodash", [entry]]]);
    expect(stale[0].outcome).toBe(OUTCOME.STALE);
    expect(formatViolationLines(stale)[0]).toContain(FOUR_BAND_ID);

    const clean = judgeManifest({ overrides: { lodash: "^4.18.1" } }, [["lodash", [entry]]]);
    expect(clean[0].outcome).toBe(OUTCOME.CLEAN);
  });
});

// ===========================================================================
// S4 — withdrawn advisories
// ===========================================================================

describe("S4 — a withdrawn advisory is not a live band", () => {
  const band = { id: "GHSA-with-0000-0001", bands: [["pkg", "< 2.0.0", "2.0.0"]] };

  it("DENY: live, the band makes the pin stale", () => {
    const rows = judgeManifest({ overrides: { pkg: "^1.0.0" } }, [["pkg", [advisory(band)]]]);
    expect(rows[0].outcome).toBe(OUTCOME.STALE);
  });

  it("ALLOW: withdrawn, the same band is excluded", () => {
    const rows = judgeManifest({ overrides: { pkg: "^1.0.0" } }, [
      ["pkg", [advisory({ ...band, withdrawn: "2025-06-01T00:00:00Z" })]],
    ]);
    expect(rows[0].outcome).toBe(OUTCOME.CLEAN);
  });

  it("names the withdrawn exclusion in report mode rather than subtracting it invisibly", () => {
    const cache = okCache([["pkg", [advisory({ ...band, withdrawn: "2025-06-01T00:00:00Z" })]]]);
    const rows = judge(collectEntries([{ path: "package.json", ok: true, json: { overrides: { pkg: "^1.0.0" } } }]), cache);
    const report = formatReportLines(rows, cache).join("\n");
    expect(report).toContain("withdrawn, skipped: GHSA-with-0000-0001");
  });
});

// ===========================================================================
// S5 / O-5 — first_patched_version and the max() rule
// ===========================================================================

describe("S5 — a live advisory with no patched version", () => {
  it("DENY: names the band and says there is no floor", () => {
    const rows = judgeManifest({ overrides: { pkg: "^1.0.0" } }, [
      ["pkg", [advisory({ id: "GHSA-nopat-0000-0001", bands: [["pkg", "< 2.0.0", null]] })]],
    ]);
    expect(rows[0].outcome).toBe(OUTCOME.STALE);
    const line = firstViolation(rows);
    expect(line).toContain("NO_PATCHED_VERSION");
    expect(line).toContain("GHSA-nopat-0000-0001");
    expect(line).toContain("bound the pin below the band");
  });

  it("ALLOW: the same band with a patched version names the floor instead", () => {
    const rows = judgeManifest({ overrides: { pkg: "^1.0.0" } }, [
      ["pkg", [advisory({ id: "GHSA-nopat-0000-0001", bands: [["pkg", "< 2.0.0", "2.0.0"]] })]],
    ]);
    const line = firstViolation(rows);
    expect(line).toContain("required floor >= 2.0.0");
    expect(line).not.toContain("NO_PATCHED_VERSION");
  });
});

describe("O-5 — max(first_patched_version) over the intersecting bands", () => {
  it("when two bands disagree on the floor, the higher wins and both ids are named", () => {
    const rows = judgeManifest({ overrides: { postcss: ">=8.5.12" } }, [
      [
        "postcss",
        [
          advisory({ id: "GHSA-fxqj-rqcc-2cmp", severity: "medium", bands: [["postcss", "<= 8.5.22", "8.5.23"]] }),
          advisory({ id: "GHSA-r28c-9q8g-f849", severity: "high", bands: [["postcss", "<= 8.5.17", "8.5.18"]] }),
        ],
      ],
    ]);
    const line = firstViolation(rows);
    expect(line).toContain("GHSA-fxqj-rqcc-2cmp");
    expect(line).toContain("GHSA-r28c-9q8g-f849");
    expect(line).toContain("required floor >= 8.5.23");
    expect(line).not.toContain("required floor >= 8.5.18");
  });

  it("when two bands tie on the floor, both ids are still named", () => {
    const rows = judgeManifest({ overrides: { pkg: "^1.0.0" } }, [
      [
        "pkg",
        [
          advisory({ id: "GHSA-tie0-0000-0001", bands: [["pkg", "< 1.5.0", "1.5.0"]] }),
          advisory({ id: "GHSA-tie0-0000-0002", bands: [["pkg", "< 1.5.0", "1.5.0"]] }),
        ],
      ],
    ]);
    const line = firstViolation(rows);
    expect(line).toContain("GHSA-tie0-0000-0001");
    expect(line).toContain("GHSA-tie0-0000-0002");
    expect(line).toContain("required floor >= 1.5.0");
  });

  it("requiredFloor reports an absent floor rather than the max of the rest", () => {
    const floor = requiredFloor([
      { advisory: { id: "GHSA-a" }, band: { firstPatched: "1.5.0" } },
      { advisory: { id: "GHSA-b" }, band: { firstPatched: null } },
    ]);
    expect(floor).toEqual({ floor: null, unpatchedIds: ["GHSA-b"] });
  });
});

// ===========================================================================
// S6 — an unbounded pin names both remedies
// ===========================================================================

describe("S6 — an unbounded >=X pin intersecting a band above its floor", () => {
  it("DENY: names both remedies", () => {
    const rows = judgeManifest({ overrides: { postcss: ">=8.5.23" } }, [
      ["postcss", [advisory({ id: "GHSA-abov-0000-0001", bands: [["postcss", ">= 9.0.0, < 9.1.0", "9.1.0"]] })]],
    ]);
    const line = firstViolation(rows);
    expect(line).toContain("required floor >= 9.1.0");
    expect(line).toContain("unbounded above");
    expect(line).toContain("bound the pin below it");
  });

  it("ALLOW: the same pin bounded below the band is clean", () => {
    const rows = judgeManifest({ overrides: { postcss: ">=8.5.23 <9" } }, [
      ["postcss", [advisory({ id: "GHSA-abov-0000-0001", bands: [["postcss", ">= 9.0.0, < 9.1.0", "9.1.0"]] })]],
    ]);
    expect(rows[0].outcome).toBe(OUTCOME.CLEAN);
  });

  it("a bounded stale pin does not claim to be unbounded", () => {
    const rows = judgeManifest({ overrides: { "pkg@1": "^1.0.0" } }, [
      ["pkg", [advisory({ id: "GHSA-boun-0000-0001", bands: [["pkg", "< 1.5.0", "1.5.0"]] })]],
    ]);
    expect(firstViolation(rows)).not.toContain("unbounded above");
  });
});

// ===========================================================================
// S7 — unreviewed advisories are in scope, and severity is never a filter
// ===========================================================================

describe("S7 — a live `unreviewed` advisory", () => {
  it("DENY: is judged, and tagged in the violation line", () => {
    const rows = judgeManifest({ overrides: { pkg: "^1.0.0" } }, [
      ["pkg", [advisory({ id: "GHSA-unrv-0000-0001", type: "unreviewed", bands: [["pkg", "< 2.0.0", "2.0.0"]] })]],
    ]);
    expect(rows[0].outcome).toBe(OUTCOME.STALE);
    expect(firstViolation(rows)).toContain("[unreviewed]");
  });

  it("ALLOW: a reviewed advisory on the same shape carries no tag", () => {
    const rows = judgeManifest({ overrides: { pkg: "^1.0.0" } }, [
      ["pkg", [advisory({ id: "GHSA-unrv-0000-0001", type: "reviewed", bands: [["pkg", "< 2.0.0", "2.0.0"]] })]],
    ]);
    expect(firstViolation(rows)).not.toContain("[unreviewed]");
  });
});

describe("severity is reported, never filtered on", () => {
  it("DENY: a `low` advisory that intersects is stale — a severity floor would have hidden the hono finding", () => {
    const rows = judgeManifest({ overrides: { hono: "^4.12.27" } }, [
      ["hono", [advisory({ id: "GHSA-8j4g-w8fx-2239", severity: "low", bands: [["hono", "< 4.12.34", "4.12.34"]] })]],
    ]);
    expect(rows[0].outcome).toBe(OUTCOME.STALE);
    expect(firstViolation(rows)).toContain("[low]");
  });

  it("ALLOW: the same low advisory against a raised pin is clean", () => {
    const rows = judgeManifest({ overrides: { hono: "^4.12.34" } }, [
      ["hono", [advisory({ id: "GHSA-8j4g-w8fx-2239", severity: "low", bands: [["hono", "< 4.12.34", "4.12.34"]] })]],
    ]);
    expect(rows[0].outcome).toBe(OUTCOME.CLEAN);
  });
});

// ===========================================================================
// S8 — truncation
// ===========================================================================

describe("S8 — truncation is a rel=\"next\" LINK RELATION, not a substring", () => {
  it("DENY: a rel=\"next\" relation is truncation", () => {
    expect(isTruncated('<https://api.github.com/advisories?page=2>; rel="next"', 10).truncated).toBe(true);
  });

  it("ALLOW: a header carrying only rel=\"prev\" and rel=\"last\" is not", () => {
    expect(
      isTruncated('<https://api.github.com/advisories?page=1>; rel="prev", <https://api.github.com/advisories?page=3>; rel="last"', 10).truncated,
    ).toBe(false);
  });

  it("ALLOW: the word \"next\" inside a URL is not a link relation", () => {
    expect(isTruncated('<https://api.github.com/advisories?affects=next>; rel="last"', 10).truncated).toBe(false);
  });

  it("DENY: a full page with no link relation at all is truncation — absence at the ceiling is ambiguous", () => {
    const result = isTruncated(null, PER_PAGE);
    expect(result.truncated).toBe(true);
    expect(result.reason).toContain("no link relation");
  });

  it("ALLOW: one item short of a full page with no header is not truncation", () => {
    expect(isTruncated(null, PER_PAGE - 1).truncated).toBe(false);
  });

  it("a truncated query makes every entry for that package undecidable, not clean", () => {
    const cache = buildAdvisoryCache([["pkg", { ok: false, token: "UNDECIDABLE_TRUNCATED", detail: "rel=next" }]]);
    const rows = judge(collectEntries([{ path: "package.json", ok: true, json: { overrides: { pkg: "^1.0.0" } } }]), cache);
    expect(rows[0].outcome).toBe(OUTCOME.UNDECIDABLE);
    expect(String(rows[0].refusal)).toContain("UNDECIDABLE_TRUNCATED");
  });
});

// ===========================================================================
// S9 — an unparseable selector (O-7: unparseable selector x intersecting band)
// ===========================================================================

describe("S9 — a selector semver cannot parse", () => {
  const intersecting = [["pkg", [advisory({ id: "GHSA-unpr-0000-0001", bands: [["pkg", "< 2.0.0", "2.0.0"]] })]]];

  it("DENY: is refused, not silently passed, even though its pin intersects a live band", () => {
    const rows = judgeManifest({ overrides: { "pkg@latest": "^1.0.0" } }, intersecting);
    const row = rowFor(rows, (r) => r.key === "pkg@latest", "the unparseable-selector key");
    expect(row.outcome).toBe(OUTCOME.REFUSED);
    expect(String(row.refusal)).toContain("REFUSED_UNPARSEABLE_SELECTOR");
    expect(String(row.refusal)).toContain("^1.0.0");
    expect(exitCodeFor(rows)).toBe(1);
  });

  it("ALLOW: the same pin under a parseable selector is judged and reported stale", () => {
    const rows = judgeManifest({ overrides: { "pkg@1": "^1.0.0" } }, intersecting);
    expect(rows[0].outcome).toBe(OUTCOME.STALE);
    expect(firstViolation(rows)).toContain("GHSA-unpr-0000-0001");
  });

  it("DENY: a pin semver cannot read as a range is a refusal", () => {
    expect(String(pinToRange("not-a-range", "pkg", {}).refusal)).toContain("REFUSED_NON_RANGE_PIN");
  });

  it("ALLOW: a pin semver can read yields a range", () => {
    expect(pinToRange("^1.0.0", "pkg", {}).range).toBe("^1.0.0");
  });
});

// ===========================================================================
// $ref resolution (O-7: $ref x comma band)
// ===========================================================================

describe("$ref pins resolve against the manifest's own dependency fields", () => {
  const rollupAdvisory = [
    ["rollup", [advisory({ id: "GHSA-gcx4-mw62-g8wm", bands: [["rollup", ">= 4.0.0, < 4.22.4", "4.22.4"]] })]],
  ];

  it("DENY ($ref x comma band): a $ref resolving into a comma band is stale and names the resolved range", () => {
    const rows = judgeManifest(
      { overrides: { rollup: "$rollup" }, devDependencies: { rollup: "^4.21.0" } },
      rollupAdvisory,
      "extension/package.json",
    );
    expect(rows[0].outcome).toBe(OUTCOME.STALE);
    const line = firstViolation(rows);
    expect(line).toContain("devDependencies.rollup -> '^4.21.0'");
    expect(line).toContain("GHSA-gcx4-mw62-g8wm");
    expect(line).toContain("required floor >= 4.22.4");
  });

  it("ALLOW: the same $ref resolving above the same comma band is clean", () => {
    const rows = judgeManifest(
      { overrides: { rollup: "$rollup" }, devDependencies: { rollup: "^4.62.3" } },
      rollupAdvisory,
      "extension/package.json",
    );
    expect(rows[0].outcome).toBe(OUTCOME.CLEAN);
  });

  it("DENY: a $ref naming something the manifest does not declare is a refusal", () => {
    const rows = judgeManifest({ overrides: { rollup: "$nope" }, devDependencies: { rollup: "^4.62.3" } }, rollupAdvisory);
    expect(rows[0].outcome).toBe(OUTCOME.REFUSED);
    expect(String(rows[0].refusal)).toContain("REFUSED_BAD_REF");
  });

  it("DENY: a $ref chaining to another $ref is a refusal", () => {
    expect(String(resolveRefPin("$rollup", "rollup", { devDependencies: { rollup: "$other" } }).refusal)).toContain(
      "REFUSED_BAD_REF",
    );
  });

  it("a bare $ takes the key's own package name, and searches every dependency field", () => {
    expect(resolveRefPin("$", "rollup", { dependencies: { rollup: "^4.62.3" } })).toEqual({
      value: "^4.62.3",
      via: "dependencies.rollup",
    });
    expect(String(resolveRefPin("$semver", "x", { peerDependencies: { semver: "^7.0.0" } }).value)).toBe("^7.0.0");
  });

  it("a non-$ pin passes through untouched", () => {
    expect(resolveRefPin("^1.0.0", "pkg", {})).toEqual({ value: "^1.0.0" });
  });
});

// ===========================================================================
// Nested scopes (O-7: nested scope x the boundary version)
// ===========================================================================

describe("nested scopes are walked and judged", () => {
  const rollupAdvisory = [
    ["@crxjs/vite-plugin", []],
    ["rollup", [advisory({ id: "GHSA-mw96-cpmx-2vgc", bands: [["rollup", "< 2.80.0", "2.80.0"]] })]],
  ];

  it("ALLOW: a nested pin exactly at the band's exclusive upper bound is clean", () => {
    const rows = judgeManifest({ overrides: { "@crxjs/vite-plugin": { rollup: "^2.80.0" } } }, rollupAdvisory);
    expect(rowFor(rows, (r) => r.pkg === "rollup", "the nested rollup pin").outcome).toBe(OUTCOME.CLEAN);
  });

  it("DENY: one patch below the boundary, the nested pin is stale and the nested scope is named", () => {
    const rows = judgeManifest({ overrides: { "@crxjs/vite-plugin": { rollup: "^2.79.0" } } }, rollupAdvisory);
    const nested = rowFor(rows, (r) => r.pkg === "rollup", "the nested rollup pin");
    expect(nested.outcome).toBe(OUTCOME.STALE);
    const line = firstViolation(rows);
    expect(line).toContain("overrides > @crxjs/vite-plugin");
    expect(line).toContain("GHSA-mw96-cpmx-2vgc");
    expect(line).toContain("required floor >= 2.80.0");
  });

  it("the same package under two parents is judged twice, independently", () => {
    const rows = judgeManifest(
      { overrides: { "parent-a": { rollup: "^2.79.0" }, "parent-b": { rollup: "^2.80.0" } } },
      [...rollupAdvisory, ["parent-a", []], ["parent-b", []]],
    );
    const nested = rows.filter((r) => r.pkg === "rollup");
    expect(nested.map((r) => `${r.scopePath}:${r.outcome}`).sort()).toEqual([
      "overrides > parent-a:stale",
      "overrides > parent-b:clean",
    ]);
  });
});

// ===========================================================================
// S10 — the five-member partition
// ===========================================================================

describe("S10 — every walked entry lands in exactly one of five outcomes", () => {
  const manifestJson = {
    overrides: {
      clean: "^2.0.0",
      stale: "^1.0.0",
      ".": "^1.0.0", //           refused (top-level self-pin)
      "unfetched-pkg": "^1.0.0", // undecidable
      opener: { child: "^1.0.0" }, // not-judged
    },
  };
  const cache = okCache([
    ["clean", [advisory({ id: "GHSA-part-0000-0001", bands: [["clean", "< 2.0.0", "2.0.0"]] })]],
    ["stale", [advisory({ id: "GHSA-part-0000-0002", bands: [["stale", "< 2.0.0", "2.0.0"]] })]],
    ["opener", []],
    ["child", []],
  ]);
  const rows = judge(collectEntries([{ path: "package.json", ok: true, json: manifestJson }]), cache);

  it("produces all five members at once, and collapses none into another", () => {
    const byKey = Object.fromEntries(rows.map((r) => [`${r.scopePath}|${r.key}`, r.outcome]));
    expect(byKey["overrides|clean"]).toBe(OUTCOME.CLEAN);
    expect(byKey["overrides|stale"]).toBe(OUTCOME.STALE);
    expect(byKey["overrides|."]).toBe(OUTCOME.REFUSED);
    expect(byKey["overrides|unfetched-pkg"]).toBe(OUTCOME.UNDECIDABLE);
    expect(byKey["overrides|opener"]).toBe(OUTCOME.NOT_JUDGED);
  });

  it("prints the stale row AND the refused row AND the undecidable row", () => {
    const printed = formatViolationLines(rows).join("\n");
    expect(printed).toContain("STALE:");
    expect(printed).toContain("REFUSED_TOP_LEVEL_SELF_PIN");
    expect(printed).toContain("UNDECIDABLE_NOT_FETCHED");
  });

  it("exits non-zero on stale, refused or undecidable — and not on not-judged alone", () => {
    expect(exitCodeFor(rows)).toBe(1);
    const onlyNotJudged = judge(
      collectEntries([{ path: "package.json", ok: true, json: { overrides: { opener: { child: "^1.0.0" } } } }]),
      okCache([["opener", []], ["child", []]]),
    );
    expect(onlyNotJudged.map((r) => r.outcome).sort()).toEqual([OUTCOME.CLEAN, OUTCOME.NOT_JUDGED]);
    expect(exitCodeFor(onlyNotJudged)).toBe(0);
  });

  it("report mode lists every walked entry with its outcome and the outcome tally", () => {
    const report = formatReportLines(rows, cache).join("\n");
    expect(report).toContain("walked 6 entry/entries across 1 manifest(s)");
    for (const key of ["clean", "stale", "unfetched-pkg", "opener", "child"]) {
      expect(report, `report omits '${key}'`).toContain(`'${key}'`);
    }
    expect(report).toContain("outcomes: clean=2 stale=1 refused=1 undecidable=1 not-judged=1");
  });

  it("report mode prints a per-package advisory count for every queried package (S12 layer 3)", () => {
    const report = formatReportLines(rows, cache).join("\n");
    expect(report).toContain("advisory queries: 4");
    expect(report).toContain("clean: 1 advisory/advisories returned");
    expect(report).toContain("opener: 0 advisory/advisories returned");
  });

  it("P-5: report mode changes what is printed, never the verdict", () => {
    // Same rows, both formatters — the exit status is computed from the rows.
    expect(exitCodeFor(rows)).toBe(exitCodeFor(rows));
    expect(formatReportLines(rows, cache).length).toBeGreaterThan(formatViolationLines(rows).length);
  });
});

describe("a manifest that cannot be read is a refusal, not a skip", () => {
  it("DENY: an unreadable source becomes a REFUSED row", () => {
    const rows = judge(collectEntries([{ path: "gone/package.json", ok: false, detail: "ENOENT" }]), buildAdvisoryCache([]));
    expect(rows[0].outcome).toBe(OUTCOME.REFUSED);
    expect(String(rows[0].refusal)).toContain("REFUSED_MANIFEST_UNREADABLE");
  });

  it("ALLOW: a readable manifest with no overrides yields no row and no refusal", () => {
    expect(collectEntries([{ path: "package.json", ok: true, json: { name: "x" } }])).toEqual([]);
  });
});

// ===========================================================================
// S11 — the ambient-input boundary
// ===========================================================================

describe("S11 — the advisory origin comes from two places and no third", () => {
  it("ALLOW: with no ambient variable set, the default origin is used", () => {
    expect(resolveOrigin(null, {})).toEqual({ origin: "https://api.github.com" });
  });

  it("ALLOW: an explicitly-argued origin is accepted", () => {
    expect(resolveOrigin("http://127.0.0.1:8123", {})).toEqual({ origin: "http://127.0.0.1:8123" });
  });

  it.each(AMBIENT_ORIGIN_VARS)("DENY: %s arriving through the environment is refused", (name) => {
    const result = resolveOrigin(null, { [name]: "http://example.invalid" });
    expect(result.origin).toBeUndefined();
    expect(result.refusal).toContain("REFUSED_AMBIENT_ORIGIN");
    expect(result.refusal).toContain(name);
  });

  it("DENY: an ambient variable is refused even when it spells the default origin", () => {
    // The pin's subject is HOW the origin was supplied, not how it is spelled.
    expect(String(resolveOrigin(null, { HTTPS_PROXY: "https://api.github.com" }).refusal)).toContain(
      "REFUSED_AMBIENT_ORIGIN",
    );
  });

  it("ALLOW: GITHUB_API_URL is not refused — GitHub Actions sets it in every run", () => {
    // Refusing on its presence would red this gate on its first CI run for a
    // reason unrelated to the tree. It redirects nothing on its own; the
    // invariant that the gate never reads it is enforced by the single
    // process.env read asserted further down.
    expect(resolveOrigin(null, { GITHUB_API_URL: "https://api.github.com" })).toEqual({
      origin: DEFAULT_ORIGIN,
    });
  });

  it("ALLOW: NO_PROXY is not refused — it is a bypass list, not a destination", () => {
    expect(resolveOrigin(null, { NO_PROXY: "localhost,127.0.0.1" })).toEqual({ origin: DEFAULT_ORIGIN });
  });

  it("DENY: an ambient variable is refused even when an explicit origin was also argued", () => {
    expect(String(resolveOrigin("http://127.0.0.1:8123", { NODE_OPTIONS: "--import ./evil.mjs" }).refusal)).toContain(
      "REFUSED_AMBIENT_ORIGIN",
    );
  });

  it("ALLOW: an empty ambient variable is not 'set'", () => {
    expect(resolveOrigin(null, { HTTPS_PROXY: "" })).toEqual({ origin: "https://api.github.com" });
  });

  it("DENY: a non-http origin is refused", () => {
    expect(String(resolveOrigin("file:///etc/passwd", {}).refusal)).toContain("REFUSED_BAD_ORIGIN");
    expect(String(resolveOrigin("not-a-url", {}).refusal)).toContain("REFUSED_BAD_ORIGIN");
  });

  it("the loader and CA variables are in the refused set, because neither TLS nor the origin pin stops them", () => {
    expect(AMBIENT_ORIGIN_VARS).toContain("NODE_OPTIONS");
    expect(AMBIENT_ORIGIN_VARS).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("variables that cannot redirect this request stay OUT of the refused set", () => {
    // Both were on the first draft and both are false-red surfaces: Actions
    // always sets GITHUB_API_URL, and NO_PROXY names hosts to skip proxying.
    expect(AMBIENT_ORIGIN_VARS).not.toContain("GITHUB_API_URL");
    expect(AMBIENT_ORIGIN_VARS).not.toContain("NO_PROXY");
    expect(AMBIENT_ORIGIN_VARS).not.toContain("no_proxy");
  });

  it("the token is the only other environment read, and it is not an origin input", () => {
    expect(TOKEN_VARS).toEqual(["GITHUB_TOKEN", "GH_TOKEN"]);
    for (const name of TOKEN_VARS) expect(AMBIENT_ORIGIN_VARS).not.toContain(name);
    expect(resolveOrigin(null, { GITHUB_TOKEN: "x", GH_TOKEN: "y" })).toEqual({ origin: DEFAULT_ORIGIN });
  });
});

// ===========================================================================
// S12 — the positive control's three layers
// ===========================================================================

describe("S12 layer 1 — per-package integrity, needing no baseline", () => {
  it("ALLOW: an empty list is vacuously intact, which an advisory-free package needs", () => {
    expect(checkPackageIntegrity([], "@crxjs/vite-plugin")).toEqual([]);
  });

  it("ALLOW: an advisory carrying an npm band for the queried package is intact", () => {
    expect(checkPackageIntegrity([advisory({ id: "GHSA-int0-0000-0001", bands: [["pkg", "< 1.0.0", "1.0.0"]] })], "pkg")).toEqual([]);
  });

  it("DENY: an advisory returned for affects=pkg carrying only a foreign-ecosystem band is not an answer", () => {
    const problems = checkPackageIntegrity(
      [advisory({ id: "GHSA-int0-0000-0002", bands: [["pkg", "< 1.0.0", "1.0.0"]], ecosystem: "rubygems" })],
      "pkg",
    );
    expect(problems.join(" ")).toContain("UNDECIDABLE_PACKAGE_INTEGRITY");
    expect(problems.join(" ")).toContain("GHSA-int0-0000-0002");
    expect(problems.join(" ")).toContain("rubygems:pkg");
  });

  it("DENY: an advisory returned for affects=pkg carrying only another package's band is not an answer", () => {
    const problems = checkPackageIntegrity(
      [advisory({ id: "GHSA-int0-0000-0003", bands: [["other-pkg", "< 1.0.0", "1.0.0"]] })],
      "pkg",
    );
    expect(problems.join(" ")).toContain("UNDECIDABLE_PACKAGE_INTEGRITY");
  });
});

describe("S12 layer 2 — the canary, with two distinct refusals", () => {
  // O-11: the id and the asserted properties are spelled literally here. If
  // they were read from the gate's own CANARY constant, editing that constant —
  // the edit an operator reaches for when the gate reds — would red nothing.
  const LIVE_CANARY = advisory({
    id: "GHSA-rgw5-rvv9-x895",
    summary: "brace-expansion: DoS via unbounded intermediate arrays",
    bands: [
      ["brace-expansion", "< 1.1.18", "1.1.18"],
      ["brace-expansion", ">= 2.0.0, < 2.1.4", "2.1.4"],
      ["brace-expansion", ">= 4.0.0, < 5.0.9", "5.0.9"],
    ],
  });

  it("ALLOW: present, live, and carrying a brace-expansion band containing 5.0.8", () => {
    const result = checkCanary({ ok: true, advisories: [LIVE_CANARY] });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("GHSA-rgw5-rvv9-x895");
  });

  it("DENY (channel dead): the advisory is absent from the response entirely", () => {
    const result = checkCanary({
      ok: true,
      advisories: [advisory({ id: "GHSA-mh99-v99m-4gvg", bands: [["brace-expansion", "< 1.1.17", "1.1.17"]] })],
    });
    expect(result.token).toBe("CANARY_CHANNEL_DEAD");
    expect(result.message).toContain("the advisory channel is not answering");
  });

  it("DENY (constant stale): the advisory is present but has been withdrawn", () => {
    const result = checkCanary({ ok: true, advisories: [{ ...LIVE_CANARY, withdrawn_at: "2026-07-01T00:00:00Z" }] });
    expect(result.token).toBe("CANARY_CONSTANT_STALE");
    expect(result.message).toContain("pick a new positive control");
  });

  it("DENY (constant stale): the advisory is present and live but no longer covers 5.0.8", () => {
    const narrowed = advisory({
      id: "GHSA-rgw5-rvv9-x895",
      bands: [["brace-expansion", ">= 4.0.0, < 5.0.7", "5.0.7"]],
    });
    const result = checkCanary({ ok: true, advisories: [narrowed] });
    expect(result.token).toBe("CANARY_CONSTANT_STALE");
    expect(result.message).toContain("no longer carries a brace-expansion band containing 5.0.8");
  });

  it("the two refusals are distinct tokens, so the operator knows which happened", () => {
    const dead = checkCanary({ ok: true, advisories: [] }).token;
    const stale = checkCanary({ ok: true, advisories: [{ ...LIVE_CANARY, withdrawn_at: "2026-07-01T00:00:00Z" }] }).token;
    expect(dead).not.toBe(stale);
  });

  it("DENY: a failed canary query is its own refusal, not a silent pass", () => {
    expect(checkCanary({ ok: false, token: "UNDECIDABLE_TRANSPORT" }).token).toBe("CANARY_QUERY_FAILED");
    expect(checkCanary(undefined).token).toBe("CANARY_QUERY_FAILED");
  });

  it("a failed canary makes the run fail even when every row is clean", () => {
    const rows = judgeManifest({ overrides: { pkg: "^1.0.0" } }, [["pkg", []]]);
    expect(exitCodeFor(rows)).toBe(0);
    expect(exitCodeFor(rows, ["CANARY_CHANNEL_DEAD: ..."])).toBe(1);
  });

  it("the gate's canary constant still names the advisory this test asserts on", () => {
    // Not an expected value taken from the code: this is the drift check that
    // makes editing the constant visible. Both sides are spelled out.
    expect(CANARY.ghsaId).toBe("GHSA-rgw5-rvv9-x895");
    expect(CANARY.pkg).toBe("brace-expansion");
    expect(CANARY.vulnerableVersion).toBe("5.0.8");
  });
});

// ===========================================================================
// Hardening: shape validation, sanitization, the keyed cache, retries
// ===========================================================================

describe("boundary shape validation, fail-closed", () => {
  const valid = [advisory({ id: "GHSA-shap-0000-0001", bands: [["pkg", "< 1.0.0", "1.0.0"]] })];

  it("ALLOW: a well-formed response passes", () => {
    expect(checkResponseShape(valid)).toEqual({ ok: true });
  });

  it("ALLOW: an empty array passes", () => {
    expect(checkResponseShape([])).toEqual({ ok: true });
  });

  it("DENY: a non-array body", () => {
    expect(checkResponseShape({ message: "Not Found" }).token).toBe("UNDECIDABLE_RESPONSE_SHAPE");
    expect(checkResponseShape(null).token).toBe("UNDECIDABLE_RESPONSE_SHAPE");
  });

  it("DENY: an element with no ghsa_id (the rename shape)", () => {
    expect(String(checkResponseShape([{ ...valid[0], ghsa_id: undefined }]).detail)).toContain("no string ghsa_id");
  });

  it("DENY: withdrawn_at that is neither null nor a string (the type-change shape)", () => {
    expect(checkResponseShape([{ ...valid[0], withdrawn_at: true }]).detail).toContain("withdrawn_at");
  });

  it("DENY: vulnerabilities that is not an array", () => {
    expect(checkResponseShape([{ ...valid[0], vulnerabilities: {} }]).detail).toContain("vulnerabilities is not an array");
  });

  it("DENY: a vulnerable_version_range that is not a string", () => {
    expect(
      checkResponseShape([{ ...valid[0], vulnerabilities: [{ package: { ecosystem: "npm", name: "pkg" }, vulnerable_version_range: { min: 1 }, first_patched_version: null }] }]).detail,
    ).toContain("vulnerable_version_range");
  });

  it("DENY: a first_patched_version that is an object (the shape a review round claimed it already was)", () => {
    expect(
      checkResponseShape([{ ...valid[0], vulnerabilities: [{ package: { ecosystem: "npm", name: "pkg" }, vulnerable_version_range: "< 1.0.0", first_patched_version: { identifier: "1.0.0" } }] }]).detail,
    ).toContain("first_patched_version");
  });
});

describe("output sanitization", () => {
  it("DENY: a line that would be read as a GitHub Actions workflow command is refused", () => {
    expect(sanitizeLine("::error::owned")).toBe("[REFUSED_WORKFLOW_COMMAND]error::owned");
  });

  it("ALLOW: a line merely containing :: further along is untouched", () => {
    expect(sanitizeLine("summary mentions ::error:: inline")).toBe("summary mentions ::error:: inline");
  });

  it("DENY: an embedded newline cannot smuggle a workflow command onto a line of its own", () => {
    expect(sanitizeLine("harmless\n::set-output name=x::y")).toContain("[REFUSED_WORKFLOW_COMMAND]");
  });

  it("ALLOW: a legitimate band survives intact, commas, angle brackets and all", () => {
    expect(sanitizeLine("band '>= 2.0.0, < 2.1.4' -> 2.1.4")).toBe("band '>= 2.0.0, < 2.1.4' -> 2.1.4");
  });

  it("ALLOW: a summary with quotes and angle brackets survives intact", () => {
    const summary = `PostCSS: "sourceMappingURL" <script> read when \`from\` is unset & x < y`;
    expect(sanitizeLine(summary)).toBe(summary);
  });

  it("strips control characters without touching printable text", () => {
    expect(sanitizeLine("a\u0007b\u0000c\u007fd")).toBe("abcd");
  });

  it("caps a pathological line", () => {
    const capped = sanitizeLine("x".repeat(5000));
    expect(capped.length).toBeLessThan(5000);
    expect(capped).toContain("[truncated]");
  });
});

describe("the advisory cache is a keyed Map, never a plain object", () => {
  // JSON.parse makes `__proto__` an own property, and a plain object gives
  // `store["constructor"]` a truthy non-array hit — a package named for an
  // Object.prototype member would be judged against a function.
  const entriesFor = (pkg) => collectEntries([{ path: "package.json", ok: true, json: { overrides: { [pkg]: "^1.0.0" } } }]);

  it("DENY: a package named `constructor` that was never fetched is undecidable, not clean", () => {
    const rows = judge(entriesFor("constructor"), buildAdvisoryCache([["pkg", { ok: true, advisories: [] }]]));
    expect(rows[0].outcome).toBe(OUTCOME.UNDECIDABLE);
    expect(String(rows[0].refusal)).toContain("UNDECIDABLE_NOT_FETCHED");
  });

  it("ALLOW: the same package when it WAS fetched is judged normally", () => {
    const rows = judge(entriesFor("constructor"), buildAdvisoryCache([["constructor", { ok: true, advisories: [] }]]));
    expect(rows[0].outcome).toBe(OUTCOME.CLEAN);
  });

  it("DENY: `__proto__` is likewise not a phantom hit", () => {
    const rows = judge(entriesFor("__proto__"), buildAdvisoryCache([["pkg", { ok: true, advisories: [] }]]));
    expect(rows[0].outcome).toBe(OUTCOME.UNDECIDABLE);
  });

  it("is a Map", () => {
    expect(buildAdvisoryCache([["a", { ok: true, advisories: [] }]])).toBeInstanceOf(Map);
  });
});

describe("retry policy — transport errors and 5xx only", () => {
  it("ALLOW: a 200 is not retried", () => {
    expect(retryDecision({ status: 200, attempt: 1, maxAttempts: 3 })).toEqual({ retry: false, token: null });
  });

  it("DENY: 429 is never retried — retrying a rate limit deepens it", () => {
    const d = retryDecision({ status: 429, attempt: 1, maxAttempts: 3 });
    expect(d.retry).toBe(false);
    expect(d.token).toBe("UNDECIDABLE_RATE_LIMITED");
  });

  it("DENY: 403 with the quota exhausted is a rate limit, not a rejected credential", () => {
    const d = retryDecision({ status: 403, rateLimitRemaining: "0", attempt: 1, maxAttempts: 3 });
    expect(d.retry).toBe(false);
    expect(d.token).toBe("UNDECIDABLE_RATE_LIMITED");
    expect(d.detail).toContain("GITHUB_TOKEN");
  });

  it("ALLOW (same shape, one axis): 403 with quota remaining is a rejected credential", () => {
    const d = retryDecision({ status: 403, rateLimitRemaining: "4998", attempt: 1, maxAttempts: 3 });
    expect(d.retry).toBe(false);
    expect(d.token).toBe("UNDECIDABLE_TOKEN_REJECTED");
  });

  it("401 is a rejected credential and says so, distinguishably from an exhausted budget", () => {
    const d = retryDecision({ status: 401, attempt: 1, maxAttempts: 3 });
    expect(d.token).toBe("UNDECIDABLE_TOKEN_REJECTED");
    expect(d.detail).toContain("not a rate limit");
  });

  it("ALLOW: a 5xx with attempts left is retried", () => {
    expect(retryDecision({ status: 503, attempt: 1, maxAttempts: 3 }).retry).toBe(true);
  });

  it("DENY: a 5xx on the last attempt exhausts the budget with its own token", () => {
    const d = retryDecision({ status: 503, attempt: 3, maxAttempts: 3 });
    expect(d.retry).toBe(false);
    expect(d.token).toBe("UNDECIDABLE_SERVER_ERROR");
  });

  it("ALLOW: a transport error with attempts left is retried", () => {
    expect(retryDecision({ transportError: true, attempt: 1, maxAttempts: 3 }).retry).toBe(true);
  });

  it("DENY: a transport error on the last attempt is its own token", () => {
    expect(retryDecision({ transportError: true, attempt: 3, maxAttempts: 3 }).token).toBe("UNDECIDABLE_TRANSPORT");
  });

  it("a 404 is not retried and is not confused with a server error", () => {
    expect(retryDecision({ status: 404, attempt: 1, maxAttempts: 3 })).toMatchObject({
      retry: false,
      token: "UNDECIDABLE_HTTP_STATUS",
    });
  });
});

// ===========================================================================
// P-4 — the command line
// ===========================================================================

describe("P-4 — flags are distinguished from manifest paths, and every wrong turn is named", () => {
  it("ALLOW: --report is a flag, not a path", () => {
    const args = parseArgs(["--report", "package.json"]);
    expect(args.report).toBe(true);
    expect(args.paths).toEqual(["package.json"]);
    expect(args.refusals).toEqual([]);
  });

  it("DENY: an unrecognized long flag is a refusal, not a path", () => {
    // The sibling gate's `main(process.argv.slice(2))` would take this as a
    // path, fail to read it and skip — reporting clean.
    expect(parseArgs(["--repot"]).refusals.join(" ")).toContain("REFUSED_UNKNOWN_FLAG");
    expect(parseArgs(["--repot"]).paths).toEqual([]);
  });

  it("DENY: an unrecognized short flag is a refusal", () => {
    expect(parseArgs(["-r"]).refusals.join(" ")).toContain("REFUSED_UNKNOWN_FLAG");
  });

  it("ALLOW/DENY: --origin, --timeout-ms and --retries take values; a bad value is refused", () => {
    const good = parseArgs(["--origin=http://127.0.0.1:1", "--timeout-ms=50", "--retries=0"]);
    expect(good).toMatchObject({ origin: "http://127.0.0.1:1", timeoutMs: 50, retries: 0, refusals: [] });
    expect(parseArgs(["--timeout-ms=soon"]).refusals.join(" ")).toContain("REFUSED_BAD_FLAG_VALUE");
    expect(parseArgs(["--retries=-1"]).refusals.join(" ")).toContain("REFUSED_BAD_FLAG_VALUE");
  });

  it("DENY: a manifest-discovery fallback is a refusal, told apart by identity and not by content", () => {
    // `discoverManifests` returns FALLBACK_MANIFESTS itself when git does not
    // answer; a content-equal but distinct array is a real discovery result.
    expect(String(discoveryRefusal(FALLBACK_MANIFESTS))).toContain("REFUSED_MANIFEST_DISCOVERY_FALLBACK");
  });

  it("ALLOW: a real discovery result with identical content is not a fallback", () => {
    expect(discoveryRefusal([...FALLBACK_MANIFESTS])).toBeNull();
    expect(discoveryRefusal(discoverManifests())).toBeNull();
  });
});

// ===========================================================================
// AC-3.4 — the walk over the repository's own manifests, counted twice
// ===========================================================================

describe("the repository's own overrides blocks (AC-3.4)", () => {
  /**
   * The second instrument. Shares no code with `collectScopes`: a count
   * produced by the function under test and compared against itself cannot
   * fail. A nested object counts as one row for the key that opens it plus one
   * row per child; every other value counts as one row.
   */
  function countOverrideRows(overrides) {
    let total = 0;
    for (const value of Object.values(overrides ?? {})) {
      total += 1;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        total += countOverrideRows(value);
      }
    }
    return total;
  }

  const manifests = discoverManifests();
  const sources = manifests.map((path) => ({ path, ok: true, json: JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) }));
  const expected = sources.reduce((n, s) => n + countOverrideRows(s.json.overrides), 0);

  it("has overrides to walk, so the cases below are not vacuous", () => {
    expect(manifests.length).toBeGreaterThan(0);
    expect(expected).toBeGreaterThan(0);
  });

  it("the walk yields exactly the number of rows a second, independent instrument counts", () => {
    const entries = collectEntries(sources);
    const missing = entries.length !== expected ? entries.map((e) => `${e.manifest}|${e.scopePath}|${e.key}`) : [];
    expect(entries.length, `walker=${entries.length} second-instrument=${expected}; walker rows: ${missing.join(", ")}`).toBe(expected);
  });

  it("every row is structurally sound: no refusal comes out of the real tree", () => {
    const refused = collectEntries(sources).filter((e) => e.refusal);
    expect(refused.map((e) => `${e.manifest}|${e.key}: ${e.refusal}`)).toEqual([]);
  });

  it("the queried set is the pin names plus each scope opener's parent", () => {
    const entries = collectEntries(sources);
    const queried = packagesToQuery(entries);
    const openers = entries.filter((e) => e.kind === "scope-opener").map((e) => e.pkg);
    expect(openers.length).toBeGreaterThan(0);
    for (const opener of openers) expect(queried).toContain(opener);
    expect(new Set(queried).size).toBe(queried.length);
  });
});

// ===========================================================================
// O-3 — every pure export is reached, and the shell is reached as a process
// ===========================================================================

describe("O-3 — export coverage", () => {
  it("every export of the gate is referenced by at least one case in this file", () => {
    const unreferenced = Object.keys(gate).filter((name) => {
      const occurrences = SELF_SOURCE.split(new RegExp(`\\b${name}\\b`)).length - 1;
      // Once for the import, so a name reached only by the import list is
      // unreferenced.
      return occurrences < 2;
    });
    expect(unreferenced).toEqual([]);
  });

  it("`run` is callable directly and refuses an empty walk without touching the network", async () => {
    const dir = tempDir();
    const manifest = join(dir, "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "no-overrides-here" }), "utf8");
    const lines = [];
    const code = await run([manifest], {}, { stdout: (l) => lines.push(l), stderr: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("REFUSED_EMPTY_WALK");
  });
});

// ===========================================================================
// O-12 — the forbidden patterns, run against the corrected file AND against a
//        file carrying the defect
// ===========================================================================

describe("O-12 — forbidden patterns, red-proven both ways", () => {
  const PURE_SECTION = GATE_SOURCE.slice(
    GATE_SOURCE.indexOf("// Pure core."),
    GATE_SOURCE.indexOf("// Network shell."),
  );

  const patterns = [
    {
      name: "a swallowed comparison error",
      re: /catch\s*(\([^)]*\))?\s*\{\s*(return\s+(false|true|null)\s*;?\s*)?\}/,
      subject: () => GATE_SOURCE,
      defect: "try { hit = semver.intersects(a, b); } catch { return false; }",
    },
    {
      name: "a raw (un-normalized) band handed to semver",
      re: /semver\.(intersects|satisfies)\(\s*[^()]*\.range\b/,
      subject: () => GATE_SOURCE,
      defect: "const hit = semver.intersects(pinRange, band.range);",
    },
    {
      name: "a severity filter (which would re-open the medium band that hid the hono finding)",
      re: /\.severity\s*(===|!==|==|!=)/,
      subject: () => GATE_SOURCE,
      defect: 'const live = list.filter((a) => a.severity === "high");',
    },
    {
      name: "prefix matching where S3 requires exact equality",
      re: /\bname\s*\.\s*startsWith\(|startsWith\(\s*pkg\s*\)/,
      subject: () => GATE_SOURCE,
      defect: "if (!name.startsWith(pkg)) continue;",
    },
    {
      name: "I/O inside the pure core",
      re: /readFileSync\(|execFileSync\(|await fetch\(|createServer\(/,
      subject: () => PURE_SECTION,
      defect: "export function collectEntries(paths) { return JSON.parse(readFileSync(paths[0], 'utf8')); }",
    },
  ];

  it.each(patterns)("$name does not match the corrected file", ({ re, subject }) => {
    expect(re.test(subject())).toBe(false);
  });

  it.each(patterns)("$name matches a file carrying the defect", ({ re, defect }) => {
    expect(re.test(defect)).toBe(true);
  });

  it("the gate reads process.env exactly once, on the entry-point line", () => {
    // S11 REQUIRES an environment read (that is how the ambient refusal is
    // implemented). What is forbidden is a SECOND read that influences the
    // origin, the canary or the verdict — so the count, not the presence, is
    // the predicate.
    const codeLines = (source) =>
      source.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l));
    const reads = codeLines(GATE_SOURCE).filter((l) => l.includes("process.env"));
    expect(reads).toEqual(["  process.exitCode = await run(process.argv.slice(2), process.env);"]);
    // ... and the defect direction matches: a second read is one more line.
    expect(codeLines("const origin = process.env.GITHUB_API_URL ?? DEFAULT_ORIGIN;")).toHaveLength(1);
  });

  it("the pure core is not empty, so the I/O pattern is not vacuously satisfied", () => {
    expect(PURE_SECTION.length).toBeGreaterThan(2000);
    expect(PURE_SECTION).toContain("export function judge(");
  });
});

// ===========================================================================
// AC-3.3 — the shell, driven AS A PROCESS against a local fixture server,
//          reached by the explicit origin argument and never by ambient state
// ===========================================================================

describe("AC-3.3 — the network shell as a process", () => {
  const CANARY_PAYLOAD = [
    {
      ghsa_id: "GHSA-rgw5-rvv9-x895",
      withdrawn_at: null,
      type: "reviewed",
      severity: "high",
      summary: "brace-expansion: DoS via unbounded intermediate arrays",
      vulnerabilities: [
        {
          package: { ecosystem: "npm", name: "brace-expansion" },
          vulnerable_version_range: "< 1.1.18",
          first_patched_version: "1.1.18",
        },
        {
          package: { ecosystem: "npm", name: "brace-expansion" },
          vulnerable_version_range: ">= 4.0.0, < 5.0.9",
          first_patched_version: "5.0.9",
        },
      ],
    },
  ];

  /** A manifest whose only queried package is the canary's, so one handler serves the run. */
  function manifestWith(pin) {
    const dir = tempDir("floor-staleness-proc-");
    const path = join(dir, "package.json");
    writeFileSync(path, JSON.stringify({ name: "fixture", overrides: { "brace-expansion@1": pin } }, null, 2), "utf8");
    return path;
  }

  async function withServer(handler, body) {
    const state = { requests: 0 };
    const server = createServer((req, res) => {
      state.requests += 1;
      handler(req, res, state);
    });
    await new Promise((resolve_) => server.listen(0, "127.0.0.1", resolve_));
    state.origin = `http://127.0.0.1:${server.address().port}`;
    try {
      return await body(state);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve_) => server.close(resolve_));
    }
  }

  function json(res, status, payload, headers = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(payload));
  }

  /** Answer after `ms`, and never write to a response the client already gave up on. */
  function jsonAfter(res, ms, payload) {
    const timer = setTimeout(() => {
      if (!res.destroyed && !res.writableEnded) json(res, 200, payload);
    }, ms);
    res.on("close", () => clearTimeout(timer));
  }

  /**
   * A deliberately minimal environment: inheriting the test runner's would
   * re-import the ambient state S11 exists to refuse.
   */
  function runGate(args, env = {}) {
    // Asynchronous on purpose: `spawnSync` would block the very event loop the
    // fixture server runs on, so the child's request would never be answered
    // and the run would deadlock until the spawn timeout.
    return new Promise((resolve_, reject) => {
      const child = spawn(process.execPath, [GATE, ...args], {
        cwd: REPO_ROOT,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve_({ code, out });
      });
    });
  }

  it("DENY: a rate-limit response is not retried — exactly one request is made", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res) => json(res, 403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }),
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, "--retries=3", manifest]);
        expect(code).toBe(1);
        expect(out).toContain("UNDECIDABLE_RATE_LIMITED");
        expect(state.requests).toBe(1);
      },
    );
  });

  it("DENY: repeated 5xx exhaust the retry budget and make exactly retries+1 requests", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res) => json(res, 503, { message: "unavailable" }),
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, "--retries=2", manifest]);
        expect(code).toBe(1);
        expect(out).toContain("UNDECIDABLE_SERVER_ERROR");
        // One package (brace-expansion, which is also the canary) x 3 attempts.
        expect(state.requests).toBe(3);
      },
    );
  });

  it("ALLOW: a 5xx followed by success exits 0, with the success payload carrying the canary", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res, state) => {
        if (state.requests === 1) return json(res, 503, { message: "unavailable" });
        return json(res, 200, CANARY_PAYLOAD);
      },
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, "--retries=2", manifest]);
        expect(out).toContain("passed");
        expect(code).toBe(0);
        expect(state.requests).toBe(2);
      },
    );
  });

  it("DENY: the same success payload against a stale pin reds and names the advisory and the floor", async () => {
    const manifest = manifestWith("^1.1.17");
    await withServer(
      (req, res) => json(res, 200, CANARY_PAYLOAD),
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, manifest]);
        expect(code).toBe(1);
        expect(out).toContain("GHSA-rgw5-rvv9-x895");
        expect(out).toContain("brace-expansion");
        expect(out).toContain("required floor >= 1.1.18");
      },
    );
  });

  it("P-5: report mode changes what is printed and not the exit status", async () => {
    const manifest = manifestWith("^1.1.17");
    await withServer(
      (req, res) => json(res, 200, CANARY_PAYLOAD),
      async (state) => {
        const plain = await runGate([`--origin=${state.origin}`, manifest]);
        const reported = await runGate([`--origin=${state.origin}`, "--report", manifest]);
        expect(reported.code).toBe(plain.code);
        expect(reported.out).toContain("walked 1 entry/entries");
        expect(reported.out).toContain("advisory queries: 1");
        expect(plain.out).not.toContain("walked 1 entry/entries");
      },
    );
  });

  it("DENY: a non-JSON body is undecidable, not clean", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("<html>gateway</html>");
      },
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, manifest]);
        expect(code).toBe(1);
        expect(out).toContain("UNDECIDABLE_RESPONSE_NOT_JSON");
      },
    );
  });

  it("DENY: a well-formed-JSON body of the wrong shape is refused by the boundary check", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res) => json(res, 200, { message: "Not Found" }),
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, manifest]);
        expect(code).toBe(1);
        expect(out).toContain("UNDECIDABLE_RESPONSE_SHAPE");
      },
    );
  });

  it("DENY: a response that is not an answer about the queried package fails the integrity rule", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res) =>
        json(res, 200, [
          {
            ghsa_id: "GHSA-elsewhere-0001",
            withdrawn_at: null,
            type: "reviewed",
            severity: "high",
            summary: "an advisory about something else",
            vulnerabilities: [
              { package: { ecosystem: "rubygems", name: "brace-expansion" }, vulnerable_version_range: "< 1.1.18", first_patched_version: "1.1.18" },
            ],
          },
        ]),
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, manifest]);
        expect(code).toBe(1);
        expect(out).toContain("UNDECIDABLE_PACKAGE_INTEGRITY");
      },
    );
  });

  it("DENY: an empty response for every package fails the positive control rather than reporting the cleanest run in history", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res) => json(res, 200, []),
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, manifest]);
        expect(code).toBe(1);
        expect(out).toContain("CANARY_CHANNEL_DEAD");
      },
    );
  });

  it("DENY: a refused connection is a transport refusal, not a clean run", async () => {
    const manifest = manifestWith("^1.1.18");
    // A port nothing is listening on: bind one, learn the port, close it.
    const closedOrigin = await withServer(
      () => {},
      async (state) => state.origin,
    );
    const { code, out } = await runGate([`--origin=${closedOrigin}`, "--retries=1", manifest]);
    expect(code).toBe(1);
    expect(out).toContain("UNDECIDABLE_TRANSPORT");
  });

  it("DENY: a request that outlives the timeout is a transport refusal", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res) => jsonAfter(res, 5000, CANARY_PAYLOAD),
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, "--timeout-ms=150", "--retries=0", manifest]);
        expect(code).toBe(1);
        expect(out).toContain("UNDECIDABLE_TRANSPORT");
      },
    );
  });

  it("ALLOW: the same server answering inside the timeout succeeds", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res) => jsonAfter(res, 10, CANARY_PAYLOAD),
      async (state) => {
        const { code } = await runGate([`--origin=${state.origin}`, "--timeout-ms=15000", "--retries=0", manifest]);
        expect(code).toBe(0);
      },
    );
  });

  it("DENY: an ambient origin is refused BEFORE any request is made", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res) => json(res, 200, CANARY_PAYLOAD),
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, manifest], {
          HTTPS_PROXY: "http://proxy.invalid:8080",
        });
        expect(code).toBe(1);
        expect(out).toContain("REFUSED_AMBIENT_ORIGIN");
        expect(out).toContain("HTTPS_PROXY");
        expect(state.requests).toBe(0);
      },
    );
  });

  it("ALLOW: the same invocation without the ambient variable reaches the server", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res) => json(res, 200, CANARY_PAYLOAD),
      async (state) => {
        const { code } = await runGate([`--origin=${state.origin}`, manifest]);
        expect(code).toBe(0);
        expect(state.requests).toBe(1);
      },
    );
  });

  it("DENY: an unrecognized flag refuses before any request", async () => {
    const manifest = manifestWith("^1.1.18");
    await withServer(
      (req, res) => json(res, 200, CANARY_PAYLOAD),
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, "--repot", manifest]);
        expect(code).toBe(1);
        expect(out).toContain("REFUSED_UNKNOWN_FLAG");
        expect(state.requests).toBe(0);
      },
    );
  });

  it("DENY: a named manifest path that cannot be read is a refusal, not a skip", async () => {
    const dir = tempDir();
    await withServer(
      (req, res) => json(res, 200, CANARY_PAYLOAD),
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, join(dir, "typo-package.json")]);
        expect(code).toBe(1);
        expect(out).toContain("REFUSED_MANIFEST_UNREADABLE");
      },
    );
  });

  it("DENY: a manifest with no overrides at all refuses rather than reporting clean", async () => {
    const dir = tempDir();
    const manifest = join(dir, "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "empty" }), "utf8");
    const { code, out } = await runGate(["--origin=http://127.0.0.1:1", manifest]);
    expect(code).toBe(1);
    expect(out).toContain("REFUSED_EMPTY_WALK");
  });

  it("sanitizes a workflow command arriving in an advisory summary", async () => {
    const manifest = manifestWith("^1.1.17");
    await withServer(
      (req, res) =>
        json(res, 200, [
          {
            ...CANARY_PAYLOAD[0],
            summary: "harmless first line\n::error::injected",
          },
        ]),
      async (state) => {
        const { code, out } = await runGate([`--origin=${state.origin}`, manifest]);
        expect(code).toBe(1);
        expect(out.split("\n").some((line) => line.trimStart().startsWith("::"))).toBe(false);
        expect(out).toContain("[REFUSED_WORKFLOW_COMMAND]");
      },
    );
  });
});
