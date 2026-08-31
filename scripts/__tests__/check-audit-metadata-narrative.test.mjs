/**
 * Self-test for check-audit-metadata-narrative.mjs.
 *
 * The gate exists because the sibling caught-error gate anchors on a logger
 * CALL and so cannot see a value that leaves the catch block in a variable and
 * is persisted after the block closes — the shape both #805 sites had, named
 * under that gate's MISSED. The cases below are that shape and its spellings,
 * plus the correct forms that must stay green: a gate that only denies is one
 * nobody can adopt.
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
const GATE = join(REPO_ROOT, "scripts/checks/check-audit-metadata-narrative.mjs");

let root;

/**
 * Every fixture carries a compliant catch block AND a compliant `metadata`
 * property.
 *
 * Load-bearing, not decoration: the gate refuses when it recognises zero catch
 * clauses OR zero metadata properties (both refusals are their own cases
 * below), so a fixture missing either would exit non-zero for a reason that has
 * nothing to do with its subject.
 */
const ANCHOR = `
declare const errorLogFields: (e: unknown) => { name: string; code: string };
declare const emit: (o: object) => void;
export function anchor() {
  try { /* noop */ } catch (x) {
    emit({ metadata: { reason: \`ANCHOR_FAILED:\${errorLogFields(x).code}\` } });
  }
}
`;

const DECLS = `
declare const emit: (o: object) => void;
declare const log: (s: unknown) => void;
declare const risky: () => void;
declare const buildMeta: (s: string) => object;
declare const errorLogFields: (e: unknown) => { name: string; code: string };
`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "audit-meta-narrative-"));
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
      AUDIT_METADATA_NARRATIVE_ROOT: root,
      AUDIT_METADATA_NARRATIVE_DIRS: dirs,
      AUDIT_METADATA_NARRATIVE_FIXTURE_MODE: "1",
    },
    timeout: 60_000,
  });
  const stderr = r.stderr ?? "";
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr,
    // A REFUSAL and a VIOLATION both exit non-zero. Asserting only on the exit
    // code cannot tell "the gate found a defect" from "the gate could not run",
    // and the second reads as the first in a pre-pr log that shows only a code.
    refused: /recognised 0|scanned 0|resolved to no source file/.test(stderr),
    violated: /reaching an audit `metadata` field/.test(stderr),
  };
}

describe("check-audit-metadata-narrative", () => {
  it.each([
    [
      "a message read straight into a metadata field",
      `export function f() {
         try { risky(); } catch (err) { emit({ metadata: { reason: err.message } }); }
       }`,
    ],
    [
      // The shape the sibling gate cannot see, and the one both #805 sites had:
      // assigned inside the catch, persisted after the block closes.
      "a message laundered through a binding declared outside the catch",
      `export function f() {
         let reason: string | null = null;
         try { risky(); } catch (err) { reason = err.message; }
         emit({ metadata: { reason } });
       }`,
    ],
    [
      "a two-hop launder",
      `export function f() {
         let detail: string | null = null;
         try { risky(); } catch (err) {
           const m = err.message;
           detail = \`revocation failed: \${m}\`;
         }
         emit({ metadata: { detail } });
       }`,
    ],
    [
      "String(err)",
      `export function f() {
         let reason: string | null = null;
         try { risky(); } catch (err) { reason = String(err); }
         emit({ metadata: { reason } });
       }`,
    ],
    [
      // `stack` is the field pino's serializer adds beside `message`, and it
      // carries absolute paths and frames from node_modules.
      "a stack read",
      `export function f() {
         try { risky(); } catch (err) { emit({ metadata: { at: err.stack } }); }
       }`,
    ],
    [
      "a template embedding the binding itself",
      `export function f() {
         try { risky(); } catch (err) { emit({ metadata: { r: \`boom \${err}\` } }); }
       }`,
    ],
    [
      "a string concatenation",
      `export function f() {
         try { risky(); } catch (err) { emit({ metadata: { r: "failed: " + err.message } }); }
       }`,
    ],
    [
      // The metadata object need not be written at the emit site.
      "a metadata object built by a helper call",
      `export function f() {
         try { risky(); } catch (err) { emit({ metadata: buildMeta(String(err)) }); }
       }`,
    ],
    [
      // `logAuditAsync({ …, metadata })` — the sink is a shorthand, so reading
      // only PropertyAssignment initializers would miss it.
      "a metadata shorthand naming a tainted binding",
      `export function f() {
         try { risky(); } catch (err) {
           const metadata = { reason: err.message };
           emit({ metadata });
         }
       }`,
    ],
    [
      "JSON.stringify of the caught value",
      `export function f() {
         try { risky(); } catch (err) { emit({ metadata: { raw: JSON.stringify(err) } }); }
       }`,
    ],
  ])("FAILS %s", (_label, body) => {
    const r = runGate(DECLS + body);
    expect(r.refused).toBe(false);
    expect(r.violated).toBe(true);
    expect(r.status).not.toBe(0);
  });

  it.each([
    [
      "a token derived through the reducer",
      `export function f() {
         let reason: string | null = null;
         try { risky(); } catch (err) {
           reason = \`REVOCATION_FAILED:\${errorLogFields(err).code}\`;
         }
         emit({ metadata: { reason } });
       }`,
    ],
    [
      "the reduced pair itself as a metadata value",
      `export function f() {
         try { risky(); } catch (err) { emit({ metadata: { error: errorLogFields(err) } }); }
       }`,
    ],
    [
      // A comparison against a literal is control flow, not extraction into a
      // value. 26 of the 67 narrative reads in this tree are this shape, and
      // separating them structurally is what removes the need for an exemption
      // list.
      "a sentinel comparison on the message",
      `export function f() {
         try { risky(); } catch (err) {
           if (err.message === "SCIM_RESOURCE_EXISTS") { log(1); }
         }
       }`,
    ],
    [
      "a switch on the message",
      `export function f() {
         try { risky(); } catch (err) {
           switch (err.message) { case "CANCELLED": log(1); break; default: log(2); }
         }
       }`,
    ],
    [
      // The binding is not the defect; persisting it to a tenant-readable
      // record is. Rethrowing and logging it are adjudicated elsewhere.
      "narrative that never reaches a metadata field",
      `export function f() {
         try { risky(); } catch (err) { log(err.message); throw err; }
       }`,
    ],
    [
      "a metadata field carrying no caught value",
      `export function f() {
         try { risky(); } catch (err) { log(err); emit({ metadata: { id: 1 } }); }
       }`,
    ],
  ])("PASSES %s", (_label, body) => {
    const r = runGate(DECLS + body);
    expect(r.violated).toBe(false);
    expect(r.refused).toBe(false);
    expect(r.status).toBe(0);
  });

  it("PASSES a same-named binding declared in a nested scope", () => {
    // The case that makes innermost-binder-first resolution load-bearing rather
    // than stylistic. This is the anchor publisher's real shape: an inner
    // `catch` whose own `const reason` is a token, under the same function as
    // an outer catch whose `reason` holds the message. Measured on the tree at
    // f5dacefb3^: resolving by NAME across the enclosing function reports 3
    // findings, one of them the SUCCESS audit event below; resolving from the
    // reference outward reports the 2 real ones.
    const r = runGate(`${DECLS}
export function f() {
  let out: number | null = null;
  try {
    try { risky(); } catch (inner) {
      const reason = "UPLOAD_FAILED";
      emit({ metadata: { failureReason: reason } });
    }
    out = 1;
  } catch (err) {
    const reason = err.message;
    log(reason);
  }
  log(out);
}`);
    expect(r.violated).toBe(false);
    expect(r.refused).toBe(false);
    expect(r.status).toBe(0);
  });

  it("REFUSES when it recognises no catch clause", () => {
    // "Examined nothing" must not be spelled like "found nothing wrong".
    const r = runGate(`${DECLS}export function f() { emit({ metadata: { id: 1 } }); }`, {
      withAnchor: false,
    });
    expect(r.refused).toBe(true);
    expect(r.violated).toBe(false);
    // The exit status is the ONLY channel queue_step reads. Asserting stderr
    // alone leaves fail() free to exit 0 — measured: the message is
    // byte-identical either way, so all three fail()-routed cases stayed green
    // under that mutation while pre-pr reported PASS.
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("recognised 0 catch clauses");
  });

  it("REFUSES when it recognises no metadata property", () => {
    // The other half of the subject. A gate that sees every catch and no sink
    // prints the same OK as one with nothing to report — this is what fires if
    // the audit payload field is ever renamed.
    const r = runGate(`${DECLS}export function f() { try { risky(); } catch (err) { log(err); } }`, {
      withAnchor: false,
    });
    expect(r.refused).toBe(true);
    expect(r.violated).toBe(false);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("recognised 0 `metadata` properties");
  });

  it("REFUSES when a scan target resolves to no file", () => {
    const r = runGate(null, { dirs: "src/does-not-exist" });
    expect(r.refused).toBe(true);
    expect(r.status).not.toBe(0);
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
        AUDIT_METADATA_NARRATIVE_ROOT: root,
        AUDIT_METADATA_NARRATIVE_DIRS: "src",
        AUDIT_METADATA_NARRATIVE_FIXTURE_MODE: "",
      },
      timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("must not be set in CI");
  });

  it("is wired into scripts/pre-pr.sh", () => {
    // The gate's only execution path. Anchored at line start so a commented-out
    // `# DISABLED: queue_step …` does not satisfy it — that is disarming, not
    // deletion, and `toContain` returns true for both.
    const prePr = readFileSync(join(REPO_ROOT, "scripts/pre-pr.sh"), "utf8");
    expect(prePr).toMatch(/^queue_step .*check-audit-metadata-narrative\.mjs\s*$/m);
  });
});
