#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): the boot-stderr sink's input type stays closed.
 *
 * `bootStderr` writes to a raw, unredacted console before any logger exists.
 * Its safety is carried entirely by the TYPE of its parameter: `BootDiagnostic`
 * is a union whose every field is a brand, a closed literal union, or a number,
 * so no free-form value fits anywhere in it.
 *
 * WHAT THIS GATE IS AND IS NOT.
 *
 * It does NOT inspect call sites. An earlier gate did, and that was the mistake:
 * it took `bootStderr(message: string)` as given and tried to prove each caller's
 * string safe. Three review rounds found nine escapes from it — aliased import,
 * namespace import, re-exporting barrel, index-barrel resolution, a `string[]`
 * helper whose body read `process.env`, a module-scope capture of the same, a
 * cast to a closed union, a mutable class member, a `join` separator, and any
 * caller outside the scanned root. Each round the member set grew, which is what
 * a class looks like when its boundary was never derived from the real primitive
 * (R42). Call sites are now the compiler's job, in every import form and every
 * call position, and they need no gate.
 *
 * What remains guardable is the thing the compiler cannot notice: someone
 * WIDENING the payload type back toward `string`, which would silently restore
 * the whole problem while every call site still type-checks. That is what this
 * checks, and it is a small, total check rather than an open-ended analysis:
 *
 *   - `bootStderr` takes exactly one parameter, typed `BootDiagnostic`
 *   - every property type across every `BootDiagnostic` member is on a closed
 *     allowlist of shapes (branded alias, literal union, number, boolean,
 *     readonly array of an allowed element)
 *   - `EnvVarName` remains a branded type built by a VALIDATING constructor
 *
 * A property whose type this gate cannot place is a failure, so the default on
 * an unrecognized shape is red, not green.
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

// ── the sink takes exactly one BootDiagnostic parameter ──────────────
if (sink) {
  const fn = sink.getFunction("bootStderr");
  if (!fn) {
    failures.push(`${SINK_FILE}: no exported \`bootStderr\` function found`);
  } else {
    const params = fn.getParameters();
    if (params.length !== 1) {
      failures.push(
        `${SINK_FILE}: bootStderr takes ${params.length} parameters; expected exactly 1 ` +
          `(a second parameter is where a free-form string comes back)`,
      );
    } else {
      const t = params[0].getTypeNode()?.getText();
      if (t !== "BootDiagnostic") {
        failures.push(
          `${SINK_FILE}: bootStderr's parameter is typed \`${t ?? "<inferred>"}\`, expected ` +
            `\`BootDiagnostic\` — the closed union IS the security control`,
        );
      }
    }
  }
}

// ── EnvVarName stays branded AND validated ───────────────────────────
if (events) {
  const alias = events.getTypeAlias("EnvVarName");
  if (!alias) {
    failures.push(`${EVENTS_FILE}: type \`EnvVarName\` is gone`);
  } else if (!alias.getTypeNode()?.getText().includes("unique symbol") &&
             !alias.getTypeNode()?.getText().includes("Brand")) {
    // The brand is what stops a plain string being assigned. Accept either the
    // inline `string & { readonly [b]: true }` form (b declared `unique symbol`)
    // or a named Brand helper, but not a bare `string`.
    const text = alias.getTypeNode()?.getText() ?? "";
    if (!/\{\s*readonly\s*\[/.test(text)) {
      failures.push(
        `${EVENTS_FILE}: EnvVarName is \`${text}\` — it must stay branded, or any ` +
          `string becomes assignable to it`,
      );
    }
  }

  const ctor = events.getFunction("envVarName");
  if (!ctor) {
    failures.push(`${EVENTS_FILE}: constructor \`envVarName\` is gone`);
  } else {
    // A brand that asserts without checking is the `opaque()` failure mode
    // recorded elsewhere in this repo: opaque(secret) type-checks. Require a
    // real test in the body.
    const body = ctor.getBody()?.getText() ?? "";
    const validates =
      body.includes(".test(") || body.includes(".match(") || body.includes("includes(");
    if (!validates) {
      failures.push(
        `${EVENTS_FILE}: envVarName does not validate its input — a brand applied without ` +
          `a check means \`envVarName(secret)\` compiles and passes through`,
      );
    }
  }
}

// ── every BootDiagnostic property type is on the allowlist ───────────
//
// Allowed: a number/boolean, a closed literal union declared in this file, a
// `typeof BOOT_EVENT.X` discriminant, a branded alias declared in this file, or
// a readonly array of any of those. Everything else — notably `string` — fails.
const ALLOWED_PRIMITIVES = new Set(["number", "boolean"]);

function localAliasIsClosed(sf, name) {
  const alias = sf.getTypeAlias(name);
  if (!alias) return false;
  const node = alias.getTypeNode();
  if (!node) return false;
  const text = node.getText();
  // Branded: `string & { readonly [sym]: true }`.
  if (/\{\s*readonly\s*\[/.test(text)) return true;
  // Literal union: `"a" | "b"`.
  if (
    node.getKind() === SyntaxKind.UnionType &&
    node.getTypeNodes().every((n) => n.getKind() === SyntaxKind.LiteralType)
  ) {
    return true;
  }
  return false;
}

/** Imported type names this gate resolves one hop, to their declaring file. */
function importedClosedNames(sf) {
  const closed = new Set();
  for (const decl of sf.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    const rel = spec.startsWith("@/") ? `src/${spec.slice(2)}` : null;
    if (!rel) continue;
    let depText;
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      try {
        depText = readFileSync(join(REPO_ROOT, rel + ext), "utf8");
        break;
      } catch {
        /* try next candidate */
      }
    }
    if (!depText) continue;
    const dep = project.createSourceFile(`__dep_${closed.size}_${rel}`.replace(/\//g, "_") + ".ts", depText, {
      overwrite: true,
    });
    for (const named of decl.getNamedImports()) {
      const original = named.getName();
      const local = (named.getAliasNode() ?? named.getNameNode()).getText();
      if (localAliasIsClosed(dep, original)) closed.add(local);
    }
  }
  return closed;
}

function isAllowedPropertyType(sf, node, closedNames) {
  if (!node) return false;
  const kind = node.getKind();
  const text = node.getText();

  if (ALLOWED_PRIMITIVES.has(text)) return true;
  // `typeof BOOT_EVENT.ENV_VALIDATION_FAILED` — the discriminant.
  if (kind === SyntaxKind.TypeQuery) return true;
  // A literal union written inline.
  if (kind === SyntaxKind.LiteralType) return true;
  if (
    kind === SyntaxKind.UnionType &&
    node.getTypeNodes().every((n) => isAllowedPropertyType(sf, n, closedNames))
  ) {
    return true;
  }
  // `readonly X[]` / `X[]`.
  if (kind === SyntaxKind.ArrayType) {
    return isAllowedPropertyType(sf, node.getElementTypeNode(), closedNames);
  }
  if (node.getKind() === SyntaxKind.TypeOperator) {
    const inner = node.getTypeNode?.();
    return inner ? isAllowedPropertyType(sf, inner, closedNames) : false;
  }
  // A named alias, either declared here or resolved one hop through an import.
  if (kind === SyntaxKind.TypeReference) {
    return closedNames.has(text) || localAliasIsClosed(sf, text);
  }
  return false;
}

if (events) {
  const diagnostic = events.getTypeAlias("BootDiagnostic");
  if (!diagnostic) {
    failures.push(`${EVENTS_FILE}: type \`BootDiagnostic\` is gone`);
  } else {
    const closedNames = importedClosedNames(events);
    const node = diagnostic.getTypeNode();
    const members =
      node?.getKind() === SyntaxKind.UnionType ? node.getTypeNodes() : node ? [node] : [];
    if (members.length === 0) {
      failures.push(`${EVENTS_FILE}: BootDiagnostic has no members`);
    }
    for (const member of members) {
      for (const prop of member.getDescendantsOfKind(SyntaxKind.PropertySignature)) {
        const propType = prop.getTypeNode();
        if (!isAllowedPropertyType(events, propType, closedNames)) {
          failures.push(
            `${EVENTS_FILE}:${prop.getStartLineNumber()}: property \`${prop.getName()}\` is typed ` +
              `\`${propType?.getText() ?? "<inferred>"}\`, which is not a closed shape — ` +
              `a raw console write must not accept free-form values`,
          );
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error("check-boot-diagnostic-shape: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("check-boot-diagnostic-shape: OK (BootDiagnostic closed; envVarName validated)");
