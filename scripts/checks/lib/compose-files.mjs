/**
 * The tracked-compose-file discovery, in a module with no top-level await so a
 * CommonJS caller (tsx running check-compose-render.ts) can import it.
 */
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * All four filenames Compose accepts by default, plus their overlay variants.
 * `docker-compose*.yml` alone is NOT the member set: Compose reads
 * `compose.yaml` in PREFERENCE to `docker-compose.yml`, so a project could keep
 * a capped `docker-compose.yml` that Compose ignores entirely while an uncapped
 * `compose.yaml` is what actually runs — and a guard scoped to the first
 * spelling would pass having examined the file nobody uses.
 */
const COMPOSE_FILE_RE = /(^|\/)(docker-)?compose.*\.ya?ml$/;
// Leading `*` so the pathspec is not anchored at the repo root — `deploy/
// docker-compose.yml` is a tracked compose file and was invisible to the gate.
export const GIT_PATHSPECS = [
  "*docker-compose*.yml",
  "*docker-compose*.yaml",
  "*compose*.yml",
  "*compose*.yaml",
];

/**
 * Tracked compose files. `git ls-files` keeps an untracked scratch copy out of
 * the member set; the readdir fallback covers a source tarball. An empty result
 * is a refusal, not a pass — a guard that examined nothing must not report the
 * same thing as a guard that found nothing wrong.
 */
/**
 * Compose files that are inputs to a test rather than stacks anyone runs.
 *
 * An explicit path list, not a `__tests__`/`fixtures` path-segment rule. That
 * rule was a hole shaped exactly like the one this gate exists to close: a
 * production stack parked at `deploy/fixtures/docker-compose.yml` would have
 * been excluded from the scan by its directory name. Two entries is a small
 * enough set to name, and naming them means adding a third is a reviewable act.
 */
export const FIXTURE_ALLOW = [
  {
    path: "scripts/__tests__/fixtures/env-drift/compose-missing/docker-compose.yml",
    reason: "input to check-env-docs' self-test; never started",
  },
  {
    path: "scripts/__tests__/fixtures/env-drift/stale-allowlist/docker-compose.yml",
    reason: "input to check-env-docs' self-test; never started",
  },
];

const FIXTURE_PATHS = new Set(FIXTURE_ALLOW.map((f) => f.path));

export function isTestFixturePath(relPath) {
  return FIXTURE_PATHS.has(relPath);
}

/** Tracked compose paths, repo-relative, BEFORE the fixture allowlist is applied. */
export function listTrackedComposePaths(root = ".") {
  try {
    return execFileSync("git", ["ls-files", "-z", ...GIT_PATHSPECS], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function findComposeFiles(root = ".") {
  try {
    const tracked = execFileSync("git", ["ls-files", "-z", ...GIT_PATHSPECS], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
    if (tracked.length > 0) {
      return [...new Set(tracked)]
        .filter((f) => !isTestFixturePath(f))
        .map((f) => join(root, f));
    }
  } catch {
    // not a git checkout, or git is absent
  }
  // Recursive, matching the git pathspec above. A top-level-only fallback would
  // make the source-tarball path quietly weaker than the checkout path — and
  // that asymmetry is invisible until it matters.
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!isTestFixturePath(childRel)) walk(join(dir, e.name), childRel);
        continue;
      }
      if (e.isFile() && COMPOSE_FILE_RE.test(e.name) && !isTestFixturePath(childRel)) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(root, "");
  return out;
}
