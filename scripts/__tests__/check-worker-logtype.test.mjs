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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GATE = join(REPO_ROOT, "scripts/checks/check-worker-logtype.mjs");

let root;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "worker-logtype-"));
  mkdirSync(join(root, "src/workers"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
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
  it.each([
    [
      "a direct getLogger().error with no _logType",
      `getLogger().error({ err }, "worker.claim_batch_failed");`,
    ],
    [
      "an error logged through a local getLogger() binding",
      `const log = getLogger();
       log.error({ err }, "worker.delivery_batch_failed");`,
    ],
    [
      "a fatal with no _logType",
      `getLogger().fatal({ err }, "worker.unrecoverable");`,
    ],
    [
      // Looks compliant to a reviewer and matches no SIEM rule: the alert is
      // written against a fixed string, so a value the gate cannot read is a
      // value the operator cannot match.
      "a _logType that is a variable rather than a literal",
      `const kind = "worker.x";
       getLogger().error({ err, _logType: kind }, "worker.x");`,
    ],
    [
      "a _logType built by template substitution",
      `getLogger().error({ err, _logType: \`worker.\${phase}\` }, "worker.x");`,
    ],
    [
      "an empty _logType",
      `getLogger().error({ err, _logType: "" }, "worker.x");`,
    ],
    [
      "a message-only error, which has nowhere to carry a _logType",
      `getLogger().error("worker.claim_batch_failed");`,
    ],
  ])("FAILS %s", (_label, body) => {
    const r = runGate(`
      declare function getLogger(): any;
      declare const err: unknown;
      declare const phase: string;
      export function f() { ${body} }
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("subject.ts");
  });

  it.each([
    [
      "an inline _logType string literal",
      `getLogger().error({ err, _logType: "worker.claim_batch_failed" }, "worker.claim_batch_failed");`,
    ],
    [
      "an expanded object with a _logType",
      `getLogger().error(
         { err, outboxId: 1, _logType: "worker.payload_parse_failed" },
         "worker.payload_parse_failed",
       );`,
    ],
    [
      // Severity is the boundary, and it is the one alerts.md documents.
      // Widening to warn would put every routine worker warn under an alert
      // rule, which is how a gate gets reverted.
      "a warn with no _logType",
      `getLogger().warn({ err }, "delivery.outbox_purged");`,
    ],
    [
      "an info with no _logType",
      `getLogger().info({ err }, "worker.loop_start");`,
    ],
    [
      // scripts/audit-chain-verify-worker.ts is this shape. alerts.md already
      // says its lines are printf and must be matched as raw stderr text. The
      // exclusion is a property of the code, not a path on a list that rots.
      "console.error, which is not a structured record",
      `const logger = console;
       logger.error("CHAIN_VERIFY_FAILED tenant=%s", "t");`,
    ],
    [
      "an error on a receiver that is not a logger",
      `declare const res: { error(a: unknown, b: string): void };
       res.error({ err }, "something");`,
    ],
  ])("PASSES %s", (_label, body) => {
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
  });

  it("FAILS LOUDLY when the scan root resolves to no files", () => {
    // "Examined nothing" must not be spelled like "found nothing wrong".
    const r = runGate(null, { dirs: "src/does-not-exist" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("scanned 0 source files");
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
