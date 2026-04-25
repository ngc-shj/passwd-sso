import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

function checkIgnore(path) {
  const r = spawnSync("git", ["check-ignore", "--no-index", path], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return r.status === 0;
}

describe("env generator gitignore coverage (SEC-1)", () => {
  const patterns = [
    // Canonical write target after the .env-primary refactor.
    ".env",
    ".env.tmp",
    ".env.tmp.123",
    ".env.bak",
    ".env.bak-20260425-090000",
    ".env.bak.foo",
    // Legacy patterns — preserved so developers mid-migration are still safe.
    ".env.local",
    ".env.local.tmp",
    ".env.local.tmp.123",
    ".env.local.bak",
    ".env.local.bak-20260424-120000",
    ".env.local.bak.foo",
  ];
  for (const p of patterns) {
    it(`ignores ${p}`, () => {
      expect(checkIgnore(p)).toBe(true);
    });
  }
});
