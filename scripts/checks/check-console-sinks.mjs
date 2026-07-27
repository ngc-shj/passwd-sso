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
 *   client.ts     — every console call is `(message)` or `(message, redact(fields))`
 *   boot-stderr.ts — exactly one console call, taking the bare `message` param
 *
 * Run: node scripts/checks/check-console-sinks.mjs
 */

import { readFileSync } from "node:fs";
import { Project, SyntaxKind } from "ts-morph";

const CLIENT = "src/lib/logger/client.ts";
const BOOT = "src/lib/boot-stderr.ts";

const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });
const failures = [];

function consoleCalls(filePath) {
  const sf = project.addSourceFileAtPath(filePath);
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
for (const call of clientCalls) {
  const args = call.getArguments();
  const line = call.getStartLineNumber();
  if (args.length === 1) continue; // (message) — nothing to redact
  if (args.length !== 2) {
    failures.push(`${CLIENT}:${line}: console call takes ${args.length} args; expected (message) or (message, redact(fields))`);
    continue;
  }
  const second = args[1].getText();
  if (!/^redact\(/.test(second)) {
    failures.push(
      `${CLIENT}:${line}: second argument is \`${second}\`, not a redact(...) call — ` +
        `fields would reach the console unredacted`,
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
  if (args.length !== 1 || args[0].getText() !== "message") {
    failures.push(
      `${BOOT}:${line}: console call must take the bare \`message\` parameter, got \`${args
        .map((a) => a.getText())
        .join(", ")}\` — an interpolated or serialized argument can carry a secret`,
    );
  }
}

// ── the override list itself must not grow silently ──────────────────
// A third exempted file would be a new unguarded sink; this pins the list to
// the two this script actually checks.
const eslintConfig = readFileSync("eslint.config.mjs", "utf8");
const overrideBlock = eslintConfig.match(
  /files:\s*\[([^\]]*)\][^}]*?"no-console":\s*"off"/s,
);
if (!overrideBlock) {
  failures.push("eslint.config.mjs: could not locate the no-console override block");
} else {
  const exempted = [...overrideBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const expected = [BOOT, CLIENT].sort();
  if (JSON.stringify(exempted) !== JSON.stringify(expected)) {
    failures.push(
      `eslint.config.mjs: no-console override list is [${exempted.join(", ")}], expected [${expected.join(", ")}] — ` +
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
