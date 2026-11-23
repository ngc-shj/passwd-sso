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
 *
 * M1–M10 — per selector kind (class, id, data-testid, aria-label, data-slot),
 *      a selector that only moved is not flagged and one really removed is
 *      flagged
 *
 * R1–R2 — section 1: a `git mv` of a route page whose old route a spec still
 *      visits is flagged; one no spec visits is not
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

function writeComponent(body) {
  mkdirSync(join(root, "src", "components"), { recursive: true });
  writeFileSync(join(root, "src", "components", "dialog.tsx"), body);
}

function commitComponentChange(base, head) {
  writeComponent(base);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeComponent(head);
  git("add", "-A");
  git("commit", "-q", "-m", "change");
}

// Sections 2 and 6 decide "moved, not removed" from the added lines. A BRE
// `^\+\+\+` header filter matches every +-line, which emptied that set and
// flagged every re-indented or relocated selector.
describe("check-e2e-selectors — class and id selectors that only moved", () => {
  it("M1: a class re-indented into a new wrapper is not flagged", () => {
    writeSpec(`page.locator(".text-destructive");\n`);
    commitComponentChange(
      `export const A = () => (\n  <p className="text-destructive">x</p>\n);\n`,
      `export const A = () => (\n  <div>\n    <p className="text-destructive">x</p>\n  </div>\n);\n`,
    );
    const r = runGate();
    expect(r.stdout).not.toContain("removed from source");
    expect(r.status).toBe(0);
  });

  it("M2: a class that is really removed is flagged", () => {
    writeSpec(`page.locator(".text-destructive");\n`);
    commitComponentChange(
      `export const A = () => <p className="text-destructive">x</p>;\n`,
      `export const A = () => <p className="text-muted">x</p>;\n`,
    );
    const r = runGate();
    expect(r.stdout).toContain("CSS class 'text-destructive' removed from source");
    expect(r.status).toBe(1);
  });

  it("M3: an id re-indented into a new branch is not flagged", () => {
    writeSpec(`page.locator("#grantee-email");\n`);
    commitComponentChange(
      `export const A = () => (\n  <input\n    id="grantee-email"\n  />\n);\n`,
      `export const A = ({ done }: { done: boolean }) =>\n  done ? null : (\n    <input\n      id="grantee-email"\n    />\n  );\n`,
    );
    const r = runGate();
    expect(r.stdout).not.toContain("removed from source");
    expect(r.status).toBe(0);
  });

  it("M4: an id that is really removed is flagged", () => {
    writeSpec(`page.locator("#grantee-email");\n`);
    commitComponentChange(
      `export const A = () => <input id="grantee-email" />;\n`,
      `export const A = () => <input id="email" />;\n`,
    );
    const r = runGate();
    expect(r.stdout).toContain("id='grantee-email' removed from source");
    expect(r.status).toBe(1);
  });
});

// Sections 3, 5 and 7 make the same moved-or-removed decision for data-testid,
// aria-label and data-slot, each with its own `^\+\+\+` header filter.
describe("check-e2e-selectors — data-testid, aria-label and data-slot that only moved", () => {
  it("M5: a data-testid re-indented into a new wrapper is not flagged", () => {
    writeSpec(`page.locator('[data-testid="entry-row"]');\n`);
    commitComponentChange(
      `export const A = () => (\n  <li data-testid="entry-row">x</li>\n);\n`,
      `export const A = () => (\n  <ul>\n    <li data-testid="entry-row">x</li>\n  </ul>\n);\n`,
    );
    const r = runGate();
    expect(r.stdout).not.toContain("removed from source");
    expect(r.status).toBe(0);
  });

  it("M6: a data-testid that is really removed is flagged", () => {
    writeSpec(`page.locator('[data-testid="entry-row"]');\n`);
    commitComponentChange(
      `export const A = () => <li data-testid="entry-row">x</li>;\n`,
      `export const A = () => <li data-testid="entry-item">x</li>;\n`,
    );
    const r = runGate();
    expect(r.stdout).toContain("data-testid='entry-row' removed from source");
    expect(r.status).toBe(1);
  });

  it("M7: an aria-label re-indented into a new wrapper is not flagged", () => {
    writeSpec(`page.getByRole("button", { name: "Dismiss" });\n`);
    commitComponentChange(
      `export const A = () => (\n  <button aria-label="Dismiss">x</button>\n);\n`,
      `export const A = () => (\n  <div>\n    <button aria-label="Dismiss">x</button>\n  </div>\n);\n`,
    );
    const r = runGate();
    expect(r.stdout).not.toContain("removed from source");
    expect(r.status).toBe(0);
  });

  it("M8: an aria-label that is really removed is flagged", () => {
    writeSpec(`page.getByRole("button", { name: "Dismiss" });\n`);
    commitComponentChange(
      `export const A = () => <button aria-label="Dismiss">x</button>;\n`,
      `export const A = () => <button aria-label="Close">x</button>;\n`,
    );
    const r = runGate();
    expect(r.stdout).toContain("aria-label containing 'Dismiss' removed from source");
    expect(r.status).toBe(1);
  });

  it("M9: a data-slot re-indented into a new wrapper is not flagged", () => {
    writeSpec(`page.locator("[data-slot='card']");\n`);
    commitComponentChange(
      `export const A = () => (\n  <div data-slot="card">x</div>\n);\n`,
      `export const A = () => (\n  <section>\n    <div data-slot="card">x</div>\n  </section>\n);\n`,
    );
    const r = runGate();
    expect(r.stdout).not.toContain("removed from source");
    expect(r.status).toBe(0);
  });

  it("M10: a data-slot that is really removed is flagged", () => {
    writeSpec(`page.locator("[data-slot='card']");\n`);
    commitComponentChange(
      `export const A = () => <div data-slot="card">x</div>;\n`,
      `export const A = () => <div data-slot="panel">x</div>;\n`,
    );
    const r = runGate();
    expect(r.stdout).toContain("data-slot='card' removed from source");
    expect(r.status).toBe(1);
  });
});

function writeFile(rel, body) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

// Sections 3 and 7 used to diff the whole tree, so a selector in a test file
// counted as source: adding it to a mock masked a real removal, and removing
// it from a test alone was reported as a source removal.
describe("check-e2e-selectors — data-testid and data-slot are judged on source files only", () => {
  it.each([
    ["data-testid", `[data-testid="entry-row"]`, `data-testid="entry-row"`, `data-testid="entry-item"`, "data-testid='entry-row' removed from source"],
    ["data-slot", `[data-slot='card']`, `data-slot="card"`, `data-slot="panel"`, "data-slot='card' removed from source"],
  ])("M11 %s: a copy added only in a test file does not mask a real source removal", (_kind, selector, attr, renamed, message) => {
    writeSpec(`page.locator('${selector}');\n`);
    writeComponent(`export const A = () => <div ${attr}>x</div>;\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeComponent(`export const A = () => <div ${renamed}>x</div>;\n`);
    writeFile("src/components/dialog.test.tsx", `render(<div ${attr}>mock</div>);\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    const r = runGate();
    expect(r.stdout).toContain(message);
    expect(r.status).toBe(1);
  });

  it.each([
    ["data-testid", `[data-testid="entry-row"]`, `data-testid="entry-row"`],
    ["data-slot", `[data-slot='card']`, `data-slot="card"`],
  ])("M12 %s: a removal inside a test file alone is not reported", (_kind, selector, attr) => {
    writeSpec(`page.locator('${selector}');\n`);
    writeComponent(`export const A = () => <div ${attr}>x</div>;\n`);
    writeFile("src/components/dialog.test.tsx", `render(<div ${attr}>mock</div>);\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFile("src/components/dialog.test.tsx", `render(<div>mock</div>);\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    const r = runGate();
    expect(r.stdout).not.toContain("removed from source");
    expect(r.status).toBe(0);
  });
});

// With an unrelated source change in the branch, changed_src is non-empty and
// the guard no longer skips sections 3/7 — this pins the pathspec on the
// removed-side diff, which M12 (guard-only) cannot reach.
describe("check-e2e-selectors — a test-only removal beside an unrelated source change", () => {
  it.each([
    ["data-testid", `[data-testid="entry-row"]`, `data-testid="entry-row"`],
    ["data-slot", `[data-slot='card']`, `data-slot="card"`],
  ])("M12b %s: is not reported", (_kind, selector, attr) => {
    writeSpec(`page.locator('${selector}');\n`);
    writeComponent(`export const A = () => <div ${attr}>x</div>;\n`);
    writeFile("src/components/other.tsx", `export const B = () => <p>b</p>;\n`);
    writeFile("src/components/dialog.test.tsx", `render(<div ${attr}>mock</div>);\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFile("src/components/other.tsx", `export const B = () => <p>bb</p>;\n`);
    writeFile("src/components/dialog.test.tsx", `render(<div>mock</div>);\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    const r = runGate();
    expect(r.stdout).not.toContain("removed from source");
    expect(r.status).toBe(0);
  });
});

// A renamed file is listed only under its new path unless rename detection is
// off, so the scoped diffs saw it as wholly added and missed a selector dropped
// during the move.
describe("check-e2e-selectors — selectors dropped while a file is renamed", () => {
  it.each([
    ["data-testid", `[data-testid="save-btn"]`, `data-testid="save-btn"`, "data-testid='save-btn' removed from source"],
    ["data-slot", `[data-slot='card']`, `data-slot="card"`, "data-slot='card' removed from source"],
    ["id", `#grantee-email`, `id="grantee-email"`, "id='grantee-email' removed from source"],
  ])("M13 %s: a removal in a renamed file is flagged", (_kind, selector, attr, message) => {
    writeSpec(`page.locator('${selector}');\n`);
    const body = (a) => `export const A = () => (\n  <div>\n    <p>one</p>\n    <p>two</p>\n    <div ${a}>x</div>\n    <p>three</p>\n  </div>\n);\n`;
    writeFile("src/components/old-name.tsx", body(attr));
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    git("mv", "src/components/old-name.tsx", "src/components/new-name.tsx");
    writeFile("src/components/new-name.tsx", body(`data-x="y"`));
    git("add", "-A");
    git("commit", "-q", "-m", "rename");
    const r = runGate();
    expect(r.stdout).toContain(message);
    expect(r.status).toBe(1);
  });

  it("M14: a pure rename that keeps its selectors is not flagged", () => {
    writeSpec(`page.locator('[data-testid="save-btn"]');\n`);
    writeFile("src/components/old-name.tsx", `export const A = () => <div data-testid="save-btn">x</div>;\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    git("mv", "src/components/old-name.tsx", "src/components/new-name.tsx");
    git("add", "-A");
    git("commit", "-q", "-m", "rename");
    const r = runGate();
    expect(r.stdout).not.toContain("removed from source");
    expect(r.status).toBe(0);
  });
});

// Section 1 listed deleted pages with `--diff-filter=D` while rename detection
// was on, so a `git mv` of a page was an R and a moved route still visited by a
// spec passed silently.
describe("check-e2e-selectors — route pages that were moved", () => {
  const OLD_PAGE = "src/app/[locale]/dashboard/old-route/page.tsx";
  const NEW_PAGE = "src/app/[locale]/dashboard/new-route/page.tsx";

  function movePage(spec) {
    writeSpec(spec);
    writeFile(OLD_PAGE, `export default function Page() {\n  return <main>page</main>;\n}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    mkdirSync(dirname(join(root, NEW_PAGE)), { recursive: true });
    git("mv", OLD_PAGE, NEW_PAGE);
    git("commit", "-q", "-m", "move");
  }

  it("R1: a moved page whose old route a spec still visits is flagged", () => {
    movePage(`await page.goto("/ja/dashboard/old-route");\n`);
    const r = runGate();
    expect(r.stdout).toContain("Deleted route '/dashboard/old-route' is still referenced in: e2e/tests/sample.spec.ts");
    expect(r.status).toBe(1);
  });

  it("R2: a moved page no spec visits is not flagged", () => {
    movePage(`await page.goto("/ja/dashboard/other");\n`);
    const r = runGate();
    expect(r.stdout).not.toContain("Deleted route");
    expect(r.status).toBe(0);
  });
});
