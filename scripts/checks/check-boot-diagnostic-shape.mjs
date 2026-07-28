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
    // Membership against a set the CALLER CANNOT CHOOSE.
    //
    // Two lessons, both learned the hard way. A brand that asserts without
    // checking is the `opaque()` failure mode. A SHAPE check is no better: the
    // constructor once tested `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`, which every
    // identifier-shaped secret this repo handles satisfies — a 64-char hex
    // master key, an `AKIA…` id, an `api_…` token. A predicate over a value's
    // FORM cannot answer a question about its ORIGIN.
    //
    // The fix for that took the allowlist as a PARAMETER, which merely moved the
    // fail-open: `envVarName(secret, new Set([secret]))` type-checks and prints
    // the secret. A membership test is only as trustworthy as the set it tests
    // against, so the set must come from the schema, not from an argument.
    const params = ctor.getParameters();
    if (params.length !== 1) {
      failures.push(
        `${EVENTS_FILE}: envVarName takes ${params.length} parameters; expected exactly 1 — ` +
          `a caller-supplied allowlist lets the constrained code choose its own trust anchor`,
      );
    }

    // The happy path must carry no cast.
    //
    // Presence checks kept missing dataflow: a `.has(` anywhere plus a manual
    // `raw as EnvVarName` satisfied every earlier version of this gate while
    // `declared().has("DATABASE_URL") ? (raw as EnvVarName) : …` branded any
    // input. The fix is not a smarter search — it is `isDeclared(raw): raw is
    // EnvVarName`, which makes the compiler narrow the ARGUMENT so `return raw`
    // needs no cast. All this gate has to do now is forbid the cast coming back.
    const rebrands = ctor
      .getDescendantsOfKind(SyntaxKind.AsExpression)
      .filter((a) => a.getTypeNode()?.getText() === "EnvVarName");
    if (rebrands.length > 0) {
      failures.push(
        `${EVENTS_FILE}:${rebrands[0].getStartLineNumber()}: envVarName casts to EnvVarName — ` +
          `the brand must come from narrowing via the \`raw is EnvVarName\` predicate, since a ` +
          `cast does not care which value was checked`,
      );
    }

    // …and the returned value must be SELECTED FROM the declared list.
    //
    // This replaced a type predicate. The predicate made the CALL SITE
    // compiler-checked, but `raw is EnvVarName` is an assertion TypeScript
    // trusts rather than verifies, so the predicate body was still an
    // unverified claim: `{ declared().has(raw); return true; }` type-checked and
    // branded everything. Pinning the predicate's body would have been the fifth
    // round of teaching this gate to recognize one more way of writing a check.
    //
    // Selecting from a list has no check to fake: `find`/`get` return an element
    // of the collection, so the result is a schema key by construction and the
    // input is only ever compared. A wrong comparison yields the wrong NAME, not
    // a secret.
    const returns = ctor.getDescendantsOfKind(SyntaxKind.ReturnStatement);
    if (returns.length !== 1) {
      failures.push(
        `${EVENTS_FILE}: envVarName has ${returns.length} return statements; expected 1`,
      );
    }
    const selectsFromList = (returns[0]?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? [])
      .some((c) => {
        const callee = c.getExpression();
        if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
        if (!["find", "get"].includes(callee.getName())) return false;
        return callee.getExpression().getText() === "DECLARED";
      });
    if (!selectsFromList) {
      failures.push(
        `${EVENTS_FILE}: envVarName does not return a value selected from \`DECLARED\` ` +
          `(via .find/.get) — returning anything derived from the input puts the guarantee ` +
          `back on a check being correct`,
      );
    }
    // The set must be BUILT FROM the schema accessor, verified structurally.
    //
    // Two weaker versions of this check were tried and both were defeated. A
    // substring search for `getSchemaShape` matched a local
    // `getSchemaShapeStub`. Checking only that the import EXISTS is defeated by
    // leaving the import in place while `declared()` builds a different set —
    // the import goes unused-ish and nothing notices. So resolve the imported
    // binding (alias included) and require it to be the thing `Object.keys` is
    // called on inside `declared()`.
    const schemaAccessors = new Set();
    for (const d of events.getImportDeclarations()) {
      if (d.getModuleSpecifierValue() !== "@/lib/env-schema") continue;
      for (const n of d.getNamedImports()) {
        if (["getSchemaShape", "envObject"].includes(n.getName())) {
          schemaAccessors.add((n.getAliasNode() ?? n.getNameNode()).getText());
        }
      }
    }

    if (schemaAccessors.size === 0) {
      failures.push(
        `${EVENTS_FILE}: the declared-name set is not derived from \`@/lib/env-schema\` — ` +
          `membership must be checked against names the schema itself declares`,
      );
    } else {
      // The list itself must BE the schema's key list.
      //
      // Everything above rests on `DECLARED` holding schema keys and nothing
      // else, so this is the one initializer that matters. Checked as a whole
      // expression: an earlier version accepted `Object.keys(getSchemaShape())`
      // appearing anywhere in a function, which let the call be evaluated and
      // discarded while a hand-written list was returned.
      const listDecl = events.getVariableDeclaration("DECLARED");
      if (!listDecl) {
        failures.push(`${EVENTS_FILE}: no \`DECLARED\` list of schema-derived names`);
      } else {
        let init = listDecl.getInitializer();
        // Unwrap `… as readonly EnvVarName[]`.
        while (init && init.getKind() === SyntaxKind.AsExpression) {
          init = init.getExpression();
        }
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
            `${EVENTS_FILE}:${listDecl.getStartLineNumber()}: DECLARED is not ` +
              `\`Object.keys(<schema accessor>())\` — it is \`${listDecl.getInitializer()?.getText().slice(0, 60) ?? "<none>"}\`. ` +
              `Every name this module can emit comes from here, so it must come from the schema.`,
          );
        }
      }
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

/** The member names actually declared on the BOOT_EVENT const object. */
function bootEventMembers(sf) {
  const names = new Set();
  const decl = sf.getVariableDeclaration("BOOT_EVENT");
  const init = decl?.getInitializer();
  const obj =
    init?.getKind() === SyntaxKind.AsExpression ? init.getExpression() : init;
  for (const prop of obj?.getDescendantsOfKind(SyntaxKind.PropertyAssignment) ?? []) {
    names.add(prop.getName());
  }
  return names;
}

function isAllowedPropertyType(sf, node, closedNames, propName, eventMembers) {
  if (!node) return false;
  const kind = node.getKind();
  const text = node.getText();

  if (ALLOWED_PRIMITIVES.has(text)) return true;

  // `typeof BOOT_EVENT.ENV_VALIDATION_FAILED` — the discriminant, and ONLY that.
  //
  // This branch previously returned true for every TypeQuery, which is any
  // `typeof <expr>` at all. `detail: typeof process.env.AUTH_SECRET` is a
  // TypeQuery, resolves to `string | undefined`, and passed — so a caller could
  // hand the sink a secret and render would print it, through every gate. The
  // branch exists for one shape; it now admits only that shape, and only on the
  // property it exists for.
  if (kind === SyntaxKind.TypeQuery) {
    if (propName !== "event") return false;
    const m = /^typeof\s+BOOT_EVENT\.([A-Za-z0-9_]+)$/.exec(text);
    return m !== null && eventMembers.has(m[1]);
  }

  // A literal union written inline.
  if (kind === SyntaxKind.LiteralType) return true;
  if (
    kind === SyntaxKind.UnionType &&
    node
      .getTypeNodes()
      .every((n) => isAllowedPropertyType(sf, n, closedNames, propName, eventMembers))
  ) {
    return true;
  }
  // `readonly X[]` / `X[]`.
  if (kind === SyntaxKind.ArrayType) {
    return isAllowedPropertyType(
      sf,
      node.getElementTypeNode(),
      closedNames,
      propName,
      eventMembers,
    );
  }
  if (node.getKind() === SyntaxKind.TypeOperator) {
    const inner = node.getTypeNode?.();
    return inner
      ? isAllowedPropertyType(sf, inner, closedNames, propName, eventMembers)
      : false;
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
    const eventMembers = bootEventMembers(events);
    if (eventMembers.size === 0) {
      failures.push(`${EVENTS_FILE}: BOOT_EVENT declares no members — cannot verify discriminants`);
    }
    const node = diagnostic.getTypeNode();
    const members =
      node?.getKind() === SyntaxKind.UnionType ? node.getTypeNodes() : node ? [node] : [];
    if (members.length === 0) {
      failures.push(`${EVENTS_FILE}: BootDiagnostic has no members`);
    }

    // Resolve a member to the node whose properties should be checked.
    //
    // Walking `getDescendantsOfKind(PropertySignature)` on the written node was
    // vacuous for every member that is not an inline type literal: extracting a
    // member to `type StaleKey = { …; detail: string }` yields zero descendants,
    // so the loop ran zero times and the gate printed OK. That is the most
    // likely future edit here (someone tidies a growing union), and it disabled
    // the check wholesale. Anything not reducible to a checkable literal is now
    // a failure rather than an empty iteration.
    function checkMember(member, depth = 0) {
      const kind = member.getKind();
      if (depth > 4) {
        failures.push(`${EVENTS_FILE}: BootDiagnostic member nests too deeply to verify`);
        return;
      }
      if (kind === SyntaxKind.IntersectionType || kind === SyntaxKind.UnionType) {
        for (const part of member.getTypeNodes()) checkMember(part, depth + 1);
        return;
      }
      if (kind === SyntaxKind.ParenthesizedType) {
        const inner = member.getTypeNode?.();
        if (inner) checkMember(inner, depth + 1);
        return;
      }
      if (kind === SyntaxKind.TypeReference) {
        const name = member.getText();
        const alias = events.getTypeAlias(name);
        const iface = events.getInterface?.(name);
        const target = alias?.getTypeNode() ?? iface;
        if (!target) {
          failures.push(
            `${EVENTS_FILE}: BootDiagnostic member \`${name}\` cannot be resolved in this file — ` +
              `a member the gate cannot read is a member it cannot check`,
          );
          return;
        }
        checkMember(target, depth + 1);
        return;
      }
      if (kind !== SyntaxKind.TypeLiteral && kind !== SyntaxKind.InterfaceDeclaration) {
        failures.push(
          `${EVENTS_FILE}: BootDiagnostic member is a ${member.getKindName()}, which the gate ` +
            `cannot reduce to a property list`,
        );
        return;
      }

      // An index signature, a method, or a call signature can each carry a
      // free-form value without ever appearing as a PropertySignature.
      for (const bad of [
        SyntaxKind.IndexSignature,
        SyntaxKind.MethodSignature,
        SyntaxKind.CallSignature,
        SyntaxKind.MappedType,
      ]) {
        for (const node of member.getDescendantsOfKind(bad)) {
          failures.push(
            `${EVENTS_FILE}:${node.getStartLineNumber()}: BootDiagnostic member contains a ` +
              `${node.getKindName()} — only explicit properties with closed types are allowed`,
          );
        }
      }

      const props = member.getDescendantsOfKind(SyntaxKind.PropertySignature);
      if (props.length === 0) {
        failures.push(
          `${EVENTS_FILE}:${member.getStartLineNumber()}: BootDiagnostic member declares no ` +
            `properties — every member must at least carry its \`event\` discriminant`,
        );
      }
      for (const prop of props) {
        const propType = prop.getTypeNode();
        if (
          !isAllowedPropertyType(events, propType, closedNames, prop.getName(), eventMembers)
        ) {
          failures.push(
            `${EVENTS_FILE}:${prop.getStartLineNumber()}: property \`${prop.getName()}\` is typed ` +
              `\`${propType?.getText() ?? "<inferred>"}\`, which is not a closed shape — ` +
              `a raw console write must not accept free-form values`,
          );
        }
      }
    }

    for (const member of members) checkMember(member);
  }
}

// ── the sink renders from the diagnostic and nothing else ────────────
//
// Rendering moved into the sink, which created a prose-assembly site that no
// gate read. `check-console-sinks` pins the console ARGUMENT; this pins what
// render may reach for. Proven necessary: a render body returning
// `${process.env.AUTH_SECRET}` passed every gate, in the one file where
// `no-console` is off.
if (sink) {
  const render = sink.getFunction("render");
  if (!render) {
    failures.push(`${SINK_FILE}: no \`render\` function — did the sink's rendering move?`);
  } else {
    const body = render.getBody();
    if (body && /\bprocess\b/.test(body.getText())) {
      failures.push(
        `${SINK_FILE}:${render.getStartLineNumber()}: render() reads \`process\` — the sink must ` +
          `build its text only from the diagnostic it was handed`,
      );
    }
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
console.log("check-boot-diagnostic-shape: OK (BootDiagnostic closed; envVarName validated)");
