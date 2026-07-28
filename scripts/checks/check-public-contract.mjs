#!/usr/bin/env node
/**
 * CI guard: the boot sink's PUBLIC CONTRACT is whatever `tsc` says it is.
 *
 * `src/lib/boot-events.ts`, `src/lib/boot-stderr.ts` and the key-provider types
 * they depend on are compiled to declaration files and compared against a
 * tracked baseline. Any change to what a caller can import — a new export, a
 * widened field, a different signature, a type predicate, a re-export, a
 * namespace collision — appears in the emitted `.d.ts` and fails the comparison.
 *
 * WHY THIS AND NOT AN AST SCAN.
 *
 * The predecessor enumerated syntax, and across five review rounds it was
 * escaped five times, each by a spelling it had not been taught:
 *
 *   `as EnvVarName`          -> missed `<EnvVarName>x`
 *   both assertion syntaxes  -> missed a type predicate
 *   owner NAMES              -> missed a function named `variables`
 *   unnamed exports          -> missed a same-name re-export
 *   export NAMES             -> missed a value/type namespace collision
 *
 * Each round closed an instance and left the class open, because the tool had no
 * type resolution: ts-morph without a Program can compare spellings, and a
 * language has unbounded ways to spell the same thing. The compiler does not
 * have that problem. Everything importable appears in its declaration output by
 * construction, so there is nothing left to enumerate.
 *
 * SCOPE — what this does NOT defend against.
 *
 * Someone who can edit these sources can also edit this gate, its baseline, or
 * the CI config. Resisting a hostile rewrite is not a property a CI check can
 * have on its own; that belongs to code review, protected branches, and
 * protected CI settings. What this DOES catch is the far likelier case: a
 * refactor or a convenience helper that widens the surface without anyone
 * noticing, including changes whose author had no idea a contract existed.
 *
 * Internal invariants that never reach the .d.ts — where DECLARED comes from,
 * that envVarName selects rather than re-brands, the sentinel's value, what
 * render() may read — stay in `check-boot-diagnostic-shape.mjs`.
 *
 * Usage:
 *   node scripts/checks/check-public-contract.mjs            # verify
 *   node scripts/checks/check-public-contract.mjs --update   # rewrite baseline
 *
 * `--update` is the ONLY path that writes the baseline, and CI never passes it.
 * A check that could refresh its own expectation would report success by
 * definition.
 *
 * Test overrides (self-test fixtures only):
 *   PUBLIC_CONTRACT_BASELINE   baseline path
 *   PUBLIC_CONTRACT_TSCONFIG   tsconfig to compile, so a fixture tree can be
 *                              used instead of the real sources
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const TSCONFIG =
  process.env.PUBLIC_CONTRACT_TSCONFIG || join(__dirname, "tsconfig.public-contract.json");
const BASELINE =
  process.env.PUBLIC_CONTRACT_BASELINE || join(__dirname, "boot-public-contract.d.txt");

/**
 * The compiler pinned by package-lock, invoked directly.
 *
 * Not `npx tsc`: with no local install npx will fetch some other version from
 * the registry, and a baseline is only meaningful against a fixed compiler —
 * declaration output changes between TypeScript releases. Missing binary is a
 * hard failure rather than a silent substitution.
 */
const TSC = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

/**
 * Emitted in this order; the baseline is their concatenation.
 *
 * `key-provider/types` is here because `BootDiagnostic` carries `ProviderName`
 * and `KeyName`. Widening either to `string` would not change boot-events'
 * declaration — the field still reads `provider: ProviderName` — so without this
 * the closure of those unions would go unchecked. It is a 45-line type-only file
 * that has changed five times in the repo's history, so the churn is negligible
 * against covering it with the compiler rather than a hand-written resolver.
 */
const CONTRACT_FILES = [
  "src/lib/boot-events.d.ts",
  "src/lib/boot-stderr.d.ts",
  "src/lib/key-provider/types.d.ts",
];

const update = process.argv.includes("--update");

/**
 * Emit declarations into a throwaway directory.
 *
 * Never into the working tree: a gate that leaves artifacts behind races the
 * other checks `pre-pr.sh` runs concurrently, and a stray .d.ts under src/ would
 * be picked up by the app's own typecheck.
 */
function emitDeclarations() {
  if (!existsSync(TSC)) {
    console.error(`check-public-contract: FAIL — no pinned TypeScript at ${TSC}`);
    console.error("Run `npm ci`; the baseline is only meaningful against the locked compiler.");
    process.exit(1);
  }

  const outDir = mkdtempSync(join(tmpdir(), "public-contract-"));

  // A failed compile invalidates the baseline, even when files were emitted.
  //
  // An earlier version tolerated a non-zero exit as long as the three .d.ts
  // existed. That is fail-open: `noEmitOnError` is off, so tsc writes
  // declarations anyway, and a module it could not resolve degrades to `any` in
  // the output. Measured, this was not hypothetical — the self-test fixture had
  // no `node_modules`, so 31 errors (`Cannot find module 'zod'`, `Cannot find
  // name 'process'`) were being swallowed, and deleting a file from the fixture's
  // import closure still reported OK. Declarations produced from a broken
  // program describe nothing.
  try {
    execFileSync("node", [TSC, "-p", TSCONFIG, "--outDir", outDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (err) {
    rmSync(outDir, { recursive: true, force: true });
    console.error("check-public-contract: FAIL — tsc reported errors, so the emitted");
    console.error("declarations cannot be trusted as the contract.");
    console.error("");
    console.error(`${err.stdout ?? ""}${err.stderr ?? ""}`.trim());
    process.exit(1);
  }

  const missing = CONTRACT_FILES.filter((f) => !existsSync(join(outDir, f)));
  if (missing.length > 0) {
    rmSync(outDir, { recursive: true, force: true });
    console.error("check-public-contract: FAIL — tsc exited clean but emitted nothing for:");
    for (const f of missing) console.error(`  ${f}`);
    process.exit(1);
  }

  const sections = CONTRACT_FILES.map((rel) => {
    const body = readFileSync(join(outDir, rel), "utf8").replace(/\r\n/g, "\n").trim();
    return `// -- ${rel} --\n${body}\n`;
  });
  rmSync(outDir, { recursive: true, force: true });
  return sections.join("\n");
}

/**
 * Minimal unified diff, so a failure shows what moved rather than "differs".
 *
 * Exhausted sides get explicit branches rather than a comparison against a
 * sentinel value. An earlier version used one, and a stray NUL byte in that
 * literal made git classify this entire file as binary — so the gate whose job
 * is keeping a contract change reviewable was itself undiffable. There is no
 * sentinel here to get wrong.
 */
function unifiedDiff(expected, actual) {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const out = [];
  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (i >= a.length) {
      out.push(`+ ${b[j]}`);
      j += 1;
      continue;
    }
    if (j >= b.length) {
      out.push(`- ${a[i]}`);
      i += 1;
      continue;
    }
    // Both sides still have lines and they differ. Resynchronize on whichever
    // current line reappears sooner on the other side; the lines skipped to
    // reach it are the additions or removals.
    const nextB = b.indexOf(a[i], j);
    const nextA = a.indexOf(b[j], i);
    if (nextB === -1 && nextA === -1) {
      out.push(`- ${a[i]}`);
      out.push(`+ ${b[j]}`);
      i += 1;
      j += 1;
    } else if (nextA === -1 || (nextB !== -1 && nextB - j <= nextA - i)) {
      out.push(`+ ${b[j]}`);
      j += 1;
    } else {
      out.push(`- ${a[i]}`);
      i += 1;
    }
  }
  return out;
}

const actual = emitDeclarations();

if (update) {
  writeFileSync(BASELINE, actual, "utf8");
  console.log(`check-public-contract: baseline written to ${BASELINE}`);
  console.log("Review the diff before committing — this file IS the contract.");
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`check-public-contract: FAIL — no baseline at ${BASELINE}`);
  console.error("Create it with: node scripts/checks/check-public-contract.mjs --update");
  process.exit(1);
}

const expected = readFileSync(BASELINE, "utf8").replace(/\r\n/g, "\n");

if (expected !== actual) {
  console.error("check-public-contract: FAIL — the public contract changed.");
  console.error("");
  for (const line of unifiedDiff(expected, actual)) console.error(`  ${line}`);
  console.error("");
  console.error("This is the surface callers can import. If the change is intended,");
  console.error("run `node scripts/checks/check-public-contract.mjs --update` and commit");
  console.error("the baseline WITH the change, so the new surface is reviewed as a diff.");
  process.exit(1);
}

console.log(
  `check-public-contract: OK (${CONTRACT_FILES.length} declaration files match the baseline)`,
);
