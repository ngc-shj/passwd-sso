#!/usr/bin/env node
/**
 * Guards the two modules exempted from `no-console`.
 *
 * `eslint.config.mjs` turns `no-console` off for `src/lib/logger/client.ts` and
 * `src/lib/boot-stderr.ts` — necessary, since the sink has to live somewhere.
 * But an exemption gives zero protection *inside* those files: a future
 * `console.log(fields)` placed before the redact() call, or a
 * `bootStderr(JSON.stringify(result.data))`, fires no gate at all. The override
 * list is the audit surface for "which files may sink"; this script is the
 * audit surface for "what they may sink".
 *
 * A plain call count was the first idea and is not enough — it would pass an
 * unredacted fourth call. So the check is on argument SHAPE:
 *
 *   client.ts     — every console call is exactly `(event, redact(fields))`
 *   boot-stderr.ts — exactly one console call, exactly `render(diagnostic)`
 *
 * The boot form used to be the bare `message` PARAMETER, which was meaningful
 * while a companion gate proved every caller's argument secret-free. Rendering
 * now happens inside the sink, so `message` became an ordinary local and the
 * same assertion stopped constraining anything — a `const message =
 * \`${process.env.AUTH_SECRET}\`` passed. Pinning the call to `render(diagnostic)`
 * restores the binding; `check-boot-diagnostic-shape` covers render's body.
 *
 * Run: node scripts/checks/check-console-sinks.mjs
 *
 * CONSOLE_SINKS_ROOT overrides the scan root (self-test fixtures only).
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { Project, SyntaxKind } from "ts-morph";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// Scan root is overridable so the self-test
// (scripts/__tests__/check-console-sinks.test.mjs) can point the guard at
// fixtures instead of mutating the real tree — mutating it in place raced with
// the other gates `pre-pr.sh` runs concurrently. Production CI uses the default.
const SCAN_ROOT = process.env.CONSOLE_SINKS_ROOT || REPO_ROOT;

const CLIENT = "src/lib/logger/client.ts";
const BOOT = "src/lib/boot-stderr.ts";
const ESLINT_CONFIG = "eslint.config.mjs";

const at = (rel) => resolve(SCAN_ROOT, rel);

const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });
const failures = [];

function consoleCalls(filePath) {
  const sf = project.addSourceFileAtPath(at(filePath));
  return sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => {
      const expr = call.getExpression();
      return (
        expr.getKind() === SyntaxKind.PropertyAccessExpression &&
        expr.getText().startsWith("console.")
      );
    });
}

// ── client.ts: fields must always pass through redact() ──────────────
const clientCalls = consoleCalls(CLIENT);
if (clientCalls.length === 0) {
  failures.push(`${CLIENT}: expected at least one console call; found none (did the sink move?)`);
}
// Exactly `(event, redact(fields))` — nothing else.
//
// An earlier version waved through any single-argument call as "(message) —
// nothing to redact". That was true when the payload was optional; once it
// became required it turned into a hole, because `console.warn(fields)` is also
// a single-argument call and emits the payload unredacted. The gate reported OK
// on exactly the shape it exists to prevent. Enumerating the one legal form
// removes the class rather than the instance.
const EXPECTED_ARGS = ["event", "redact(fields)"];

for (const call of clientCalls) {
  const args = call.getArguments().map((a) => a.getText());
  const line = call.getStartLineNumber();
  if (args.length !== EXPECTED_ARGS.length || args.some((a, i) => a !== EXPECTED_ARGS[i])) {
    failures.push(
      `${CLIENT}:${line}: console call is \`(${args.join(", ")})\`; ` +
        `the only permitted form is \`(${EXPECTED_ARGS.join(", ")})\` — ` +
        `anything else can reach the console unredacted`,
    );
  }
}

// ── boot-stderr.ts: exactly one call, on the bare message param ───────
const bootCalls = consoleCalls(BOOT);
if (bootCalls.length !== 1) {
  failures.push(`${BOOT}: expected exactly 1 console call, found ${bootCalls.length}`);
}
for (const call of bootCalls) {
  const args = call.getArguments();
  const line = call.getStartLineNumber();
  if (args.length !== 1 || args[0].getText() !== "render(diagnostic)") {
    failures.push(
      `${BOOT}:${line}: console call must be exactly \`render(diagnostic)\`, got \`${args
        .map((a) => a.getText())
        .join(", ")}\` — a local binding proves nothing about where the string came from`,
    );
  }
}

// ── the override list itself must not grow silently ──────────────────
// A third exempted file would be a new unguarded sink; this pins the list to
// the two this script actually checks.
const eslintConfig = readFileSync(at(ESLINT_CONFIG), "utf8");
const overrideBlock = eslintConfig.match(
  /files:\s*\[([^\]]*)\][^}]*?"no-console":\s*"off"/s,
);
if (!overrideBlock) {
  failures.push(`${ESLINT_CONFIG}: could not locate the no-console override block`);
} else {
  const exempted = [...overrideBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const expected = [BOOT, CLIENT].sort();
  if (JSON.stringify(exempted) !== JSON.stringify(expected)) {
    failures.push(
      `${ESLINT_CONFIG}: no-console override list is [${exempted.join(", ")}], expected [${expected.join(", ")}] — ` +
        `a new exempt file needs a matching check here`,
    );
  }
}

if (failures.length > 0) {
  console.error("check-console-sinks: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`check-console-sinks: OK (${clientCalls.length} guarded calls in client.ts, ${bootCalls.length} in boot-stderr.ts)`);
