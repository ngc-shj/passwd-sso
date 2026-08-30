/**
 * Self-test for check-caught-error-logging.mjs.
 *
 * The gate exists because a hand-run sweep got the class wrong three times over
 * while its own count reproduced exactly — 17 of 58 sites, drawn at error/fatal
 * when `LOG_LEVEL` defaults to `info`, and at `src/workers` when the app-side
 * twin of the already-fixed pool handler sat in `src/lib/prisma.ts`. So the
 * cases below are the spellings that sweep missed, plus the correct forms that
 * must stay green — a gate that only denies is one nobody can adopt.
 *
 * Runs the gate as a subprocess against a synthetic repo root, so no case
 * depends on the state of the real tree.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GATE = join(REPO_ROOT, "scripts/checks/check-caught-error-logging.mjs");

let root;

/**
 * Every fixture carries a compliant catch block.
 *
 * Load-bearing, not decoration: the gate refuses when it recognises zero catch
 * clauses (that refusal is its own case below), so a fixture without one would
 * exit non-zero for a reason that has nothing to do with its subject. An
 * earlier draft of this file conflated the two and reported a false positive.
 */
const ANCHOR = `
declare const errorLogFields: (e: unknown) => object;
declare const anchorLog: { error(o: object, m: string): void };
export function anchor() {
  try { /* noop */ } catch (x) {
    anchorLog.error({ error: errorLogFields(x) }, "anchor");
  }
}
`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "caught-err-log-"));
  mkdirSync(join(root, "src"), { recursive: true });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function runGate(source, { dirs = "src", withAnchor = true } = {}) {
  if (source !== null) {
    writeFileSync(
      join(root, "src/subject.ts"),
      (withAnchor ? ANCHOR : "") + source,
      "utf8",
    );
  }
  const r = spawnSync("node", [GATE], {
    encoding: "utf8",
    env: {
      ...process.env,
      CAUGHT_ERROR_LOG_ROOT: root,
      CAUGHT_ERROR_LOG_DIRS: dirs,
      CAUGHT_ERROR_LOG_FIXTURE_MODE: "1",
    },
    timeout: 60_000,
  });
  const stderr = r.stderr ?? "";
  return {
    status: r.status,
    stderr,
    // A REFUSAL and a VIOLATION both exit non-zero. Asserting only on the exit
    // code cannot tell "the gate found a defect" from "the gate could not run",
    // and the second reads as the first.
    refused: /recognised 0|scanned 0|resolved to no source file/.test(stderr),
    violated: /handed to a logger/.test(stderr),
  };
}

const LOG = `declare const log: { [k: string]: (o: object, m: string) => void };\n`;

describe("check-caught-error-logging", () => {
  it.each([
    ["a bare `{ err }`", `try {} catch (err) { log.error({ err }, "m"); }`],
    // The axis the sweep got wrong first: LOG_LEVEL defaults to `info`, and
    // pino's warn(40) >= info(30), so warn is written and shipped like error.
    // Severity decides which alert rule matches, never whether bytes leave.
    ["a warn-level call", `try {} catch (err) { log.warn({ err }, "m"); }`],
    ["an info-level call", `try {} catch (err) { log.info({ err }, "m"); }`],
    ["a renamed binding", `try {} catch (e) { log.error({ e }, "m"); }`],
    ["a member read", `try {} catch (err) { log.error({ reason: err.message }, "m"); }`],
    ["String(err)", `try {} catch (err) { log.error({ reason: String(err) }, "m"); }`],
    ["a template literal", "try {} catch (err) { log.error({ r: `x ${err}` }, \"m\"); }"],
    ["a nested property", `try {} catch (err) { log.error({ ctx: { err } }, "m"); }`],
    ["a spread", `try {} catch (err) { log.error({ ...err }, "m"); }`],
    [
      "a call from a nested function inside the catch",
      `try {} catch (err) { [1].forEach(() => log.error({ err }, "m")); }`,
    ],
    [
      // The shape a per-call check would clear: one field reduced, another not.
      "one field reduced and another leaked",
      `try {} catch (err) { log.error({ a: errorLogFields(err), b: err.message }, "m"); }`,
    ],
    [
      // The field object need not be written at the call site. This is the
      // audit dead-letter shape: deadLetterEntry() builds the object and the
      // caught value rides in as one of its arguments.
      "a field object built by a helper call",
      `declare const mk: (a: string, b: string) => object;
       try {} catch (err) { log.warn(mk("reason", String(err)), "m"); }`,
    ],
    [
      // The anchor-publisher entrypoint's shape: an inline object, but wrapped
      // in JSON.stringify so the argument is a call, not a literal.
      "an object wrapped in JSON.stringify",
      `try {} catch (err) { log.error(JSON.stringify({ code: err.message }), "m"); }`,
    ],
  ])("FAILS %s", (_label, body) => {
    const r = runGate(`${LOG}export function f() { ${body} }`);
    expect(r.refused).toBe(false);
    expect(r.violated).toBe(true);
    expect(r.status).not.toBe(0);
  });

  it.each([
    [
      "an already-reduced field",
      `try {} catch (err) { log.error({ error: errorLogFields(err) }, "m"); }`,
    ],
    [
      // The binding is not the defect; handing it to a LOGGER is. Rethrowing it
      // and passing it to a recorder are both correct and common.
      "a catch binding used outside a logger call",
      `declare const rec: (e: unknown) => void;
       try {} catch (err) { rec(err); throw err; }`,
    ],
    [
      "a same-named variable outside any catch",
      `export function g() { const err = 1; log.error({ err }, "m"); }`,
    ],
    [
      "an inner catch whose own binding is reduced",
      `try {} catch (err) {
         try {} catch (e2) { log.error({ error: errorLogFields(e2) }, "m"); }
       }`,
    ],
    [
      "a logger call whose fields hold no catch binding",
      `try {} catch (err) { log.error({ id: 1 }, "m"); }`,
    ],
    [
      "a builder call whose caught argument is already reduced",
      `declare const mk: (a: string, b: object) => object;
       try {} catch (err) { log.warn(mk("reason", errorLogFields(err)), "m"); }`,
    ],
    [
      // A bare identifier argument is deliberately outside the gate's reach:
      // the only occurrence in this tree is a ReadableStream controller
      // propagating the error to its consumer, and telling that from a logger
      // needs a type checker the gate runs without. Pinned so a future widening
      // is a deliberate act with this case in front of it.
      "a bare identifier argument (documented MISSED, not a silent gap)",
      `try {} catch (err) { log.error(err); }`,
    ],
  ])("PASSES %s", (_label, body) => {
    const r = runGate(
      `${LOG}declare const errorLogFields: (e: unknown) => object;\nexport function f() { ${body} }`,
    );
    expect(r.violated).toBe(false);
    expect(r.refused).toBe(false);
    expect(r.status).toBe(0);
  });

  it("PASSES a same-named binding shadowed in a nested block inside the catch", () => {
    // `catch (e) { let e = 1 }` is a SyntaxError, but a nested block may
    // legally shadow. That value is not the caught one, so reporting it would
    // be a false positive with no suppression path — the pressure that gets a
    // gate routed around.
    const r = runGate(`${LOG}declare const mk: () => object;
export function f() {
  try {} catch (err) { { const err = mk(); log.error({ err }, "m"); } }
}`);
    expect(r.violated).toBe(false);
    expect(r.status).toBe(0);
  });

  it("reports a nested same-named catch ONCE per line, not once per clause", () => {
    // Both clauses bind `err`, and comparing NAMES rather than clause identity
    // made the outer walk claim the inner line too — measured: two offending
    // lines, three findings. A duplicate reads as a second defect and sends the
    // reader to a line already fixed.
    const r = runGate(`${LOG}export function f() {
  try {} catch (err) {
    log.error({ err }, "outer");
    try {} catch (err) { log.error({ err }, "inner"); }
  }
}`);
    expect(r.violated).toBe(true);
    const lines = r.stderr.split("\n").filter((l) => /^ {2}src\/subject/.test(l));
    expect(lines).toHaveLength(2);
  });

  it("REFUSES when it recognises no catch clause", () => {
    // "Examined nothing" must not be spelled like "found nothing wrong". A
    // changed catch shape, a moved tree or a broken parse all land here.
    const r = runGate("export const x = 1;\n", { withAnchor: false });
    expect(r.refused).toBe(true);
    expect(r.violated).toBe(false);
    expect(r.stderr).toContain("recognised 0 catch clauses");
  });

  it("REFUSES when a scan target resolves to no file", () => {
    const r = runGate(null, { dirs: "src/does-not-exist" });
    expect(r.refused).toBe(true);
    expect(r.stderr).toContain("src/does-not-exist");
  });

  it("REFUSES scan-scope overrides in CI without fixture mode", () => {
    // The overrides exist for this file; left ungated they silently narrow what
    // CI examines, and a wrong-but-non-empty scope prints OK.
    const r = spawnSync("node", [GATE], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
        CAUGHT_ERROR_LOG_ROOT: root,
        CAUGHT_ERROR_LOG_DIRS: "src",
        CAUGHT_ERROR_LOG_FIXTURE_MODE: "",
      },
      timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("must not be set in CI");
  });

  it("is wired into scripts/pre-pr.sh", () => {
    // The gate's only execution path. Anchored at line start so a commented-out
    // `# DISABLED: queue_step …` does not satisfy it — that is disarming, not
    // deletion, and `toContain` would not tell them apart.
    const prePr = readFileSync(join(REPO_ROOT, "scripts/pre-pr.sh"), "utf8");
    expect(prePr).toMatch(/^queue_step .*check-caught-error-logging\.mjs/m);
  });
});
