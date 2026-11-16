/**
 * The tracked-compose-file discovery, in a module with no top-level await so a
 * CommonJS caller (tsx running check-compose-render.ts) can import it.
 */
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * The one member predicate, on the repo-relative path: any `.yml`/`.yaml` whose
 * path contains `compose`. Both discovery paths (the tracked listing and the
 * readdir walk) apply this same function, so they cannot disagree on the member
 * set. It is the wider of the two spellings the code used to keep: the git
 * pathspec `*compose*.yml` also matched a file named `my-compose.yml` or one in
 * a `deploy/compose/` directory, which the basename regex
 * `(docker-)?compose*` did not. For a gate whose failure mode is an unexamined
 * stack, an extra candidate is a loud, fixable false positive (the render check
 * names a file no render set renders), and a missed one is a silent green.
 * Compose reads `compose.yaml` in preference to `docker-compose.yml`, and `-f`
 * takes any name, so the `docker-compose*.yml` spelling alone is not the set.
 */
const COMPOSE_PATH_RE = /compose.*\.ya?ml$/;

export function isComposePath(relPath) {
  return COMPOSE_PATH_RE.test(relPath);
}

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
    // No pathspec: git's glob would be a second spelling of the predicate.
    return execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((f) => f !== "" && isComposePath(f));
  } catch {
    return [];
  }
}

export function findComposeFiles(root = ".") {
  const tracked = listTrackedComposePaths(root);
  if (tracked.length > 0) {
    return [...new Set(tracked)]
      .filter((f) => !isTestFixturePath(f))
      .map((f) => join(root, f));
  }
  return walkComposeFiles(root);
}

/**
 * The source-tarball path: every file under `root` that isComposePath accepts.
 * Recursive like the tracked listing — a top-level-only walk would make the
 * tarball path quietly weaker than the checkout path.
 */
export function walkComposeFiles(root = ".") {
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
      if (e.isFile() && isComposePath(childRel) && !isTestFixturePath(childRel)) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(root, "");
  return out;
}
