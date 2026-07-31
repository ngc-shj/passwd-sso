/**
 * Self-test for scripts/checks/check-runtime-image-assets.mjs.
 *
 * RT7: red-proven by the exact regressions that shipped — the missing COPY for
 * `scripts/checks/app-role-denied-privileges.json`, and the missing COPY for
 * `scripts/lib/denied-privileges.mjs` that extracting the shared loader created.
 *
 * Every case drives the gate at a `mkdtemp` fixture root through
 * `RUNTIME_IMAGE_ASSETS_ROOT`. The first version of this check was a vitest test
 * with a hardcoded repo root, which left red-proving it with only bad options —
 * the proof needed an rsync of the whole tree plus a `node_modules` symlink,
 * which is the documented signal that a gate was not parameterized.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-runtime-image-assets.mjs");

let root;

function runGuard() {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, RUNTIME_IMAGE_ASSETS_ROOT: root },
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function write(rel, contents) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

/**
 * A Dockerfile whose FINAL stage COPYs the given repo paths to the matching
 * location. `before` lines go in an EARLIER stage, which the shipped image never
 * receives — the gate must not count those.
 */
function dockerfile(paths, { before = [], pairs = [] } = {}) {
  const lines = ["FROM node:22-alpine AS builder", "WORKDIR /app"];
  // Deliberately the SAME shape the final stage uses, so this line would
  // satisfy the gate if stage boundaries were ignored — otherwise the
  // stage-boundary case is vacuous and its mutation goes undetected.
  for (const p of before) lines.push(`COPY --from=deps /app/${p} ./${p}`);
  lines.push("FROM node:22-alpine AS runner", "WORKDIR /app");
  for (const p of paths) lines.push(`COPY --from=builder /app/${p} ./${p}`);
  for (const [src, dest] of pairs) lines.push(`COPY --from=builder /app/${src} ${dest}`);
  return `${lines.join("\n")}\n`;
}

/** The two scripts the gate names, with the given bodies. */
function writeRuntimeScripts({ audit = "", bootstrap = "" } = {}) {
  write("scripts/audit-db-grants.mjs", audit);
  write("scripts/bootstrap-rds-roles.mjs", bootstrap);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runtime-image-assets-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-runtime-image-assets.mjs", () => {
  it("passes when every referenced asset is COPYd", () => {
    writeRuntimeScripts({
      audit: 'const P = "scripts/checks/policy.json";\nexport { P };\n',
      bootstrap: 'import { x } from "./lib/shared.mjs";\nexport { x };\n',
    });
    write("scripts/lib/shared.mjs", "export const x = 1;\n");
    write("Dockerfile", dockerfile([
      "scripts/audit-db-grants.mjs",
      "scripts/bootstrap-rds-roles.mjs",
      "scripts/checks/policy.json",
      "scripts/lib/shared.mjs",
    ]));
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("2 distinct asset(s)");
  });

  it("FAILS on the JSON asset that actually shipped uncopied", () => {
    writeRuntimeScripts({
      audit: 'const P = "scripts/checks/app-role-denied-privileges.json";\nexport { P };\n',
    });
    write("Dockerfile", dockerfile([
      "scripts/audit-db-grants.mjs",
      "scripts/bootstrap-rds-roles.mjs",
    ]));
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("app-role-denied-privileges.json");
    expect(stderr).toContain("does not COPY to that path");
  });

  it("FAILS on a shared module the extraction introduced", () => {
    // Extracting a helper is a new way for the image to be incomplete:
    // check-mjs-imports proves a specifier resolves in the REPO, not the image.
    writeRuntimeScripts({
      audit: 'import { loadPolicy } from "./lib/denied-privileges.mjs";\nexport { loadPolicy };\n',
      bootstrap: 'import { loadPolicy } from "./lib/denied-privileges.mjs";\nexport { loadPolicy };\n',
    });
    // The module EXISTS — the finding must be the missing COPY, not a missing
    // file, or the case would pass for the wrong reason.
    write("scripts/lib/denied-privileges.mjs", "export const loadPolicy = () => [];\n");
    write("Dockerfile", dockerfile([
      "scripts/audit-db-grants.mjs",
      "scripts/bootstrap-rds-roles.mjs",
    ]));
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("scripts/lib/denied-privileges.mjs");
  });

  it("FAILS when a runtime script itself is not COPYd", () => {
    writeRuntimeScripts({ audit: 'const P = "scripts/checks/policy.json";\nexport { P };\n' });
    write("Dockerfile", dockerfile(["scripts/checks/policy.json"]));
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("the script itself is not COPYd to that path");
  });

  it("FAILS closed when a runtime script has moved or been renamed", () => {
    // Otherwise a rename silently empties the gate's input set.
    write("Dockerfile", dockerfile([]));
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("was not found under");
  });

  it("does NOT require a path that appears only in a comment", () => {
    // The regex version counted these, which is loud rather than dangerous — but
    // it is also the property that shows the classifier reads syntax, not text.
    // `denied-privileges.mjs` names its own path in both a comment and an error
    // message, so this is the real shape and not a contrived one.
    writeRuntimeScripts({
      audit: '// see scripts/checks/decoy.json for the policy\nexport const x = 1;\n',
      bootstrap: 'const P = "scripts/checks/policy.json";\nexport { P };\n',
    });
    write("Dockerfile", dockerfile([
      "scripts/audit-db-grants.mjs",
      "scripts/bootstrap-rds-roles.mjs",
      "scripts/checks/policy.json",
    ]));
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("1 distinct asset(s)");
  });

  it("does NOT require a template span that is prose ending in a dot", () => {
    // The false positive this narrowing exists for, in the shape that produced
    // it: a message built as `` `… ${x}. ` + "The rest." `` leaves a TemplateTail
    // whose literal text is exactly ". ", which resolves against the module's
    // own directory to `scripts/lib/. ` — a required asset no COPY can satisfy.
    // Reading literals instead of raw text keeps COMMENTS out; it does not keep
    // out a span that merely begins with a dot.
    writeRuntimeScripts({
      audit:
        'export function f(subject) {\n' +
        '  throw new Error(`bad subject ${subject}. ` + "The subject must be schema-qualified.");\n' +
        '}\n',
      bootstrap: 'const P = "scripts/checks/policy.json";\nexport { P };\n',
    });
    write("Dockerfile", dockerfile([
      "scripts/audit-db-grants.mjs",
      "scripts/bootstrap-rds-roles.mjs",
      "scripts/checks/policy.json",
    ]));
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
    // The real asset next door is still derived — the narrowing drops the prose
    // span, not the classifier.
    expect(stdout).toContain("1 distinct asset(s)");
  });

  it("follows local module imports TRANSITIVELY, resolving relative specifiers", () => {
    // Both halves of the real shape, and both were live gaps in the first
    // version of this gate:
    //   - the policy path lives in the SHARED MODULE, not in the entry scripts,
    //     so a direct-only scan derives no JSON requirement at all;
    //   - the module names it as `new URL("../checks/x.json", import.meta.url)`,
    //     so resolution has to be relative to the MODULE's directory, not the
    //     entry script's.
    // Extracting the shared loader is what created the first gap — the refactor
    // silently narrowed the gate guarding the asset it was extracted from.
    writeRuntimeScripts({
      audit: 'import { load } from "./lib/shared.mjs";\nexport { load };\n',
      bootstrap: 'import { load } from "./lib/shared.mjs";\nexport { load };\n',
    });
    write(
      "scripts/lib/shared.mjs",
      'const P = new URL("../checks/policy.json", import.meta.url).pathname;\nexport const load = () => P;\n',
    );
    write("Dockerfile", dockerfile([
      "scripts/audit-db-grants.mjs",
      "scripts/bootstrap-rds-roles.mjs",
      "scripts/lib/shared.mjs",
    ]));
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("scripts/checks/policy.json");
  });

  it("FAILS closed when a transitively imported module is missing", () => {
    // A rename inside the module graph must stop the gate rather than quietly
    // shrink the derived asset set.
    writeRuntimeScripts({
      audit: 'import { load } from "./lib/gone.mjs";\nexport { load };\n',
      bootstrap: 'const P = "scripts/checks/policy.json";\nexport { P };\n',
    });
    write("Dockerfile", dockerfile([
      "scripts/audit-db-grants.mjs",
      "scripts/bootstrap-rds-roles.mjs",
      "scripts/checks/policy.json",
    ]));
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("was not found under");
  });

  it("FAILS when the extraction yields nothing (anti-vacuity)", () => {
    // A parser or path-resolution change that stopped producing references would
    // otherwise make every COPY assertion trivially true.
    writeRuntimeScripts({ audit: "export const x = 1;\n", bootstrap: "export const y = 2;\n" });
    write("Dockerfile", dockerfile([
      "scripts/audit-db-grants.mjs",
      "scripts/bootstrap-rds-roles.mjs",
    ]));
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("the extraction is dead");
  });

  it("KNOWN LIMIT: a dynamically assembled path is not detected", () => {
    // Pinned as a boundary case rather than left implied. No static pass without
    // type/flow analysis can see this, so the residual is covered at a different
    // layer: both consumers fail closed when the policy file is absent, which
    // turns a missed asset into a stopped deploy task rather than a silently
    // disabled control. If this test ever goes red, the gate got STRONGER and
    // the comment — not the assertion — is what needs revisiting.
    writeRuntimeScripts({
      audit: 'import { join } from "node:path";\nconst n = "policy";\nexport const p = join("scripts", "checks", n + ".json");\n',
      bootstrap: 'const P = "scripts/checks/policy.json";\nexport { P };\n',
    });
    write("Dockerfile", dockerfile([
      "scripts/audit-db-grants.mjs",
      "scripts/bootstrap-rds-roles.mjs",
      "scripts/checks/policy.json",
    ]));
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS on a path named only inside a TEMPLATE literal", () => {
    // `audit-db-grants.mjs` names its manifest as
    // `` `${REPO_ROOT}scripts/checks/db-grants-manifest.json` ``. A
    // StringLiteral-only sweep derived no requirement for it, so deleting its
    // COPY passed — reproduced against the real Dockerfile before the fix.
    writeRuntimeScripts({
      audit: 'const R = "/app/";\nconst M = `${R}scripts/checks/db-grants-manifest.json`;\nexport { M };\n',
      bootstrap: 'const P = "scripts/checks/policy.json";\nexport { P };\n',
    });
    write("Dockerfile", dockerfile([
      "scripts/audit-db-grants.mjs",
      "scripts/bootstrap-rds-roles.mjs",
      "scripts/checks/policy.json",
    ]));
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("scripts/checks/db-grants-manifest.json");
  });

  it("FAILS when the source is right but the DESTINATION is not", () => {
    // These scripts resolve assets relative to their own file, so a correct
    // source landing elsewhere is as broken as no COPY at all. The first version
    // substring-matched the whole COPY line, so the source alone satisfied it.
    writeRuntimeScripts({
      audit: 'const P = "scripts/checks/policy.json";\nexport { P };\n',
      bootstrap: "export const y = 1;\n",
    });
    write("Dockerfile", dockerfile(
      ["scripts/audit-db-grants.mjs", "scripts/bootstrap-rds-roles.mjs"],
      { pairs: [["scripts/checks/policy.json", "./elsewhere/policy.json"]] },
    ));
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("scripts/checks/policy.json");
  });

  it("does NOT count a COPY from an earlier build stage", () => {
    // Only the final stage ships. A COPY in `builder` vouches for a file the
    // runner never receives.
    writeRuntimeScripts({
      audit: 'const P = "scripts/checks/policy.json";\nexport { P };\n',
      bootstrap: "export const y = 1;\n",
    });
    write("Dockerfile", dockerfile(
      ["scripts/audit-db-grants.mjs", "scripts/bootstrap-rds-roles.mjs"],
      { before: ["scripts/checks/policy.json"] },
    ));
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("scripts/checks/policy.json");
  });

  it("accepts a DIRECTORY copy that lands at the matching path", () => {
    // The allow side of the destination rule: a directory COPY covers the files
    // beneath it, provided the layout is preserved.
    writeRuntimeScripts({
      audit: 'const P = "scripts/checks/policy.json";\nexport { P };\n',
      bootstrap: "export const y = 1;\n",
    });
    write("Dockerfile", dockerfile(
      ["scripts/audit-db-grants.mjs", "scripts/bootstrap-rds-roles.mjs"],
      { pairs: [["scripts/checks", "./scripts/checks"]] },
    ));
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });
});
