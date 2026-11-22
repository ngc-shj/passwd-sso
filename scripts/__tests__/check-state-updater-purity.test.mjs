/**
 * Self-test for check-state-updater-purity.mjs (plan:
 * close-coverage-and-clipboard-gaps, C7). Each row runs the real CLI against an
 * isolated fixture tree (mkdtemp + STATE_UPDATER_PURITY_ROOT), never the
 * tracked repo files.
 *
 * Deny: one fixture per side-effect kind. Allow: a pure updater and the timer
 * forms that schedule a setter from outside an updater. Refuse: an unparseable
 * file and an empty file list.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("../checks/check-state-updater-purity.mjs", import.meta.url));

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function run(files) {
  const root = mkdtempSync(join(tmpdir(), "state-updater-purity-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  try {
    const stdout = execFileSync("node", [CHECKER], {
      env: {
        ...process.env,
        STATE_UPDATER_PURITY_ROOT: root,
        STATE_UPDATER_PURITY_FIXTURE_MODE: "1",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

// One component whose single updater body is `body`.
const component = (body) =>
  "declare const setItems: (u: unknown) => void;\n" +
  "declare const setCount: (u: unknown) => void;\n" +
  "declare const toast: { error: (m: string) => void } & ((m: string) => void);\n" +
  "declare const fetchApi: (u: string) => Promise<unknown>;\n" +
  "declare const props: { onChange: (v: unknown) => void };\n" +
  "declare const onSave: (v: unknown) => void;\n" +
  "export function handler(id: string) {\n" +
  `  setItems((prev: string[]) => {\n${body}\n    return prev.filter((x) => x !== id);\n  });\n` +
  "}\n";

describe("check-state-updater-purity", () => {
  it.each([
    ["a nested setter", "    setCount((c: number) => c - 1);", "setter `setCount`"],
    ["setTimeout", "    setTimeout(() => {}, 10);", "timer `setTimeout`"],
    ["clearTimeout", "    clearTimeout(undefined);", "timer `clearTimeout`"],
    ["requestAnimationFrame", "    requestAnimationFrame(() => {});", "timer `requestAnimationFrame`"],
    ["a toast call", "    toast.error(\"x\");", "toast `toast.error`"],
    ["a bare toast call", "    toast(\"x\");", "toast `toast`"],
    ["localStorage", "    localStorage.setItem(\"k\", \"v\");", "storage `localStorage.setItem`"],
    ["window.sessionStorage", "    window.sessionStorage.removeItem(\"k\");", "storage `window.sessionStorage.removeItem`"],
    ["fetch", "    void fetch(\"/x\");", "fetch `fetch`"],
    ["fetchApi", "    void fetchApi(\"/x\");", "fetch `fetchApi`"],
    ["a props on* callback", "    props.onChange(prev);", "callback `props.onChange`"],
    ["a bare on* callback", "    onSave(prev);", "callback `onSave`"],
    ["a side effect in a nested function", "    prev.forEach(() => setCount(0));", "setter `setCount`"],
  ])("denies an updater that calls %s", (_label, body, reported) => {
    const r = run({ "src/a.tsx": component(body) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("IMPURE_STATE_UPDATER: 1 updater(s)");
    expect(r.stderr).toContain(`src/a.tsx:8  setItems(…) calls ${reported}`);
  });

  it("denies a function-expression updater too", () => {
    const r = run({
      "src/a.ts":
        "declare const setItems: (u: unknown) => void;\n" +
        "export const f = () => setItems(function (prev: number) { localStorage.clear(); return prev; });\n",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("storage `localStorage.clear`");
  });

  it("allows a pure updater", () => {
    const r = run({ "src/a.tsx": component("    const next = new Set(prev);\n    next.add(id);") });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-state-updater-purity: OK (1 files)");
  });

  it("allows setTimeout(() => setX(v), ms)", () => {
    const r = run({
      "src/a.ts":
        "declare const setX: (v: unknown) => void;\n" +
        "export const f = (v: number) => setTimeout(() => setX(v), 100);\n",
    });
    expect(r.code).toBe(0);
  });

  it("allows setTimeout(() => setX(v)) without a delay", () => {
    const r = run({
      "src/a.ts":
        "declare const setX: (v: unknown) => void;\n" +
        "export const f = (v: number) => setTimeout(() => setX(v));\n",
    });
    expect(r.code).toBe(0);
  });

  it("allows side effects next to, not inside, an updater", () => {
    const r = run({
      "src/a.ts":
        "declare const setItems: (u: unknown) => void;\n" +
        "declare const setCount: (u: unknown) => void;\n" +
        "export function f(id: string) {\n" +
        "  setItems((prev: string[]) => prev.filter((x) => x !== id));\n" +
        "  setCount((c: number) => c - 1);\n" +
        "  localStorage.setItem(\"k\", id);\n" +
        "}\n",
    });
    expect(r.code).toBe(0);
  });

  it("skips test files", () => {
    const r = run({
      "src/a.ts": "export const ok = 1;\n",
      "src/a.test.tsx": component("    setCount(0);"),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK (1 files)");
  });

  it("refuses an unparseable file", () => {
    const r = run({ "src/ok.ts": "export const ok = 1;\n", "src/broken.ts": "export const = ;\n" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("PARSE_ERROR");
    expect(r.stderr).toContain("src/broken.ts");
  });

  it("refuses an empty file list", () => {
    const r = run({ "README.md": "no sources here\n" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ZERO_FILES_SCANNED");
  });
});
