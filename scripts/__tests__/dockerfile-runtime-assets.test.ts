import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Every data file a deploy-time script reads must be in the runtime image.
 *
 * `infra/terraform/ecs.tf` runs the migrate task as
 * `prisma migrate deploy && node scripts/audit-db-grants.mjs`, and
 * `scripts/bootstrap-rds-roles.mjs` is invoked via ECS Exec on a fresh
 * environment. Both read JSON out of `scripts/checks/`. The Dockerfile copies
 * those assets one `COPY` line at a time — so adding a new one to a script and
 * forgetting the `COPY` produces a build that passes every local check while the
 * control it implements is inert in production.
 *
 * That is not hypothetical: `app-role-denied-privileges.json` shipped exactly
 * that way. Both consumers treated the absent file as an empty policy, so the
 * production runner would have run the blanket `GRANT` with no `REVOKE` behind
 * it. Both now fail closed, and this test closes the other half — the required
 * set is DERIVED by reading the scripts, so a third data file joins it without
 * anyone remembering to add a case here.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");

/** Scripts the deployed image executes. Each is itself asserted to be COPYd. */
const RUNTIME_SCRIPTS = [
  "scripts/audit-db-grants.mjs",
  "scripts/bootstrap-rds-roles.mjs",
];

const dockerfile = readFileSync(resolve(REPO_ROOT, "Dockerfile"), "utf8");

/** `scripts/checks/<name>.json` paths a script resolves as a default. */
function checksAssetsReadBy(scriptPath: string): string[] {
  const src = readFileSync(resolve(REPO_ROOT, scriptPath), "utf8");
  return [...src.matchAll(/scripts\/checks\/[A-Za-z0-9._-]+\.json/g)].map((m) => m[0]);
}

/**
 * Local `.mjs` modules a script imports, resolved to repo paths.
 *
 * A shared module is a runtime asset exactly like a JSON file, and extracting
 * one is a NEW way for the image to be missing part of the control:
 * `scripts/checks/check-mjs-imports.mjs` proves a specifier resolves in the
 * REPO, not in the image. Added when `lib/denied-privileges.mjs` was extracted so
 * that the extraction could not reintroduce the defect this test exists for.
 */
function localModulesImportedBy(scriptPath: string): string[] {
  const src = readFileSync(resolve(REPO_ROOT, scriptPath), "utf8");
  const dir = scriptPath.slice(0, scriptPath.lastIndexOf("/"));
  return [...src.matchAll(/from\s+"(\.\/[A-Za-z0-9._/-]+\.mjs)"/g)].map(
    (m) => `${dir}/${m[1].slice(2)}`,
  );
}

/** True when the Dockerfile has a COPY whose destination is this path. */
function isCopiedIntoImage(repoPath: string): boolean {
  return dockerfile
    .split("\n")
    .filter((l) => l.trimStart().startsWith("COPY"))
    .some((l) => l.includes(`/${repoPath}`) || l.includes(`./${repoPath}`));
}

describe("Dockerfile carries every deploy-time runtime asset", () => {
  it("derives a non-empty asset set from the scripts (anti-vacuity)", () => {
    // Without this, a regex that stopped matching would retire every case below
    // and the suite would stay green — the same shape as the manifest recording
    // a breakage as expected.
    const all = RUNTIME_SCRIPTS.flatMap(checksAssetsReadBy);
    expect(new Set(all).size).toBeGreaterThanOrEqual(2);
  });

  it.each(RUNTIME_SCRIPTS)("copies the script itself: %s", (scriptPath) => {
    expect(isCopiedIntoImage(scriptPath), `${scriptPath} is not COPYd`).toBe(true);
  });

  it.each(RUNTIME_SCRIPTS)("copies every scripts/checks asset read by %s", (scriptPath) => {
    const assets = [...new Set(checksAssetsReadBy(scriptPath))];
    const missing = assets.filter((a) => !isCopiedIntoImage(a));
    expect(
      missing,
      `${scriptPath} reads these at runtime but the Dockerfile does not COPY them`,
    ).toEqual([]);
  });

  it.each(RUNTIME_SCRIPTS)("copies every local module imported by %s", (scriptPath) => {
    const modules = [...new Set(localModulesImportedBy(scriptPath))];
    const missing = modules.filter((m) => !isCopiedIntoImage(m));
    expect(
      missing,
      `${scriptPath} imports these at runtime but the Dockerfile does not COPY them`,
    ).toEqual([]);
  });

  it("sees the shared policy module as a required asset (anti-vacuity for the import scan)", () => {
    // Pins that the import regex actually matches the extraction it was written
    // for. A regex that silently stopped matching would make the case above
    // vacuously green.
    const all = RUNTIME_SCRIPTS.flatMap(localModulesImportedBy);
    expect(all).toContain("scripts/lib/denied-privileges.mjs");
  });
});
