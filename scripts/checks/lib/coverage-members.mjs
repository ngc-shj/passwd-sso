/**
 * The coverage member set: every production TS file that unit coverage must
 * measure. One definition, shared by check-coverage-scope (does vitest measure
 * every member?) and check-coverage-ignore-hints (does any member opt a line
 * out of measurement?), so the two cannot drift onto different sets.
 *
 * The matchers below are vitest's own: `scopeMatcher` mirrors
 * `BaseCoverageProvider.getGlobMatchers` and `checkThresholdKeys` mirrors
 * `resolveThresholds` (vitest/dist/chunks/cli-api.*.js), using the picomatch
 * that vitest itself resolves. A hand-written glob translator would answer a
 * different question than the provider does — e.g. `dot: true` is what lets
 * `src/app/api/mcp/.well-known/**` into scope.
 *
 * Background: docs/archive/review/close-coverage-and-clipboard-gaps-plan.md, C1.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const MEMBER_PATHSPECS = [
  ":(glob)src/**/*.ts",
  ":(glob)src/**/*.tsx",
  "proxy.ts",
  "instrumentation-client.ts",
  "sentry.client.config.ts",
  "sentry.server.config.ts",
];

const NON_MEMBER = /\.(test|spec)\.|\/__tests__\/|\.d\.ts$/;

// A pathspec typo or a moved root file shrinks the set without emptying it, so
// a non-empty result is not evidence the set is whole. These four anchor it:
// the two src/ entry points and two of the root runtime files.
export const REQUIRED_MEMBERS = ["src/proxy.ts", "src/auth.ts", "proxy.ts", "sentry.server.config.ts"];
export const MIN_MEMBERS = 1000;

// Keys `resolveThresholds` skips: they configure the run, they are not globs.
const RESERVED_THRESHOLD_KEYS = new Set([
  "perFile",
  "autoUpdate",
  "100",
  "lines",
  "functions",
  "statements",
  "branches",
]);

const vitestRequire = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
const pm = vitestRequire("picomatch");

function gitLsFiles(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * `exec(args)` runs git with `args` and returns its stdout; injectable so the
 * self-test can drive every refusal without a broken repository.
 */
export function listMembers(exec = gitLsFiles) {
  let stdout;
  try {
    stdout = exec(["ls-files", "-z", "--", ...MEMBER_PATHSPECS]);
  } catch (err) {
    throw new Error(`COVERAGE_MEMBERS_GIT_ERROR: git ls-files failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const members = String(stdout)
    .split("\0")
    .filter((p) => p.length > 0 && !NON_MEMBER.test(p))
    .sort();
  if (members.length === 0) {
    throw new Error("COVERAGE_MEMBERS_EMPTY: the member pathspecs matched no file");
  }
  if (members.length < MIN_MEMBERS) {
    throw new Error(`COVERAGE_MEMBERS_TOO_FEW: ${members.length} members, expected at least ${MIN_MEMBERS}`);
  }
  const present = new Set(members);
  const absent = REQUIRED_MEMBERS.filter((p) => !present.has(p));
  if (absent.length > 0) {
    throw new Error(`COVERAGE_MEMBERS_REQUIRED_ABSENT: ${absent.join(", ")}`);
  }
  return members;
}

export function scopeMatcher(include, exclude = []) {
  const matchExclude = exclude.length ? pm(exclude, { dot: true }) : () => false;
  const matchInclude = include ? pm(include, { dot: true, ignore: exclude }) : () => true;
  return (file) => !matchExclude(file) && matchInclude(file);
}

/** Members the coverage options `{ include, exclude }` leave out of scope. */
export function checkScope(config, members) {
  const inScope = scopeMatcher(config.include, config.exclude ?? []);
  return members.filter((m) => !inScope(m));
}

/**
 * Threshold keys that would silently floor nothing: an exact path must name
 * exactly one member, a glob at least one. Returns one message per bad key.
 */
export function checkThresholdKeys(thresholds, members) {
  if (thresholds === undefined || thresholds === null || typeof thresholds !== "object") {
    throw new Error("COVERAGE_THRESHOLDS_MISSING: no thresholds object to check");
  }
  if (Object.keys(thresholds).length === 0) {
    throw new Error("COVERAGE_THRESHOLDS_EMPTY: the thresholds object has no keys");
  }
  const problems = [];
  for (const key of Object.keys(thresholds)) {
    if (RESERVED_THRESHOLD_KEYS.has(key)) continue;
    const matcher = pm(key);
    const count = members.filter((m) => matcher(m)).length;
    if (pm.scan(key).isGlob) {
      if (count === 0) problems.push(`COVERAGE_THRESHOLD_GLOB_UNMATCHED: "${key}" matches no member`);
    } else if (count !== 1) {
      problems.push(`COVERAGE_THRESHOLD_PATH_UNMATCHED: "${key}" matches ${count} members, expected exactly 1`);
    }
  }
  return problems;
}

/** Members absent from a json-summary report whose keys are absolute paths under `root`. */
export function checkSummary(summaryJson, members, root) {
  const measured = new Set(
    Object.keys(summaryJson)
      .filter((k) => k !== "total")
      .map((k) => (isAbsolute(k) ? relative(root, k) : k).split("\\").join("/")),
  );
  return members.filter((m) => !measured.has(m));
}
