#!/usr/bin/env node
/**
 * CI guard: the boot sink's INTERNAL invariants — the ones no declaration file
 * can express.
 *
 * The public contract of `@/lib/boot-events` and `@/lib/boot-stderr` is guarded
 * by `check-public-contract.mjs`, which diffs `tsc`'s own declaration output
 * against a tracked baseline. Anything a caller can import lives there.
 *
 * This file covers what the compiler emits nothing about: how `envVarName`
 * produces a value, where the allowed names come from, what the sentinel is, and
 * what `render` may reach for. Those are body-level facts, invisible in a
 * `.d.ts`, and each of them is load-bearing for "no secret reaches raw stderr".
 *
 * WHY IT IS THIS SHORT NOW.
 *
 * An earlier version also policed the public surface by walking syntax, and was
 * escaped five times across five review rounds — `as EnvVarName` missed
 * `<EnvVarName>x`, both assertion forms missed a type predicate, owner names
 * missed a function called `variables`, unnamed-export rules missed a same-name
 * re-export, export names missed a value/type namespace collision. Each fix
 * closed an instance; the class stayed open, because a syntax matcher with no
 * type resolution can only compare spellings and a language has unbounded ways
 * to spell one thing. That whole category moved to the compiler. What is left
 * here is small, and small on purpose.
 *
 * SCOPE. This does not defend against someone editing these sources with intent
 * — such a person can edit this gate too. It catches the ordinary case: a
 * refactor or a convenience helper that quietly breaks an invariant nobody
 * remembered was there.
 *
 * BOOT_DIAGNOSTIC_ROOT overrides the scan root (self-test fixtures only).
 */
import { SyntaxKind } from "ts-morph";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.BOOT_DIAGNOSTIC_ROOT
  ? process.env.BOOT_DIAGNOSTIC_ROOT
  : join(__dirname, "..", "..");

const EVENTS_FILE = "src/lib/boot-events.ts";
const SINK_FILE = "src/lib/boot-stderr.ts";

console.log(`check-boot-diagnostic-shape: ROOT=${REPO_ROOT}`);

const project = createAstProject();
const failures = [];

function addFile(rel) {
  try {
    return project.createSourceFile(rel, readFileSync(join(REPO_ROOT, rel), "utf8"), {
      overwrite: true,
    });
  } catch {
    failures.push(`${rel}: cannot be read — did the boot sink move?`);
    return null;
  }
}

const events = addFile(EVENTS_FILE);
const sink = addFile(SINK_FILE);

if (events) {
  // ── DECLARED is the schema's key list ──────────────────────────────
  //
  // Everything else rests on this. Checked as a whole expression rather than by
  // looking for a matching call somewhere: an earlier version accepted
  // `Object.keys(getSchemaShape())` appearing anywhere in a function, which let
  // the call be evaluated and discarded while a hand-written list was returned.
  const schemaAccessors = new Set();
  for (const decl of events.getImportDeclarations()) {
    if (decl.getModuleSpecifierValue() !== "@/lib/env-schema") continue;
    for (const named of decl.getNamedImports()) {
      if (["getSchemaShape", "envObject"].includes(named.getName())) {
        schemaAccessors.add((named.getAliasNode() ?? named.getNameNode()).getText());
      }
    }
  }
  if (schemaAccessors.size === 0) {
    failures.push(
      `${EVENTS_FILE}: no schema accessor imported from \`@/lib/env-schema\` — the allowed ` +
        `names must come from the schema itself`,
    );
  }

  const listDecl = events.getVariableDeclaration("DECLARED");
  if (!listDecl) {
    failures.push(`${EVENTS_FILE}: no \`DECLARED\` list of schema-derived names`);
  } else {
    let init = listDecl.getInitializer();
    while (init && init.getKind() === SyntaxKind.AsExpression) init = init.getExpression();
    const isSchemaKeys =
      init?.getKind() === SyntaxKind.CallExpression &&
      init.getExpression().getText() === "Object.keys" &&
      (() => {
        const shape = init.getArguments()[0];
        return (
          shape?.getKind() === SyntaxKind.CallExpression &&
          schemaAccessors.has(shape.getExpression().getText())
        );
      })();
    if (!isSchemaKeys) {
      failures.push(
        `${EVENTS_FILE}:${listDecl.getStartLineNumber()}: DECLARED is ` +
          `\`${listDecl.getInitializer()?.getText().slice(0, 60) ?? "<none>"}\`, not ` +
          `\`Object.keys(<schema accessor>())\` — every name this module can emit comes from ` +
          `here, so it must come from the schema`,
      );
    }
  }

  // ── the sentinel is fixed and cannot pass for a real name ──────────
  //
  // Pinning only its declaration NAME was a live leak: `const NOT_A_VAR_NAME =
  // process.env.AUTH_SECRET as EnvVarName` passed, and this value is returned on
  // every unmatched lookup. Pinning only "some string literal" was still wrong:
  // `"DATABASE_URL"` reported a genuine-looking variable for every miss.
  const sentinel = events.getVariableDeclaration("NOT_A_VAR_NAME");
  if (!sentinel) {
    failures.push(`${EVENTS_FILE}: no \`NOT_A_VAR_NAME\` sentinel`);
  } else {
    let expr = sentinel.getInitializer();
    while (
      expr &&
      (expr.getKind() === SyntaxKind.AsExpression ||
        expr.getKind() === SyntaxKind.TypeAssertionExpression)
    ) {
      expr = expr.getExpression();
    }
    const kind = expr?.getKind();
    if (kind !== SyntaxKind.StringLiteral && kind !== SyntaxKind.NoSubstitutionTemplateLiteral) {
      failures.push(
        `${EVENTS_FILE}:${sentinel.getStartLineNumber()}: NOT_A_VAR_NAME is ` +
          `\`${expr?.getText().slice(0, 50) ?? "<none>"}\`, not a string literal — it is ` +
          `returned on every unmatched lookup, so anything computed here reaches stderr`,
      );
    } else {
      // Checked as the PROPERTY (not identifier-shaped) rather than the exact
      // spelling, so renaming it to `<none>` stays legal.
      const value = expr.getLiteralText();
      if (value.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        failures.push(
          `${EVENTS_FILE}:${sentinel.getStartLineNumber()}: NOT_A_VAR_NAME is "${value}", ` +
            `which is shaped like a real environment variable name — the sentinel must be ` +
            `impossible to mistake for one`,
        );
      }
    }
  }

  // ── envVarName SELECTS a stored name; it never re-brands its input ──
  //
  // Successive designs each left something to be trusted: a shape regex, then a
  // caller-supplied allowlist, then a `raw is EnvVarName` predicate — and a
  // predicate is an assertion TypeScript TRUSTS, so its body was still an
  // unverified claim. Returning an element of DECLARED removes the check from
  // the trusted path: whatever comes back is a schema key by construction, and a
  // broken comparison yields the wrong NAME rather than a secret.
  const ctor = events.getFunction("envVarName");
  if (!ctor) {
    failures.push(`${EVENTS_FILE}: no \`envVarName\` accessor`);
  } else {
    if (ctor.getParameters().length !== 1) {
      failures.push(
        `${EVENTS_FILE}: envVarName takes ${ctor.getParameters().length} parameters; expected 1 — ` +
          `a caller-supplied allowlist lets the constrained code choose its own trust anchor`,
      );
    }
    const rebrands = ctor
      .getDescendantsOfKind(SyntaxKind.AsExpression)
      .filter((a) => a.getTypeNode()?.getText() === "EnvVarName");
    if (rebrands.length > 0) {
      failures.push(
        `${EVENTS_FILE}:${rebrands[0].getStartLineNumber()}: envVarName casts to EnvVarName — ` +
          `the value returned must come from DECLARED, not from the input`,
      );
    }
    const returns = ctor.getDescendantsOfKind(SyntaxKind.ReturnStatement);
    if (returns.length !== 1) {
      failures.push(
        `${EVENTS_FILE}: envVarName has ${returns.length} return statements; expected 1`,
      );
    }
    const selectsFromList = (returns[0]?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? [])
      .some((c) => {
        const callee = c.getExpression();
        return (
          callee.getKind() === SyntaxKind.PropertyAccessExpression &&
          ["find", "get"].includes(callee.getName()) &&
          callee.getExpression().getText() === "DECLARED"
        );
      });
    if (!selectsFromList) {
      failures.push(
        `${EVENTS_FILE}: envVarName does not return a value selected from \`DECLARED\` ` +
          `(via .find/.get) — returning anything derived from the input puts the guarantee ` +
          `back on a check being correct`,
      );
    }
  }
}

if (sink) {
  // ── render builds text only from the diagnostic it was handed ───────
  //
  // Moving rendering into the sink created a prose-assembly site no gate read.
  // Proven necessary: a render body interpolating `process.env.AUTH_SECRET`
  // passed every other check, in the one file where `no-console` is off.
  const render = sink.getFunction("render");
  if (!render) {
    failures.push(`${SINK_FILE}: no \`render\` function — did the sink's rendering move?`);
  } else if (/\bprocess\b/.test(render.getBody()?.getText() ?? "")) {
    failures.push(
      `${SINK_FILE}:${render.getStartLineNumber()}: render() reads \`process\` — the sink must ` +
        `build its text only from the diagnostic it was handed`,
    );
  }

  // The sink's imports bound what it can reach at all.
  for (const decl of sink.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (spec !== "@/lib/boot-events") {
      failures.push(
        `${SINK_FILE}: imports \`${spec}\`; the sink may import only \`@/lib/boot-events\` — ` +
          `every additional import is a value it could interpolate`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("check-boot-diagnostic-shape: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  "check-boot-diagnostic-shape: OK (DECLARED schema-derived; sentinel fixed; " +
    "envVarName selects; render bounded)",
);
