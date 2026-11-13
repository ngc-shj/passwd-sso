/**
 * The scripts below decide whether they run as a CLI with the one form that
 * survives a symlinked path and a path needing URL encoding:
 *
 *   if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
 *
 * Other spellings (`file://${process.argv[1]}`, `pathToFileURL(argv[1])`
 * without realpath) make a script a silent exit-0 no-op on such a path — a
 * gate that checks nothing. This test pins the form in the scripts that carry
 * it today, so none of them regresses. It does not classify how a NEW script
 * decides it is the entry point: a recognising or closed-grammar check over
 * that was tried in review and kept admitting equivalent spellings
 * (docs/archive/review/required-status-aggregate-deviation.md, D8), so that is
 * a follow-up, not a claim made here.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const GUARD = "if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {";
const NAMESPACE_GUARD = GUARD.replace("realpathSync(", "fs.realpathSync(");

const GUARDED = [
  "scripts/audit-db-grants.mjs",
  "scripts/bootstrap-rds-roles.mjs",
  "scripts/check-blame-ignore-revs.mjs",
  "scripts/check-codeowners-drift.mjs",
  "scripts/checks/check-compose-log-caps.mjs",
  "scripts/checks/check-crypto-auth-deps-classified.mjs",
  "scripts/checks/check-destructive-migration.mjs",
  "scripts/checks/check-migration-rls-dml.mjs",
  "scripts/checks/check-migration-transaction.mjs",
  "scripts/checks/check-override-floor-staleness.mjs",
  "scripts/checks/check-override-key-disjointness.mjs",
  "scripts/checks/check-required-aggregate.mjs",
  "scripts/checks/check-workflow-supply-chain.mjs",
  "scripts/checks/verify-npm-provenance-source.mjs",
  "scripts/generate-security-matrices.ts",
  "scripts/init-env.ts",
  "scripts/lib/hex-leak-scan.mjs",
  "scripts/lib/scram-verifier.mjs",
  "scripts/migrate-account-tokens-to-encrypted.ts",
  "scripts/tenant-domain.ts",
];

const count = (text, needle) => text.split(needle).length - 1;

describe("script CLI entry guards", () => {
  for (const path of GUARDED) {
    it(`${path} carries the canonical guard once, with its imports`, () => {
      const text = readFileSync(path, "utf8");
      expect(count(text, GUARD) + count(text, NAMESPACE_GUARD)).toBe(1);
      if (text.includes(NAMESPACE_GUARD)) {
        expect(text).toMatch(/^import \* as fs from "node:fs";$/m);
      } else {
        expect(text).toMatch(/^import \{[^}]*\brealpathSync\b[^}]*\} from "node:fs";$/m);
      }
      expect(text).toMatch(/^import \{[^}]*\bpathToFileURL\b[^}]*\} from "node:url";$/m);
    });
  }

  it("no script keeps a symlink-blind guard spelling", () => {
    const old = spawnSync(
      "git",
      ["grep", "-lF", "-e", "import.meta.url === `file://${process.argv[1]}`", "-e", "pathToFileURL(process.argv[1])", "--", "scripts", ":!scripts/__tests__"],
      { encoding: "utf8" },
    );
    // git grep exits 1 when nothing matches; anything else is an error.
    expect(old.status).toBe(1);
  });
});

// Scripts no other test imports: a missing realpathSync / pathToFileURL import
// would otherwise surface only when someone runs them.
describe("unimported CLI scripts still load", () => {
  for (const path of ["scripts/check-blame-ignore-revs.mjs", "scripts/check-codeowners-drift.mjs"]) {
    it(`${path} imports without error`, async () => {
      await expect(import(resolve(path))).resolves.toBeDefined();
    });
  }
});

// The guard is what decides whether these gates check anything when CI or the
// release job runs them; a false guard would exit 0 silently.
describe("security gate CLIs reach main()", () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it("verify-npm-provenance-source exits 1 on empty stdin", () => {
    const res = spawnSync(process.execPath, [resolve("scripts/checks/verify-npm-provenance-source.mjs")], {
      input: "",
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/audit output is not valid JSON/);
  });

  it("check-workflow-supply-chain exits 1 on a dependabot auto-merge workflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "supply-chain-cli-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github/workflows/automerge.yml"),
      [
        "on: pull_request",
        "jobs:",
        "  automerge:",
        "    if: github.actor == 'dependabot[bot]'",
        "    steps:",
        '      - run: gh pr merge --auto --squash "$PR_URL"',
        "",
      ].join("\n"),
    );
    const res = spawnSync(process.execPath, [resolve("scripts/checks/check-workflow-supply-chain.mjs")], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Supply-chain workflow guard failed/);
  });
});
