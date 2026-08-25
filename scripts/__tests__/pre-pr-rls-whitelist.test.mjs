/**
 * Self-test for the whitelist branch of pre-pr.sh's
 * "Static: rls-cross-tenant SQL parse" step.
 *
 * Why this file exists: the step accepts a small set of [E-RLS-*] codes as
 * expected-on-an-unseeded-dev-DB and exits 0. That accepted set is the entire
 * safety property, and neither environment exercises the fatal path — locally
 * the run always produces [E-RLS-COUNT-A] and takes the whitelist branch, and
 * in CI the seeded run passes outright so `ec == 0` returns before the branch
 * is ever reached. A gate whose deny side runs nowhere is green by
 * construction: widen the alternation and nothing notices, forever.
 *
 * check-gate-selftest-coverage.sh cannot ask for this file — its member set is
 * `scripts/checks/*.{sh,mjs}` and pre-pr.sh is the harness, never a member.
 * Same reasoning as pre-pr-run-batch.test.mjs, which is the precedent for
 * splicing a pre-pr.sh fragment rather than re-implementing it.
 *
 * The cases pin the distinction that motivated the narrowing: only the three
 * row-count blocks depend on the CI-only seed. Block 1 of
 * rls-cross-tenant-verify.sql is pure pg_catalog inspection that runs and
 * passes against an unseeded dev DB, so a Block-1 code is a real RLS control
 * regression — a dropped FORCE ROW LEVEL SECURITY, a new SECURITY DEFINER
 * function in public, a policy with a NULL USING clause, manifest drift — and
 * must stay fatal.
 *
 * The block is spliced out of pre-pr.sh verbatim: a re-implementation here
 * would drift and prove nothing. `docker` is stubbed on PATH so the fixture
 * output stands in for psql without touching a database.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const PRE_PR = join(REPO_ROOT, "scripts/pre-pr.sh");

const BLOCK_START = 'run_step "Static: rls-cross-tenant SQL parse" bash -c \'';
const BLOCK_END = "\n  '\n";

let block;

beforeAll(() => {
  const src = readFileSync(PRE_PR, "utf8");
  const start = src.indexOf(BLOCK_START);
  // Fail loudly rather than testing an empty string: if pre-pr.sh is
  // restructured, this must red instead of silently passing on "".
  expect(start).toBeGreaterThan(-1);
  const bodyStart = start + BLOCK_START.length;
  const end = src.indexOf(BLOCK_END, bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  block = src.slice(bodyStart, end);
  // The alternation under test must actually be in what we spliced.
  expect(block).toContain("E-RLS-");
});

/**
 * Run the spliced block with a stub `docker` that emits `output` and exits
 * `code`, standing in for the psql invocation.
 */
function runWith(output, code, blockSource = block) {
  const dir = mkdtempSync(join(tmpdir(), "rls-wl-"));
  const stub = join(dir, "docker");
  writeFileSync(
    stub,
    `#!/bin/sh\ncat >/dev/null 2>&1 || true\ncat <<'FIXTURE_EOF'\n${output}\nFIXTURE_EOF\nexit ${code}\n`,
  );
  chmodSync(stub, 0o755);

  const script = join(dir, "block.sh");
  writeFileSync(script, blockSource);

  return spawnSync("bash", [script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

describe("pre-pr rls-cross-tenant whitelist", () => {
  it("passes a clean run", () => {
    const r = runWith("DO\nDO\nDO", 0);
    expect(r.status).toBe(0);
  });

  // ALLOW side: the seed-dependent row-count blocks cannot pass against a
  // long-lived dev DB, and must not block the developer.
  it.each(["COUNT-A", "COUNT-B", "BYPASS"])(
    "accepts the seed-dependent code [E-RLS-%s]",
    (code) => {
      const r = runWith(
        `NOTICE:  FAIL table=sessions block=verify-A\nERROR:  [E-RLS-${code}] 25 tables failed`,
        3,
      );
      expect(r.status).toBe(0);
      // The message must not claim more than the run proved: ON_ERROR_STOP=1
      // aborts psql at the first failing block, so later statements never
      // parsed.
      expect(r.stdout).toContain("NOT parsed");
    },
  );

  // DENY side: Block 1 needs no seed, so these are real control regressions.
  it.each([
    "FORCE",
    "SECDEF",
    "NULL",
    "SYM",
    "COLPARITY",
    "ROLE",
    "DISCOVER",
    "MANIFEST-EXTRA",
    "MANIFEST-MISSING",
  ])("stays fatal on the seed-independent code [E-RLS-%s]", (code) => {
    const r = runWith(`ERROR:  [E-RLS-${code}] regression detected`, 3);
    expect(r.status).not.toBe(0);
    // The raw psql output must be surfaced, not swallowed.
    expect(r.stdout).toContain(`[E-RLS-${code}]`);
  });

  it("stays fatal on a genuine SQL parse error", () => {
    const r = runWith(
      'ERROR:  syntax error at or near "THIS"\nLINE 2: DO $$ BEGIN THIS IS NOT SQL',
      3,
    );
    expect(r.status).not.toBe(0);
  });

  it("stays fatal on a typo'd code that resembles a whitelisted one", () => {
    // [E-RLS-COUNT] is not [E-RLS-COUNT-A]; a sloppy pattern would accept it.
    const r = runWith("ERROR:  [E-RLS-COUNT] 25 tables failed", 3);
    expect(r.status).not.toBe(0);
  });

  it("stays fatal when psql fails with no recognisable code at all", () => {
    const r = runWith("psql: error: connection to server failed", 2);
    expect(r.status).not.toBe(0);
  });

  // Mutation proof, run in-process: these confirm the assertions above are
  // measuring the alternation rather than merely echoing the exit code.
  describe("mutation proofs", () => {
    it("goes green on [E-RLS-FORCE] once FORCE is added to the alternation", () => {
      const widened = block.replace(
        "(COUNT-A|COUNT-B|BYPASS)",
        "(COUNT-A|COUNT-B|BYPASS|FORCE)",
      );
      expect(widened).not.toBe(block);
      const r = runWith("ERROR:  [E-RLS-FORCE] regression", 3, widened);
      expect(r.status).toBe(0);
    });

    it("goes fatal on [E-RLS-COUNT-A] once COUNT-A is removed from the alternation", () => {
      const narrowed = block.replace(
        "(COUNT-A|COUNT-B|BYPASS)",
        "(COUNT-B|BYPASS)",
      );
      expect(narrowed).not.toBe(block);
      const r = runWith("ERROR:  [E-RLS-COUNT-A] 25 tables failed", 3, narrowed);
      expect(r.status).not.toBe(0);
    });
  });
});
