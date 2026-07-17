#!/usr/bin/env node
/**
 * CI guard: the destructive-wrapper set in route-class-patterns.json#deleteSignal
 * must be code-derived, not hand-curated (plan: security-control-verification, C4).
 *
 * Background: deleteSignal mixes raw Prisma primitives (passwordEntry.delete,
 * team.delete, ...) with hand-added wrapper function names (executeVaultReset,
 * deleteTeamPassword). Nothing enforced that a NEW wrapper introduced elsewhere
 * in the codebase gets added to deleteSignal — a service function wrapping
 * passwordEntry.deleteMany() that check-permanent-delete-stepup.sh does not
 * know about would let a route call it and evade step-up classification
 * entirely. This check derives the wrapper set from code instead.
 *
 * Scan scope: ALL production `src/**\/*.ts` EXCLUDING `route.ts` (the route
 * itself is governed directly by check-permanent-delete-stepup.sh) and test
 * files (`*.test.*`, `__tests__`). Widened to all of src/ (not just src/lib +
 * src/workers) so a wrapper defined in e.g. src/app/api/x/helpers.ts cannot
 * evade derivation.
 *
 * Raw destructive-delete primitives (subset of deleteSignal minus wrapper
 * names): passwordEntry.delete(Many)?(, teamPasswordEntry.delete(Many)?(,
 * team.delete(, user.delete(. The parent-cascade rationale for team.delete /
 * user.delete is documented in route-class-patterns.json's
 * $deleteSignal-parent-cascades key (derived from prisma/schema.prisma
 * onDelete: Cascade relations; tenant.delete is excluded — Restrict).
 *
 * For each hit, resolve the enclosing EXPORTED function via ts-morph (no
 * Program — same no-type-resolution precedent as
 * src/__tests__/proxy/ast-guards.ts / scripts/check-state-mutation-centralization.ts).
 * Pass criteria per resolved function:
 *   (a) its name is matched by deleteSignal (any route calling it already
 *       classifies as destructive), OR
 *   (b) it is listed in destructive-wrapper-exempt.txt as `path#functionName`
 *       (exact match) with a reason.
 * Fail: UNDECLARED_DESTRUCTIVE_WRAPPER: <file>#<function>
 *
 * Wrapper forms and grep-matchability: the route-side classifier
 * (check-permanent-delete-stepup.sh) is a FLAT-TEXT grep of deleteSignal over
 * route.ts files, so a deleteSignal alternative only classifies a route when its
 * literal string appears in the route's call token. The resolver therefore
 * distinguishes forms whose route call token a grep CAN match (top-level
 * function `fn(`, exported object-literal method `obj.method(`, STATIC class
 * method `Class.method(`) from forms it CANNOT (a class INSTANCE method — route
 * calls `<var>.method(`, not `Class.method(`; and an anonymous default export —
 * imported under an arbitrary name). Registering the derived key of a
 * non-grep-matchable wrapper in deleteSignal is a false-green, so those are
 * failed as NON_GREP_MATCHABLE_DESTRUCTIVE_WRAPPER and must be refactored to a
 * grep-matchable form or exempted.
 *
 * ROUTE PASS (AST alias-close): the flat-text deleteSignal grep in
 * check-permanent-delete-stepup.sh cannot follow an ALIAS import
 * (`import { executeVaultReset as reset }` then `reset(`) or a NAMESPACE import
 * (`import * as svc` then `svc.deleteTeamPassword(` — a shape the real
 * team-password route uses). This check adds a second AST pass over route.ts:
 * it resolves each route's local import bindings (named, aliased, and
 * namespace) against the derived destructive-export set, plus detects raw
 * primitives called directly, and requires that any route reaching a
 * destructive primitive/wrapper calls requireRecentCurrentAuthMethod( or is
 * listed in stepup-delete-exempt.txt — else ROUTE_DESTRUCTIVE_NO_STEPUP. This
 * closes the alias/namespace evasion the grep misses.
 *
 * The route pass resolves: bare imports (`import { fn }` → `fn(`), aliases
 * (`import { fn as g }` → `g(`), object/static aliases (`vault.method(`),
 * one-level namespace (`ns.fn(`), and two-level namespace (`ns.obj.method(`).
 * Default exports (named OR anonymous) are rejected at the derivation stage
 * (NON_GREP_MATCHABLE) since a default import renames freely.
 *
 * RESIDUAL LIMITATION (documented, not silently ignored — no occurrences in the
 * repo today, verified by grep): the route pass resolves imports one hop. It
 * does NOT follow a RE-EXPORT chain (`export { executeVaultReset } from
 * "./reset"` re-exported by a barrel the route then imports from) nor an
 * INDIRECT binding (assigning the imported function to a local variable, or
 * passing it through a higher-order call). Closing these would require whole-
 * program symbol resolution (a ts-morph Program with type-checking), which this
 * repo's AST guards deliberately avoid for speed/simplicity. The compensating
 * control is code review of route imports plus the barrel-free convention; if a
 * re-export chain of a destructive wrapper is ever introduced, add the barrel
 * module to the scan or register the wrapper at the barrel. The pass narrows the
 * gap to "only a re-export chain or an indirect binding evades".
 *
 * Inverse: every identifier-like alternative in deleteSignal that is NOT one
 * of the raw Prisma primitives above (i.e. executeVaultReset, deleteTeamPassword
 * today) must resolve to an existing exported function somewhere in scope —
 * otherwise STALE_DELETE_SIGNAL_NAME: <name> (the wrapper was renamed/removed
 * but deleteSignal still names the old identifier, silently narrowing the
 * step-up guard's coverage).
 *
 * Stale exempt: an exempt `path#function` entry that no longer resolves to an
 * existing exported function → STALE_WRAPPER_EXEMPT: <entry>.
 *
 * Env overrides (mirrors STEPUP_GUARD_* / RAW_SQL_CHECK_* conventions):
 *   DESTRUCTIVE_WRAPPER_SCAN_ROOT     — default: <repo>/src
 *   DESTRUCTIVE_WRAPPER_PATH_ROOT     — default: <repo> (repo-relative key prefix)
 *   DESTRUCTIVE_WRAPPER_EXEMPT_FILE   — default: <repo>/scripts/checks/destructive-wrapper-exempt.txt
 *   DESTRUCTIVE_WRAPPER_PATTERNS_FILE — default: <repo>/scripts/checks/route-class-patterns.json
 *     (STEPUP_GUARD_PATTERNS_FILE precedent — needed so a self-test fixture
 *     tree can supply its own deleteSignal without the real repo's
 *     executeVaultReset/deleteTeamPassword wrapper names forcing
 *     STALE_DELETE_SIGNAL_NAME on every isolated fixture run.)
 *
 * sec-F6 env-pollution guard: when CI=true and any override is set, require
 * DESTRUCTIVE_WRAPPER_FIXTURE_MODE=1 or exit 1.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Project, Node, SyntaxKind } from "ts-morph";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return REPO_ROOT;
  }
}

const ROOT = repoRoot();
const SCAN_ROOT = process.env.DESTRUCTIVE_WRAPPER_SCAN_ROOT ?? join(ROOT, "src");
const EXEMPT_FILE =
  process.env.DESTRUCTIVE_WRAPPER_EXEMPT_FILE ??
  join(ROOT, "scripts/checks/destructive-wrapper-exempt.txt");
// PATH_ROOT: keys (file#function) are reported/matched relative to this root,
// NOT SCAN_ROOT — mirrors check-permanent-delete-stepup.sh's PATH_ROOT vs
// API_DIR split, so a fixture SCAN_ROOT (e.g. <tmp>/src) still produces
// repo-relative keys like "src/lib/x.ts#fn" matching the exempt file's
// real-repo path convention. Defaults to ROOT so production keys are exactly
// "src/...".
const PATH_ROOT = process.env.DESTRUCTIVE_WRAPPER_PATH_ROOT ?? ROOT;
const PATTERNS_FILE =
  process.env.DESTRUCTIVE_WRAPPER_PATTERNS_FILE ??
  join(ROOT, "scripts/checks/route-class-patterns.json");
// Route pass (AST-precise alias-close): scan route.ts under this dir, resolve
// each route's local imports/aliases to the destructive-wrapper export set, and
// require step-up (or a stepup-delete-exempt.txt entry). Mirrors
// check-permanent-delete-stepup.sh's STEPUP_GUARD_* envs so the two share the
// same fixture surface and exempt allowlist.
const API_DIR = process.env.STEPUP_GUARD_API_DIR ?? join(ROOT, "src/app/api");
const STEPUP_EXEMPT_FILE =
  process.env.STEPUP_GUARD_EXEMPT_FILE ??
  join(ROOT, "scripts/checks/stepup-delete-exempt.txt");
const STEPUP_CALL_RE = /(^|[^A-Za-z0-9_])requireRecentCurrentAuthMethod\(/;

// CI-auditable: print effective paths on one line.
console.log(
  `check-destructive-wrapper-derivation: SCAN_ROOT=${SCAN_ROOT} EXEMPT_FILE=${EXEMPT_FILE} PATH_ROOT=${PATH_ROOT} PATTERNS_FILE=${PATTERNS_FILE}`,
);

// sec-F6: env-pollution guard.
if (process.env.CI === "true") {
  const overridden =
    process.env.DESTRUCTIVE_WRAPPER_SCAN_ROOT !== undefined ||
    process.env.DESTRUCTIVE_WRAPPER_EXEMPT_FILE !== undefined ||
    process.env.DESTRUCTIVE_WRAPPER_PATH_ROOT !== undefined ||
    process.env.DESTRUCTIVE_WRAPPER_PATTERNS_FILE !== undefined ||
    // The route pass reads these; redirecting them at an empty dir would false-
    // green the ROUTE_DESTRUCTIVE_NO_STEPUP check just as a scan-root override
    // would false-green the wrapper derivation.
    process.env.STEPUP_GUARD_API_DIR !== undefined ||
    process.env.STEPUP_GUARD_EXEMPT_FILE !== undefined;
  if (overridden && process.env.DESTRUCTIVE_WRAPPER_FIXTURE_MODE !== "1") {
    console.error(
      "ENV_POLLUTION_GUARD: a DESTRUCTIVE_WRAPPER_* or STEPUP_GUARD_* override is set under CI=true without DESTRUCTIVE_WRAPPER_FIXTURE_MODE=1 — refusing to run against a possibly-unintended path.",
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Shared pattern source (route-class-patterns.json) — same fail-closed
// non-empty-string assertion as check-raw-sql-usage.mjs.
// ---------------------------------------------------------------------------
const patterns = JSON.parse(readFileSync(PATTERNS_FILE, "utf8"));
if (typeof patterns.deleteSignal !== "string" || patterns.deleteSignal.length === 0) {
  console.error(
    `PATTERNS_FILE_INVALID: "deleteSignal" in ${PATTERNS_FILE} is missing or not a non-empty string.`,
  );
  process.exit(1);
}
const DELETE_SIGNAL_RE = new RegExp(patterns.deleteSignal);

// Raw Prisma/primitive alternatives within deleteSignal (the ones this check
// scans FOR), expressed as { receiver, methods } pairs: a call site matches
// iff its property-access base resolves to exactly `receiver` (e.g.
// `tx.passwordEntry`, `prisma.team`) and the called method is one of
// `methods`. Any deleteSignal alternative NOT represented here is a "wrapper
// name" subject to the inverse STALE_DELETE_SIGNAL_NAME check.
//
// Matching on the exact AST receiver property name (not text/endsWith
// heuristics) means the `[^A-Za-z0-9_]` boundary used in the grep-based
// deleteSignal regex (needed there to avoid a flat-text match on
// `teamMember.delete(`/`teamFolder.delete(`) is unnecessary here — an AST
// PropertyAccessExpression's name is exact, not a substring.
const RAW_PRIMITIVES = [
  { receiver: "passwordEntry", methods: ["delete", "deleteMany"] },
  { receiver: "teamPasswordEntry", methods: ["delete", "deleteMany"] },
  { receiver: "team", methods: ["delete"] },
  { receiver: "user", methods: ["delete"] },
];
// Coarse pre-filter regex (cheap `String.includes`-shaped scan) so files with
// no chance of a match skip the expensive ts-morph parse entirely. Kept
// permissive (no boundary/prefix requirements) — the AST check above is the
// source of truth for the actual match.
const SCAN_RE = new RegExp(
  RAW_PRIMITIVES.flatMap((p) => p.methods.map((m) => `${p.receiver}\\.${m}\\(`)).join("|"),
);

// Wrapper names named literally in deleteSignal: an alternative shaped as a
// bare call `<functionName>(` — no `.` property access, no `[^...]` boundary
// prefix — is a hand-added wrapper name, not one of the raw
// receiver.method(...) primitives in RAW_PRIMITIVES (all of which contain a
// literal `.`). Any alternative NOT matching this bare-call shape (i.e. every
// primitive alternative) is intentionally skipped here.
function extractDeleteSignalWrapperNames(deleteSignalSource) {
  const alternatives = deleteSignalSource.split("|");
  const names = [];
  for (const alt of alternatives) {
    // Bare wrapper: `deleteTeamPassword\(` -> "deleteTeamPassword".
    const bare = /^([A-Za-z0-9_]+)\\?\($/.exec(alt);
    if (bare) {
      names.push(bare[1]);
      continue;
    }
    // Qualified wrapper (object/class method): `vaultService\.purge\(` ->
    // "vaultService.purge". Matches the qualified key resolveEnclosingExported-
    // Function produces, so the inverse STALE check covers these too.
    const qualified = /^([A-Za-z0-9_]+)\\\.([A-Za-z0-9_]+)\\?\($/.exec(alt);
    if (qualified) names.push(`${qualified[1]}.${qualified[2]}`);
  }
  return names;
}
const WRAPPER_NAMES_IN_DELETE_SIGNAL = extractDeleteSignalWrapperNames(patterns.deleteSignal);

// ---------------------------------------------------------------------------
// Exempt file parsing — `path#functionName  # reason`. The key itself
// contains a literal `#` (path#function), so the REASON delimiter is
// specifically a `#` preceded by whitespace (a comment marker), not the
// first `#` on the line. Full-line comments (`#` as the first non-blank
// char) are skipped, mirroring check-permanent-delete-stepup.sh's exempt
// parser (MIN reason length 10).
// ---------------------------------------------------------------------------
const MIN_REASON_LENGTH = 10;
const REASON_DELIM_RE = /\s#(.*)$/;

function parseExemptFile(text) {
  const entries = []; // { key, reason, lineNo }
  const parseFailures = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;

    const reasonMatch = REASON_DELIM_RE.exec(raw);
    const key = (reasonMatch ? raw.slice(0, reasonMatch.index) : raw).trim();
    if (!key) continue;
    const reason = reasonMatch ? reasonMatch[1].trim() : "";
    if (reason.length < MIN_REASON_LENGTH) {
      parseFailures.push(`EXEMPT_NO_REASON: ${key} (line ${i + 1}) has no (or too short) reason.`);
    }
    entries.push({ key, reason, lineNo: i + 1 });
  }
  return { entries, parseFailures };
}

let exemptText = "";
if (existsSync(EXEMPT_FILE)) {
  exemptText = readFileSync(EXEMPT_FILE, "utf8");
}
const { entries: exemptEntries, parseFailures: exemptParseFailures } = parseExemptFile(exemptText);
const exemptKeys = new Set(exemptEntries.map((e) => e.key));

let failed = false;

if (exemptParseFailures.length > 0) {
  failed = true;
  console.error("destructive-wrapper-exempt.txt parse errors:");
  for (const f of exemptParseFailures) console.error(`  ${f}`);
}

// ---------------------------------------------------------------------------
// File discovery — production src/**/*.ts, excluding route.ts and tests.
// ---------------------------------------------------------------------------
const EXCLUDE_RE = /\.test\.|__tests__/;

function getSourceFiles(root, pathRoot) {
  const files = [];
  let dirEntries;
  try {
    dirEntries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return files;
    throw err;
  }
  for (const entry of dirEntries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (ext !== ".ts") continue; // .tsx routes/components are not delete-primitive sites in this codebase
    if (entry.name === "route.ts") continue;
    const abs = join(entry.parentPath ?? entry.path, entry.name);
    // rel is PATH_ROOT-relative (repo-relative in production), not
    // SCAN_ROOT-relative — see PATH_ROOT comment above.
    const rel = abs.slice(pathRoot.length).replace(/^\/+/, "");
    if (EXCLUDE_RE.test(rel)) continue;
    files.push({ abs, rel });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

const sourceFiles = getSourceFiles(SCAN_ROOT, PATH_ROOT);

// ---------------------------------------------------------------------------
// ts-morph — resolve the enclosing EXPORTED function for a given source
// offset. No Program / type resolution needed (matches ast-guards.ts
// precedent): walk ancestors looking for a node that is itself an exported
// function-like declaration (FunctionDeclaration, or a VariableStatement
// `export const f = (...) => {}` / `export const f = async function () {}`).
// A delete call nested inside an object-literal method (e.g. an Auth.js
// adapter callback) resolves to the enclosing EXPORTED function that
// contains it, not the inner method itself (methods aren't independently
// exported/callable).
// ---------------------------------------------------------------------------
const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });

function isExportedFunctionDeclaration(node) {
  return Node.isFunctionDeclaration(node) && node.isExported() && node.getName() !== undefined;
}

function isExportedVariableWithFunctionInitializer(node) {
  if (!Node.isVariableDeclaration(node)) return false;
  const init = node.getInitializer();
  if (!init || !(Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return false;
  const stmt = node.getVariableStatement();
  return stmt !== undefined && stmt.isExported();
}

function exportedFunctionName(node) {
  if (isExportedFunctionDeclaration(node)) return node.getName();
  if (isExportedVariableWithFunctionInitializer(node)) return node.getName();
  return undefined;
}

/**
 * A wrapper can be an exported top-level function OR a method reachable through
 * an exported object/class. Crucially, the route-side classifier
 * (check-permanent-delete-stepup.sh) is a FLAT-TEXT grep of `deleteSignal` over
 * route.ts files — so a deleteSignal alternative only classifies a route when
 * that literal string appears in the route's call token. Whether the derived
 * key can be route-matched by grep therefore depends on the wrapper form:
 *
 *   FORM                         route call token        grep-matchable?
 *   ----                         ----------------        ---------------
 *   top-level function           `executeVaultReset(`    yes  (key `executeVaultReset`)
 *   exported object method       `vaultService.purge(`   yes  (key `vaultService.purge`)
 *   exported STATIC class method `VaultService.purge(`   yes  (key `VaultService.purge`)
 *   exported INSTANCE method     `svc.purge(`            NO   (receiver is a runtime var)
 *   anonymous default export     `<anyName>(`            NO   (default import renames freely)
 *
 * (Alias imports — `import { x as y }` — defeat the grep for ALL forms; this is
 * a pre-existing, documented limitation of every grep-based guard in the repo,
 * not specific to this check.)
 *
 * So the resolver returns BOTH the qualified key AND a `grepMatchable` flag. The
 * caller lets a grep-matchable wrapper be "declared" by adding its key to
 * deleteSignal, but a NON-grep-matchable wrapper (instance method / anonymous
 * default) can never be safely resolved that way — registering its key in
 * deleteSignal is a false-green — so the caller forces it to an explicit
 * exemption (or a refactor to a grep-matchable form) instead.
 */
function methodName(node) {
  // MethodDeclaration (class or object shorthand method) or a
  // PropertyAssignment whose initializer is an arrow/function expression
  // (object property arrow: `{ purge: async () => {} }`).
  if (Node.isMethodDeclaration(node)) {
    const name = node.getName();
    return name || undefined;
  }
  if (Node.isPropertyAssignment(node)) {
    const init = node.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      const name = node.getName();
      return name || undefined;
    }
  }
  return undefined;
}

/** For a class-method node, the enclosing exported class declaration (or undefined). */
function enclosingExportedClass(node) {
  let c = node;
  while (c) {
    if (Node.isClassDeclaration(c) && c.isExported()) return c;
    c = c.getParent();
  }
  return undefined;
}

/** True when a MethodDeclaration carries the `static` modifier. */
function isStaticMethod(methodNode) {
  return (
    Node.isMethodDeclaration(methodNode) &&
    typeof methodNode.isStatic === "function" &&
    methodNode.isStatic()
  );
}

/**
 * For an object-method / object-property-arrow node, the name of the exported
 * `const <name> = { ... }` variable the object literal is bound to (or
 * undefined if the object literal is not directly bound to an exported const).
 */
function enclosingExportedObjectVarName(node) {
  let c = node;
  while (c) {
    if (Node.isVariableDeclaration(c)) {
      const init = c.getInitializer();
      if (init && Node.isObjectLiteralExpression(init)) {
        const stmt = c.getVariableStatement();
        if (stmt && stmt.isExported()) return c.getName();
      }
      return undefined; // bound to a non-exported / non-object decl — not reachable
    }
    c = c.getParent();
  }
  return undefined;
}

/**
 * Walk up from `node` to the nearest ancestor that is an exported callable.
 * Returns `{ key, grepMatchable }` or `undefined` when not route-reachable.
 * `grepMatchable` = true when a route call to this wrapper produces a text
 * token that a `deleteSignal` grep over route.ts can match (see methodName's
 * table). Instance methods and anonymous default exports are route-reachable
 * but NOT grep-matchable, so they cannot be resolved by deleteSignal.
 */
function resolveEnclosingExportedFunction(node) {
  let current = node;
  while (current) {
    // 1. Default export — checked FIRST, before the named-function branch. A
    //    default export's route call token is ALWAYS the local import name
    //    (`import wipeVault from "..."` -> `wipeVault(`), NEVER the declared
    //    name, whether the default function is anonymous OR named
    //    (`export default async function purgeEverything() {}`). So no
    //    deleteSignal literal can match it → NOT grep-matchable. Checking this
    //    before exportedFunctionName is essential: a NAMED default function also
    //    satisfies exportedFunctionName, and letting that branch win first would
    //    misclassify it as grepMatchable=true (the false-green this ordering
    //    closes). The key keeps the declared name (for a readable
    //    <file>#<name> report) but grepMatchable is false regardless.
    if (
      (Node.isFunctionDeclaration(current) ||
        Node.isArrowFunction(current) ||
        Node.isFunctionExpression(current)) &&
      isDefaultExported(current)
    ) {
      const declName =
        Node.isFunctionDeclaration(current) && current.getName()
          ? current.getName()
          : "default";
      return { key: declName, grepMatchable: false };
    }

    // 2. Top-level (non-default) exported function / const-arrow → `fn(` in the
    //    route (grep-matchable, modulo the shared alias-import limitation the
    //    route pass compensates for).
    const fnName = exportedFunctionName(current);
    if (fnName !== undefined) return { key: fnName, grepMatchable: true };

    // 3. Class or object method reachable through an exported class/object.
    const mName = methodName(current);
    if (mName !== undefined) {
      const cls = enclosingExportedClass(current);
      if (cls !== undefined) {
        // Static method → route calls `ClassName.method(` (grep-matchable).
        // Instance method → route calls `<instanceVar>.method(` where the
        // receiver is a runtime variable, NOT the class name — a deleteSignal
        // `ClassName.method\(` alternative can never match it.
        return {
          key: `${cls.getName()}.${mName}`,
          grepMatchable: isStaticMethod(current),
        };
      }
      const objVar = enclosingExportedObjectVarName(current);
      if (objVar !== undefined) {
        // Object method → route calls `objVar.method(` (grep-matchable, modulo
        // the shared alias-import limitation).
        return { key: `${objVar}.${mName}`, grepMatchable: true };
      }
      // A method not reachable via an exported class/object is not
      // route-callable on its own — keep walking (it may sit inside an
      // exported outer function).
    }

    current = current.getParent();
  }
  return undefined;
}

/** True when `node` is (or is the initializer of) an `export default`. */
function isDefaultExported(node) {
  // `export default function () {}` — the FunctionDeclaration has the modifier.
  if (
    Node.isFunctionDeclaration(node) &&
    node.getModifiers?.().some((m) => m.getKind() === SyntaxKind.DefaultKeyword)
  ) {
    return true;
  }
  // `export default () => {}` / `export default function(){}` as an expression:
  // the immediate parent is an ExportAssignment.
  const parent = node.getParent();
  return parent !== undefined && Node.isExportAssignment(parent);
}

const undeclaredWrappers = []; // { file, fn }
const nonGrepMatchableWrappers = []; // { file, fn } — instance method / anon default
const resolvedWrapperKeys = new Set(); // "path#fn" for functions found matching deleteSignal by name

// Route-pass input (AST-precise alias-resolution — closes the grep's alias
// evasion vector). Maps a PATH_ROOT-relative module file to the set of its
// exported wrapper NAMES that are route-importable and destructive:
//   destructiveExportsByModule: "src/lib/vault/vault-reset.ts" -> { "executeVaultReset" }
// A route that `import { executeVaultReset as reset } from "@/lib/vault/vault-reset"`
// and calls `reset(` is then detected regardless of the local alias — the
// flat-text deleteSignal grep in check-permanent-delete-stepup.sh cannot.
const destructiveExportsByModule = new Map();
function recordDestructiveExport(moduleRel, exportName) {
  let set = destructiveExportsByModule.get(moduleRel);
  if (!set) {
    set = new Set();
    destructiveExportsByModule.set(moduleRel, set);
  }
  set.add(exportName);
}

for (const { abs, rel } of sourceFiles) {
  const content = readFileSync(abs, "utf8");
  if (!SCAN_RE.test(content)) continue;

  let sf;
  try {
    sf = project.createSourceFile(rel, content, { overwrite: true });
  } catch {
    continue; // unparseable file — not this check's concern
  }

  const callExprs = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  const seenFns = new Set();

  for (const call of callExprs) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const method = expr.getName(); // "delete" | "deleteMany" | ...

    // The receiver is the property/identifier immediately left of the method
    // (e.g. `tx.passwordEntry` -> "passwordEntry", `prisma.team` -> "team").
    // Using the AST's exact name (not text/endsWith) means `teamMember`,
    // `teamFolder`, `teamPasswordEntry` never collide with the bare `team`
    // receiver — no boundary-char heuristics needed (unlike the grep-based
    // deleteSignal regex, which needs `[^A-Za-z0-9_]` for exactly this
    // reason at the flat-text level).
    const receiverExpr = expr.getExpression();
    const receiverName = Node.isPropertyAccessExpression(receiverExpr)
      ? receiverExpr.getName()
      : Node.isIdentifier(receiverExpr)
        ? receiverExpr.getText()
        : undefined;
    if (receiverName === undefined) continue;

    const isPrimitiveCall = RAW_PRIMITIVES.some(
      (p) => p.receiver === receiverName && p.methods.includes(method),
    );
    if (!isPrimitiveCall) continue;

    const resolved = resolveEnclosingExportedFunction(call);
    if (resolved === undefined) continue; // not route-reachable — skip
    const { key: fnName, grepMatchable } = resolved;
    if (seenFns.has(fnName)) continue;
    seenFns.add(fnName);

    const key = `${rel}#${fnName}`;
    resolvedWrapperKeys.add(key);

    // An explicit exemption always wins (documents "not route-reachable" or a
    // compensating control such as worker-policy-manifest.json).
    if (exemptKeys.has(key)) continue;

    // deleteSignal-registration only DECLARES a wrapper when a route call to it
    // produces a token the route-side grep can match. For a NON-grep-matchable
    // wrapper (instance method / anonymous default) a deleteSignal alternative
    // is a false-green: the derived key would never appear in the route text.
    // Force such wrappers to a refactor (or an explicit exemption) instead.
    if (!grepMatchable) {
      nonGrepMatchableWrappers.push({ file: rel, fn: fnName });
      continue;
    }

    // Record the route-importable export for the AST route pass. `fnName` is
    // either a bare export (`executeVaultReset`) or a qualified `export.member`
    // (`vaultService.purge` / `VaultService.purgeAll` static). Store BOTH the
    // full key and its first segment (the imported symbol), so the route pass
    // can match a bare call, a `binding.method(`, and a two-level
    // `namespace.binding.method(`. This lets the pass resolve aliased/namespaced
    // imports of the wrapper the grep would miss.
    recordDestructiveExport(rel, fnName);

    const matchesDeleteSignalByName = DELETE_SIGNAL_RE.test(`${fnName}(`);
    if (matchesDeleteSignalByName) continue; // declared — routes calling it classify correctly

    undeclaredWrappers.push({ file: rel, fn: fnName });
  }
}

if (undeclaredWrappers.length > 0) {
  failed = true;
  console.error(
    "UNDECLARED_DESTRUCTIVE_WRAPPER: exported functions wrap a raw destructive-delete primitive but are neither matched by route-class-patterns.json#deleteSignal nor listed in destructive-wrapper-exempt.txt:",
  );
  for (const w of undeclaredWrappers) {
    console.error(`  UNDECLARED_DESTRUCTIVE_WRAPPER: ${w.file}#${w.fn}`);
  }
  console.error(
    "\nEither add the function name as a deleteSignal alternative in route-class-patterns.json" +
      " (so calling routes classify as destructive) OR add `<file>#<function>  # reason` to" +
      " scripts/checks/destructive-wrapper-exempt.txt.",
  );
}

if (nonGrepMatchableWrappers.length > 0) {
  failed = true;
  console.error(
    "NON_GREP_MATCHABLE_DESTRUCTIVE_WRAPPER: these wrap a raw destructive-delete primitive in a form whose route CALL TOKEN a deleteSignal grep cannot match — a class INSTANCE method (route calls `<var>.method(`, not `ClassName.method(`) or a default export, named OR anonymous (route imports it under any name via `import <anyName> from ...`). Registering their derived key in deleteSignal would be a false-green (the route-side classifier is a flat-text grep over route.ts):",
  );
  for (const w of nonGrepMatchableWrappers) {
    console.error(`  NON_GREP_MATCHABLE_DESTRUCTIVE_WRAPPER: ${w.file}#${w.fn}`);
  }
  console.error(
    "\nResolve by refactoring to a grep-matchable form — a top-level `export function`," +
      " an exported object-literal method (`export const svc = { method() {} }`), or a" +
      " `static` class method — so a route call produces a stable literal token; OR, if the" +
      " wrapper is genuinely NOT route-reachable, add `<file>#<function>  # reason` to" +
      " scripts/checks/destructive-wrapper-exempt.txt.",
  );
}

// ---------------------------------------------------------------------------
// Inverse: every wrapper name literally present in deleteSignal must resolve
// to an existing exported function somewhere in the scanned scope.
// ---------------------------------------------------------------------------
const resolvedNames = new Set([...resolvedWrapperKeys].map((k) => k.split("#")[1]));
const staleSignalNames = WRAPPER_NAMES_IN_DELETE_SIGNAL.filter((name) => !resolvedNames.has(name));
if (staleSignalNames.length > 0) {
  failed = true;
  console.error(
    "STALE_DELETE_SIGNAL_NAME: deleteSignal names a wrapper function that no longer resolves to any exported function calling a raw destructive-delete primitive in scope:",
  );
  for (const name of staleSignalNames) {
    console.error(`  STALE_DELETE_SIGNAL_NAME: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Stale exempt entries — path#function no longer resolves.
// ---------------------------------------------------------------------------
const staleExempt = exemptEntries.filter((e) => !resolvedWrapperKeys.has(e.key));
if (staleExempt.length > 0) {
  failed = true;
  console.error(
    "STALE_WRAPPER_EXEMPT: destructive-wrapper-exempt.txt lists an entry that no longer resolves to an exported function wrapping a raw destructive-delete primitive:",
  );
  for (const e of staleExempt) {
    console.error(`  STALE_WRAPPER_EXEMPT: ${e.key}`);
  }
}

// ---------------------------------------------------------------------------
// Route pass (AST-precise) — close the alias-import evasion the flat-text
// deleteSignal grep in check-permanent-delete-stepup.sh cannot see.
//
// For each route.ts: resolve its local import bindings (INCLUDING aliases:
// `import { executeVaultReset as reset }`) against the destructive-wrapper
// export set built above, plus detect direct raw-primitive calls and
// direct-name wrapper calls. A route that reaches a destructive primitive/
// wrapper MUST call requireRecentCurrentAuthMethod( or be listed in
// stepup-delete-exempt.txt — else ROUTE_DESTRUCTIVE_NO_STEPUP.
//
// This is AST defense-in-depth over the grep guard: the grep catches the
// literal-token cases fast; this pass catches the aliased ones the grep misses.
// ---------------------------------------------------------------------------

/** Parse stepup-delete-exempt.txt → Set of repo-relative route paths. */
function parseStepupExempt(text) {
  const paths = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // `path  # reason` — path is everything before a whitespace-preceded `#`.
    const hashIdx = line.search(/\s#/);
    const path = (hashIdx === -1 ? line : line.slice(0, hashIdx)).trim();
    if (path) paths.add(path);
  }
  return paths;
}

/** Map an import module specifier from a route to a PATH_ROOT-relative file. */
function resolveModuleToRel(spec) {
  // `@/lib/x` -> `src/lib/x.ts`. Only the `@/` alias + relative forms that land
  // inside src are resolvable without a tsconfig; anything else (bare package,
  // unresolvable relative) is not a local wrapper module and is skipped.
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}.ts`;
  return undefined; // relative imports between route files don't reach wrappers here
}

// Collect route files (src/app/api/**/route.ts).
function getRouteFiles(apiDir, pathRoot) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(apiDir, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== "route.ts") continue;
    const abs = join(entry.parentPath ?? entry.path, entry.name);
    const rel = abs.slice(pathRoot.length).replace(/^\/+/, "");
    out.push({ abs, rel });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const stepupExemptText = (() => {
  try {
    return readFileSync(STEPUP_EXEMPT_FILE, "utf8");
  } catch {
    return "";
  }
})();
const stepupExemptPaths = parseStepupExempt(stepupExemptText);

const routesReachingDestructiveNoStepup = []; // { file, via }

for (const { abs, rel } of getRouteFiles(API_DIR, PATH_ROOT)) {
  let content;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    continue;
  }

  let sf;
  try {
    sf = project.createSourceFile(`__route__/${rel}`, content, { overwrite: true });
  } catch {
    continue;
  }

  // Build local-binding -> wrapper description from this route's imports.
  // The module's destructive export set holds either a bare export name
  // (`executeVaultReset`) or a qualified `export.member` (`vaultService.purge`,
  // `VaultService.purgeAll` static). We index it two ways per module:
  //   bareExports:  Set of exports called directly     -> `binding(`
  //   memberExports: Map<exportBinding, Set<method>>   -> `binding.method(`
  // and then resolve the route's imports through them.
  //
  //   localWrapperCalls: Map<localName, "moduleRel#exportKey">  (bare fn, named/aliased)
  //   localMemberBindings: Map<localName, {moduleRel, methods:Set}> (object/class import, named/aliased)
  //   namespaceBindings: Map<localNs, {moduleRel, bareExports, memberExports}> (import * as ns)
  const localWrapperCalls = new Map();
  const localMemberBindings = new Map();
  const namespaceBindings = new Map();
  for (const imp of sf.getImportDeclarations()) {
    const moduleRel = resolveModuleToRel(imp.getModuleSpecifierValue());
    if (!moduleRel) continue;
    const exportSet = destructiveExportsByModule.get(moduleRel);
    if (!exportSet) continue;

    // Split the module's export keys into bare vs qualified(member).
    const bareExports = new Set();
    const memberExports = new Map(); // exportBinding -> Set<method>
    for (const k of exportSet) {
      const dot = k.indexOf(".");
      if (dot === -1) {
        bareExports.add(k);
      } else {
        const bind = k.slice(0, dot);
        const meth = k.slice(dot + 1);
        if (!memberExports.has(bind)) memberExports.set(bind, new Set());
        memberExports.get(bind).add(meth);
      }
    }

    const nsImport = imp.getNamespaceImport();
    if (nsImport) {
      namespaceBindings.set(nsImport.getText(), { moduleRel, bareExports, memberExports });
    }
    for (const named of imp.getNamedImports()) {
      const exportName = named.getName(); // the exported symbol
      const localName = named.getAliasNode()?.getText() ?? exportName; // alias or same
      if (bareExports.has(exportName)) {
        localWrapperCalls.set(localName, `${moduleRel}#${exportName}`);
      }
      if (memberExports.has(exportName)) {
        localMemberBindings.set(localName, {
          moduleRel,
          methods: memberExports.get(exportName),
        });
      }
    }
  }

  // Does the route reach a destructive primitive/wrapper?
  let reachedVia;
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();

    if (Node.isPropertyAccessExpression(callee)) {
      const m = callee.getName(); // final method: `.deleteMany` / `.purge` / ...
      const recv = callee.getExpression();
      // The immediate receiver name, and (for two-level) the outer namespace.
      const recvIsProp = Node.isPropertyAccessExpression(recv);
      const recvName = recvIsProp
        ? recv.getName()
        : Node.isIdentifier(recv)
          ? recv.getText()
          : undefined;
      const outerNs =
        recvIsProp && Node.isIdentifier(recv.getExpression())
          ? recv.getExpression().getText()
          : undefined;

      // (a) Direct raw primitive: `tx.passwordEntry.deleteMany(` etc.
      if (
        recvName !== undefined &&
        RAW_PRIMITIVES.some((p) => p.receiver === recvName && p.methods.includes(m))
      ) {
        reachedVia = `raw ${recvName}.${m}`;
        break;
      }
      // (c) Aliased object wrapper: `vault.purge(` where `vault` is a
      //     (possibly aliased) import of an exported OBJECT/STATIC-CLASS wrapper;
      //     match the specific destructive method, not any method.
      if (recvName !== undefined && localMemberBindings.has(recvName)) {
        const b = localMemberBindings.get(recvName);
        if (b.methods.has(m)) {
          reachedVia = `alias ${recvName}.${m}() -> ${b.moduleRel}#${recvName}.${m}`;
          break;
        }
      }
      // (d) Namespace, one level: `ns.deleteTeamPassword(` (bare export member).
      if (recvName !== undefined && !recvIsProp && namespaceBindings.has(recvName)) {
        const ns = namespaceBindings.get(recvName);
        if (ns.bareExports.has(m)) {
          reachedVia = `namespace ${recvName}.${m}() -> ${ns.moduleRel}#${m}`;
          break;
        }
      }
      // (e) Namespace, two levels: `ns.vaultService.purge(` (object/static member
      //     of a namespaced module). Resolve outer ns -> middle export -> method.
      if (outerNs !== undefined && namespaceBindings.has(outerNs)) {
        const ns = namespaceBindings.get(outerNs);
        const middle = recvName; // the object/class export name
        if (middle !== undefined && ns.memberExports.get(middle)?.has(m)) {
          reachedVia = `namespace ${outerNs}.${middle}.${m}() -> ${ns.moduleRel}#${middle}.${m}`;
          break;
        }
      }
    }

    // (b) Direct/aliased top-level wrapper call: `reset(` where `reset` is a
    //     (possibly aliased) import of a destructive top-level function wrapper.
    if (Node.isIdentifier(callee) && localWrapperCalls.has(callee.getText())) {
      reachedVia = `alias ${callee.getText()}() -> ${localWrapperCalls.get(callee.getText())}`;
      break;
    }
  }

  if (!reachedVia) continue;

  const hasStepup = STEPUP_CALL_RE.test(content);
  const isExempt = stepupExemptPaths.has(rel);
  if (!hasStepup && !isExempt) {
    routesReachingDestructiveNoStepup.push({ file: rel, via: reachedVia });
  }
}

if (routesReachingDestructiveNoStepup.length > 0) {
  failed = true;
  console.error(
    "ROUTE_DESTRUCTIVE_NO_STEPUP: these route.ts files reach an irreversible vault-data delete (via a raw primitive or an imported destructive wrapper — INCLUDING aliased imports the deleteSignal grep misses) but call neither requireRecentCurrentAuthMethod( nor appear in stepup-delete-exempt.txt:",
  );
  for (const r of routesReachingDestructiveNoStepup) {
    console.error(`  ROUTE_DESTRUCTIVE_NO_STEPUP: ${r.file}  (via ${r.via})`);
  }
  console.error(
    "\nAdd requireRecentCurrentAuthMethod( to the route, OR add its path + reason to" +
      " scripts/checks/stepup-delete-exempt.txt if a stronger ceremony applies.",
  );
}

if (failed) {
  process.exit(1);
}

console.log("check-destructive-wrapper-derivation: OK");
