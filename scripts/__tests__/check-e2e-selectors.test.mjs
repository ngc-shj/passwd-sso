/**
 * Self-test for scripts/checks/check-e2e-selectors.sh — section 8 (i18n value
 * changes vs Japanese literals in E2E regexes) (RT7).
 *
 * Runs the real gate in a throwaway git repo: `main` holds the base messages,
 * a branch commit changes them, and the gate diffs `main...HEAD`.
 *
 * T1 — anchored /^使用$/ with the label unchanged, while an unrelated help text
 *      that merely contains 使用 is rewritten → no warning (the false positive
 *      this section used to raise)
 * T2 — anchored /^使用$/ and the label itself is renamed → warning
 * T3 — unanchored literal whose only containing value is removed → warning
 * T4 — unanchored literal still present in another value → no warning
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GATE = resolve(REPO_ROOT, "scripts", "checks", "check-e2e-selectors.sh");

let root;

function git(...args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function writeJa(values) {
  mkdirSync(join(root, "messages", "ja"), { recursive: true });
  writeFileSync(join(root, "messages", "ja", "Common.json"), JSON.stringify(values, null, 2) + "\n");
}

function writeSpec(body) {
  mkdirSync(join(root, "e2e", "tests"), { recursive: true });
  writeFileSync(join(root, "e2e", "tests", "sample.spec.ts"), body);
}

function commitBaseThenBranch(base, head) {
  writeJa(base);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeJa(head);
  git("add", "-A");
  git("commit", "-q", "-m", "change");
}

function runGate() {
  return spawnSync("bash", [GATE, "main"], { cwd: root, encoding: "utf8", timeout: 30_000 });
}

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "e2e-selectors-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-e2e-selectors — i18n value changes vs E2E regex literals", () => {
  it("T1: an anchored label that still exists is not flagged by an unrelated substring removal", () => {
    writeSpec(`page.getByRole("button", { name: /^Use$|^使用$/i });\n`);
    commitBaseThenBranch(
      { use: "使用", idleHelp: "指定時間使用されなかった場合に失効します。" },
      { use: "使用", idleHelp: "アンロックが確認されないまま指定時間が経つと失効します。" },
    );
    const r = runGate();
    expect(r.stdout).not.toContain("still used in E2E regex");
    expect(r.status).toBe(0);
  });

  it("T2: an anchored label that was renamed is flagged", () => {
    writeSpec(`page.getByRole("button", { name: /^Use$|^使用$/i });\n`);
    commitBaseThenBranch({ use: "使用" }, { use: "適用" });
    const r = runGate();
    expect(r.stdout).toContain("i18n value '使用' was changed");
    expect(r.status).toBe(1);
  });

  it("T3: an unanchored literal whose only containing value was removed is flagged", () => {
    writeSpec(`expect(page.getByText(/expired|既に使用されています/i)).toBeVisible();\n`);
    commitBaseThenBranch(
      { expired: "有効期限が切れたか、既に使用されています。" },
      { expired: "リンクの有効期限が切れました。" },
    );
    const r = runGate();
    expect(r.stdout).toContain("i18n value '既に使用されています' was changed");
    expect(r.status).toBe(1);
  });

  it("T4: an unanchored literal still contained in another value is not flagged", () => {
    writeSpec(`expect(page.getByText(/expired|既に使用されています/i)).toBeVisible();\n`);
    commitBaseThenBranch(
      { expired: "有効期限が切れたか、既に使用されています。", other: "既に使用されています" },
      { expired: "リンクの有効期限が切れました。", other: "既に使用されています" },
    );
    const r = runGate();
    expect(r.stdout).not.toContain("still used in E2E regex");
    expect(r.status).toBe(0);
  });
});
