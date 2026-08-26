/**
 * Self-test for check-worker-logtype.mjs.
 *
 * The gate exists because docs/operations/alerts.md declared that alerting
 * paths carry `_logType` while 19 of 22 error-level worker logs did not, so the
 * cases below are the shapes that were actually in the tree, plus the ways a
 * line can appear compliant without being matchable.
 *
 * Runs the gate as a subprocess against a synthetic repo root, so no case
 * depends on the state of the real tree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GATE = join(REPO_ROOT, "scripts/checks/check-worker-logtype.mjs");

let root;

// The gate reads its namespace set from this document, so the fixture tree needs
// one. Written per-run rather than copied from the repo: a case that asserts
// "an undeclared namespace fails" must control what is declared.
const FIXTURE_NAMESPACES = "worker delivery";

function writeAlertsDoc(root, { marker = FIXTURE_NAMESPACES, sections = [] } = {}) {
  mkdirSync(join(root, "docs/operations"), { recursive: true });
  const body = [
    "# Operational Alert Hooks",
    "",
    marker === null ? "" : `<!-- alert-namespaces: ${marker} -->`,
    "",
    ...sections.map((id) => `## \`${id}\`\n\nfixture section\n`),
  ].join("\n");
  writeFileSync(join(root, "docs/operations/alerts.md"), body);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "worker-logtype-"));
  mkdirSync(join(root, "src/workers"), { recursive: true });
});

beforeEach(() => {
  // Reset to the permissive default; cases that need otherwise rewrite it.
  writeAlertsDoc(root);
});

afterAll(() => {
  // Guarded: `root` is assigned INSIDE beforeAll, so a mkdtempSync failure
  // would otherwise make teardown throw a TypeError that masks the real cause.
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Write one worker file and run the gate over src/workers. */
function runGate(source, { dirs = "src/workers" } = {}) {
  if (source !== null) {
    writeFileSync(join(root, "src/workers/subject.ts"), source);
  }
  return spawnSync("node", [GATE], {
    encoding: "utf8",
    env: {
      ...process.env,
      WORKER_LOGTYPE_ROOT: root,
      WORKER_LOGTYPE_DIRS: dirs,
      WORKER_LOGTYPE_FIXTURE_MODE: "1",
    },
  });
}

describe("check-worker-logtype", () => {
  // The reason string is the operator's remediation instruction, and the gate
  // distinguishes four. Asserting only "exited non-zero" cannot tell a correct
  // classification from a misrouted one.
  it.each([
    [
      "a direct getLogger().error with no _logType",
      `getLogger().error({ err }, "worker.claim_batch_failed");`,
      "no _logType",
    ],
    [
      "an error logged through a local getLogger() binding",
      `const log = getLogger();
       log.error({ err }, "worker.delivery_batch_failed");`,
      "no _logType",
    ],
    [
      "a fatal with no _logType",
      `getLogger().fatal({ err }, "worker.unrecoverable");`,
      "no _logType",
    ],
    [
      // Looks compliant to a reviewer and matches no SIEM rule: the alert is
      // written against a fixed string, so a value the gate cannot read is a
      // value the operator cannot match.
      "a _logType that is a variable rather than a literal",
      `const kind = "worker.x";
       getLogger().error({ err, _logType: kind }, "worker.x");`,
      "not a non-empty string literal",
    ],
    [
      "a _logType built by template substitution",
      `getLogger().error({ err, _logType: \`worker.\${phase}\` }, "worker.x");`,
      "not a non-empty string literal",
    ],
    [
      "an empty _logType",
      `getLogger().error({ err, _logType: "" }, "worker.x");`,
      "not a non-empty string literal",
    ],
    [
      "a message-only error, which has nowhere to carry a _logType",
      `getLogger().error("worker.claim_batch_failed");`,
      "first argument is not an object literal",
    ],
    [
      // Round-1 F-M1: the gate used to accept any non-empty literal, so this
      // passed while matching no rule the document defines.
      "a _logType in a namespace alerts.md does not declare",
      `getLogger().error({ err, _logType: "zzz.broke" }, "zzz.broke");`,
      'namespace "zzz" is not one',
    ],
  ])("FAILS %s", (_label, body, reason) => {
    const r = runGate(`
      declare function getLogger(): any;
      declare const err: unknown;
      declare const phase: string;
      export function f() { ${body} }
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("subject.ts");
    expect(r.stderr).toContain(reason);
  });

  it.each([
    [
      "an inline _logType string literal",
      `getLogger().error({ err, _logType: "worker.claim_batch_failed" }, "worker.claim_batch_failed");`,
      2,
    ],
    [
      "an expanded object with a _logType",
      `getLogger().error(
         { err, outboxId: 1, _logType: "worker.payload_parse_failed" },
         "worker.payload_parse_failed",
       );`,
      2,
    ],
    [
      // Severity is the boundary, and it is the one alerts.md documents.
      // Widening to warn would put every routine worker warn under an alert
      // rule, which is how a gate gets reverted.
      "a warn with no _logType",
      `getLogger().warn({ err }, "delivery.outbox_purged");`,
      1,
    ],
    [
      "an info with no _logType",
      `getLogger().info({ err }, "worker.loop_start");`,
      1,
    ],
    [
      // scripts/audit-chain-verify-worker.ts is this shape. alerts.md already
      // says its lines are printf and must be matched as raw stderr text. The
      // exclusion is a property of the code, not a path on a list that rots.
      "console.error, which is not a structured record",
      `const logger = console;
       logger.error("CHAIN_VERIFY_FAILED tenant=%s", "t");`,
      1,
    ],
    [
      "an error on a receiver that is not a logger",
      `declare const res: { error(a: unknown, b: string): void };
       res.error({ err }, "something");`,
      1,
    ],
  ])("PASSES %s", (_label, body, expectedCallSites) => {
    // The compliant line is load-bearing, not decoration: without a recognised
    // error/fatal call site the gate fails loudly by design (see the
    // "recognises no logger call" case below), and every allow-side fixture
    // would go red for a reason that has nothing to do with its subject.
    const r = runGate(`
      declare function getLogger(): any;
      declare const err: unknown;
      export function anchor() {
        getLogger().error({ err, _logType: "worker.anchor" }, "worker.anchor");
      }
      export function f() { ${body} }
    `);
    expect(r.status).toBe(0);
    // Round-1 F-m7. Every one of these cases still exits 0 with its SUBJECT
    // line deleted — the anchor alone carries it. Asserting the recognised
    // count turns "the gate did not flag it" into "the gate saw exactly what it
    // should have seen and did not flag it", which is the claim the case makes.
    expect(r.stdout).toContain(`${expectedCallSites} error/fatal logger call sites`);
  });

  it("FAILS LOUDLY when a scan target resolves to no files", () => {
    // "Examined nothing" must not be spelled like "found nothing wrong".
    const r = runGate(null, { dirs: "src/does-not-exist" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("scan target(s) resolved to no source file");
    expect(r.stderr).toContain("src/does-not-exist");
  });

  it("names the missing target even when the other targets still resolve", () => {
    // Round-1 F-M2: this is the whole point of a PER-ENTRY floor. A whole-run
    // "scanned 0" check cannot fire while src/workers still has files, so a
    // renamed single-file target vanished with the gate still printing OK.
    const r = runGate(
      `declare function getLogger(): any;
       declare const err: unknown;
       export function f() {
         getLogger().error({ err, _logType: "worker.x" }, "worker.x");
       }`,
      { dirs: "src/workers,src/lib/moved-away.ts" },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("src/lib/moved-away.ts");
    // The resolving target must NOT be named — a floor that reports everything
    // tells the reader nothing about which entry to fix.
    expect(r.stderr).not.toContain("scan target(s) resolved to no source file: src/workers,");
  });

  it("FAILS LOUDLY when alerts.md has no alert-namespaces marker", () => {
    // The gate reads its enforced set from that document. A missing marker is
    // "cannot read the contract", which must not be spelled like "everything
    // matched".
    writeAlertsDoc(root, { marker: null });
    const r = runGate(
      `declare function getLogger(): any;
       declare const err: unknown;
       export function f() {
         getLogger().error({ err, _logType: "worker.x" }, "worker.x");
       }`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("alert-namespaces");
  });

  it("FAILS a documented rule that nothing emits", () => {
    // The reverse direction: a rule whose identifier was renamed away matches a
    // string that can never appear, and is silent for the same reason a healthy
    // system is. Covers the warn-level dead-letter pair, which ALERT_LEVELS
    // deliberately excludes from the presence check.
    writeAlertsDoc(root, { sections: ["delivery.dead_lettered"] });
    const r = runGate(
      `declare function getLogger(): any;
       declare const err: unknown;
       export function f() {
         getLogger().error({ err, _logType: "worker.x" }, "worker.x");
       }`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("delivery.dead_lettered");
    expect(r.stderr).toContain("no getLogger() call site emits");
  });

  it("PASSES a documented rule emitted at WARN level", () => {
    // The allow side of the same check, and the reason it reads every level
    // rather than only ALERT_LEVELS: the dead-letter identifiers are warn.
    writeAlertsDoc(root, { sections: ["delivery.dead_lettered"] });
    const r = runGate(
      `declare function getLogger(): any;
       declare const err: unknown;
       export function f() {
         getLogger().error({ err, _logType: "worker.x" }, "worker.x");
         getLogger().warn(
           { err, _logType: "delivery.dead_lettered" },
           "delivery.dead_lettered",
         );
       }`,
    );
    expect(r.status).toBe(0);
  });

  it("FAILS LOUDLY when it recognises no logger call at all", () => {
    // The distinct failure: files were read, but the gate no longer sees its
    // subject — a renamed factory, a changed call shape, a moved worker. Each
    // would otherwise print OK forever, which is the exact shape of the
    // unmatched-alert defect this gate exists to close.
    const r = runGate(`
      export function f() { return 1; }
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("recognised 0");
  });

  it("REFUSES scan-scope overrides in CI without fixture mode", () => {
    const r = spawnSync("node", [GATE], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
        WORKER_LOGTYPE_ROOT: root,
        WORKER_LOGTYPE_DIRS: "src/workers",
        WORKER_LOGTYPE_FIXTURE_MODE: "",
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("must not be set in CI");
  });

  it("is wired into scripts/pre-pr.sh", () => {
    // The gate's only execution path (CI runs PRE_PR_STATIC_ONLY=1 pre-pr.sh).
    // Anchored at line start: `toContain` stays green against
    // `# DISABLED: queue_step ...`, which is disarming, not deletion.
    const prePr = readFileSync(join(REPO_ROOT, "scripts/pre-pr.sh"), "utf8");
    expect(prePr).toMatch(/^queue_step .*check-worker-logtype\.mjs/m);
  });
});
