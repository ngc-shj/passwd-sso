/**
 * Self-test for scripts/checks/scan-test-assertions.mjs (plan C3 quality bar).
 *
 * Fixtures are inline test-file sources scanned under a path in the real tree,
 * so the self-mock rule resolves `./x` and `@/…` exactly as it would there.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanTestSource } from "../checks/scan-test-assertions.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const SCANNER = resolve(REPO, "scripts/checks/scan-test-assertions.mjs");
const PATH = "src/components/widget/widget.test.tsx";

function scan(source, opts) {
  return scanTestSource(PATH, source, opts);
}

function runScanner(args, input) {
  try {
    const stdout = execFileSync("node", [SCANNER, ...args], { cwd: REPO, encoding: "utf8", stdio: "pipe", input });
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout}${err.stderr}` };
  }
}

let tmp;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("assertion presence", () => {
  it("refuses a test with no expect", () => {
    expect(scan(`it("renders", () => { render(<Widget />); });`)).toEqual([
      `${PATH}:1: NO_ASSERTION: "renders"`,
    ]);
  });

  it("accepts a test with a matcher", () => {
    expect(scan(`it("adds", () => { expect(add(1, 2)).toBe(3); });`)).toEqual([]);
  });

  it("accepts an awaited rejects chain", () => {
    expect(scan(`test("fails", async () => { await expect(load()).rejects.toThrow("boom"); });`)).toEqual([]);
  });

  it("accepts an imported helper assertion", () => {
    const source = `import { expectSwallowedRefusal } from "@/__tests__/helpers/refusal";\nit("refuses", async () => { await expectSwallowedRefusal(run); });`;
    expect(scan(source)).toEqual([]);
  });

  it("accepts a local helper that throws on failure", () => {
    const source = `function assertCommitted(o) { if (!o.ok) throw new Error("x"); }\nit("commits", () => { assertCommitted(run()); });`;
    expect(scan(source)).toEqual([]);
  });

  it("refuses a local expect-named helper that asserts nothing", () => {
    const source = `function expectQuiet(o) { return o; }\nit("is quiet", () => { expectQuiet(run()); });`;
    expect(scan(source)).toEqual([`${PATH}:2: NO_ASSERTION: "is quiet"`]);
  });

  it("accepts a Testing Library getBy query, which throws on absence", () => {
    expect(scan(`it("shows the title", () => { render(<Widget />); screen.getByRole("heading"); });`)).toEqual([]);
  });

  it("checks the callback of it.each", () => {
    expect(scan(`it.each([1, 2])("case %s", (n) => { run(n); });`)).toEqual([`${PATH}:1: NO_ASSERTION: "case %s"`]);
  });
});

describe("weak assertions", () => {
  it("refuses a toBeDefined-only test", () => {
    expect(scan(`it("exists", () => { expect(make()).toBeDefined(); });`)).toEqual([
      `${PATH}:1: WEAK_ASSERTIONS_ONLY: "exists" asserts only toBeDefined/toBeTruthy/not.toThrow`,
    ]);
  });

  it("refuses a test whose only assertions are toBeTruthy and not.toThrow", () => {
    const source = `it("works", () => { expect(ok()).toBeTruthy(); expect(() => run()).not.toThrow(); });`;
    expect(scan(source)).toEqual([
      `${PATH}:1: WEAK_ASSERTIONS_ONLY: "works" asserts only toBeDefined/toBeTruthy/not.toThrow`,
    ]);
  });

  it("accepts a weak assertion alongside a real one", () => {
    expect(scan(`it("makes", () => { const w = make(); expect(w).toBeDefined(); expect(w.size).toBe(2); });`)).toEqual([]);
  });

  it("accepts not.toBeDefined, which pins absence", () => {
    expect(scan(`it("is gone", () => { expect(find()).not.toBeDefined(); });`)).toEqual([]);
  });
});

describe("snapshots, skips and self-mocks", () => {
  it("refuses a snapshot", () => {
    expect(scan(`it("renders", () => { expect(render(<Widget />).container).toMatchSnapshot(); });`)).toEqual([
      `${PATH}:1: SNAPSHOT: toMatchSnapshot`,
    ]);
  });

  it("refuses it.skip and it.todo", () => {
    expect(scan(`it.skip("later", () => { expect(1).toBe(1); });\nit.todo("someday");`)).toEqual([
      `${PATH}:1: SKIP_OR_TODO: it.skip`,
      `${PATH}:2: SKIP_OR_TODO: it.todo`,
    ]);
  });

  it("allows a skip already present at the base ref", () => {
    const source = `it.todo("someday");`;
    expect(scan(source, { baseSource: source })).toEqual([]);
  });

  it("refuses a skip added since the base ref", () => {
    expect(scan(`it.todo("someday");\ntest.skip("new", () => {});`, { baseSource: `it.todo("someday");` })).toHaveLength(2);
  });

  it.each([["./widget"], ["@/components/widget/widget"], ["./widget.tsx"]])(
    "refuses vi.mock of the subject as %s",
    (spec) => {
      const source = `vi.mock("${spec}");\nit("renders", () => { expect(1).toBe(1); });`;
      expect(scan(source)).toEqual([`${PATH}:1: SELF_MOCK: vi.mock("${spec}") mocks the subject under test`]);
    },
  );

  it("refuses vi.mock of the subject from a __tests__ directory", () => {
    const source = `vi.mock("../widget");\nit("renders", () => { expect(1).toBe(1); });`;
    expect(scanTestSource("src/components/widget/__tests__/widget.test.tsx", source)).toHaveLength(1);
  });

  it("allows vi.mock of a collaborator", () => {
    const source = `vi.mock("@/lib/http/fetch-api");\nvi.mock("./widget-row");\nit("renders", () => { expect(1).toBe(1); });`;
    expect(scan(source)).toEqual([]);
  });
});

describe("CLI", () => {
  it("refuses an empty input list", () => {
    const { code, output } = runScanner([], "");
    expect(code).toBe(1);
    expect(output).toContain("SCAN_EMPTY_INPUT");
  });

  it("reports violations per file and exits 1", () => {
    tmp = mkdtempSync(join(tmpdir(), "scan-assertions-"));
    const bad = join(tmp, "bad.test.ts");
    const good = join(tmp, "good.test.ts");
    writeFileSync(bad, `it("x", () => { run(); });\n`);
    writeFileSync(good, `it("y", () => { expect(run()).toBe(1); });\n`);
    const { code, output } = runScanner([bad, good]);
    expect(code).toBe(1);
    expect(output).toContain(`${bad}:1: NO_ASSERTION: "x"`);
    expect(output).not.toContain(good);
  });

  it("reads file paths from stdin and exits 0 when clean", () => {
    tmp = mkdtempSync(join(tmpdir(), "scan-assertions-"));
    const good = join(tmp, "good.test.ts");
    writeFileSync(good, `it("y", () => { expect(run()).toBe(1); });\n`);
    const { code, output } = runScanner([], `${good}\n`);
    expect(code).toBe(0);
    expect(output).toContain("scan-test-assertions: OK (1 files scanned)");
  });
});
