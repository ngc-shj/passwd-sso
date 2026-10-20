/**
 * Self-test for scripts/rls-verify-run.sh's standalone mode: the WARNING-set
 * checks over the RLS-MARKER regions of rls-cross-tenant-verify.sql, and the
 * requirement that a run which succeeded emitted every region (otherwise the
 * region checks are no-ops and the gate is green on nothing).
 *
 * The wrapped command is a fake that prints canned psql output and exits with
 * a chosen code, so each case pins one branch without a database.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WRAPPER = resolve(ROOT, "scripts/rls-verify-run.sh");

const notice = (m) => `psql:verify.sql:1: NOTICE:  ${m}`;
const warning = (t) => `psql:verify.sql:1: WARNING:  rls_bypass_not_granted table=${t} purpose=x`;

/** Output of a complete run: Block 4, then one report region per table. */
function completeRun({ block4Warnings = [], reports = { users: ["users"], sessions: ["sessions"] } } = {}) {
  return [
    notice("RLS-MARKER:block=4-start"),
    ...block4Warnings.map(warning),
    notice("RLS-MARKER:block=4-end"),
    ...Object.entries(reports).flatMap(([t, warned]) => [notice(`RLS-MARKER:block=report table=${t}`), ...warned.map(warning)]),
    notice("RLS-MARKER:block=report-end"),
  ].join("\n");
}

// The wrapped command: a stub standing in for psql. Its canned output and exit
// code come from the environment, so no command string is assembled here.
let fakePsql;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "rls-verify-run-"));
  fakePsql = join(dir, "fake-psql");
  // psql writes NOTICE/WARNING to stderr and results to stdout; the wrapper must
  // merge both, so the stub puts the canned output on stderr.
  writeFileSync(fakePsql, '#!/usr/bin/env bash\nprintf "DO\\n"\nprintf "%s\\n" "$FAKE_PSQL_STDERR" >&2\nexit "$FAKE_PSQL_CODE"\n');
  chmodSync(fakePsql, 0o755);
});

function run(output, code = 0) {
  const r = spawnSync("bash", [WRAPPER, "--", fakePsql], {
    encoding: "utf8",
    env: { ...process.env, FAKE_PSQL_STDERR: output, FAKE_PSQL_CODE: String(code) },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("rls-verify-run.sh (standalone)", () => {
  it("passes a complete run whose regions raise exactly their own table", () => {
    const { status, stdout } = run(completeRun());
    expect(status).toBe(0);
    // Both of psql's streams are merged into what the wrapper prints.
    expect(stdout).toContain("DO");
    expect(stdout).toContain("RLS-MARKER:block=report-end");
  });

  it("fails a run that succeeded without emitting the markers", () => {
    const { status, stderr } = run("DO\nDO\n");
    expect(status).toBe(1);
    expect(stderr).toContain("never emitted 'RLS-MARKER:block=4-start'");
  });

  it("fails a successful run that is missing only the report regions", () => {
    const output = [notice("RLS-MARKER:block=4-start"), notice("RLS-MARKER:block=4-end")].join("\n");
    const { status, stderr } = run(output);
    expect(status).toBe(1);
    expect(stderr).toContain("never emitted 'RLS-MARKER:block=report table='");
  });

  it("propagates a failed run's exit code without the presence check", () => {
    // A run that failed in Block 1-4 never reaches the markers; its own
    // failure is the signal.
    const { status, stderr } = run("ERROR:  [E-RLS-SYM] asymmetric", 3);
    expect(status).toBe(3);
    expect(stderr).not.toContain("never emitted");
  });

  it("fails a WARNING inside the full-grant region", () => {
    const { status, stderr } = run(completeRun({ block4Warnings: ["users"] }));
    expect(status).toBe(1);
    expect(stderr).toContain("Block 4 (full grant)");
  });

  it("fails a report region that raises a table other than its own", () => {
    const { status, stderr } = run(completeRun({ reports: { users: ["users", "sessions"] } }));
    expect(status).toBe(1);
    expect(stderr).toContain("left out 'users'");
  });

  it("fails a report region that raises nothing", () => {
    const { status, stderr } = run(completeRun({ reports: { users: [] } }));
    expect(status).toBe(1);
    expect(stderr).toContain("got {none}");
  });
});
