#!/usr/bin/env node
/**
 * CI gate (AST, ts-morph, no Program): every user-bound bearer validator is
 * gated per use by `passkeyGateBlocks`, or refresh-bound with a stated
 * lifetime (I1), and only the three self-protection call sites skip the gate
 * (I3). Plan: docs/archive/review/api-key-passkey-requirement-plan.md, C7.
 *
 * Control class (R49): a best-effort DETECTION gate — a tripwire — not an
 * enforceable boundary. The enforcement is the per-use gate inside each
 * validator (passkeyGateBlocks), pinned by the validators' unit and
 * integration tests and by review; this gate catches the common spellings of
 * a new digest lookup and of a skipped gate, and the residuals below are
 * spellings it does not see. It is not a proof that no other lookup exists.
 *
 * What it adjudicates, by syntax alone: Prisma query-builder digest lookups,
 * by the shape of a call's argument; and raw SQL, by the text of its literals
 * (backed at run time by renderSql). It does not follow values across files or
 * through types.
 *
 *   - Digest fields: `tokenHash`, `codeHash`, and `replacedByHash` (the MCP
 *     refresh row's rotation successor); columns `token_hash`, `code_hash`,
 *     `replaced_by_hash`.
 *   - Token models: every model in prisma/schema.prisma declaring a digest
 *     field (read as source through lib/prisma-relation-reach.mjs — the
 *     static-checks job need not have a generated client). An empty set fails.
 *   - A digest lookup: ANY call — whatever its receiver (`Reflect.get(tx,
 *     "apiKey")`, `tx[k]`, a delegate passed as a parameter, `$parent`) —
 *     an argument of which holds a digest-field property (plain, shorthand,
 *     string-literal, escaped, or a computed key naming a string literal or a
 *     `const` bound to one) in a value this file can read under a filter
 *     position: the top-level `where` / `cursor` / `having`; the `where` of a
 *     relation under `include` / `select` / `_count.select`, recursively; and
 *     the nested writes under `data` (or an upsert's `create` / `update`):
 *     `connect`, `disconnect`, `set`, `delete`, `deleteMany`, and the `where`
 *     of `update`, `updateMany`, `upsert`, `connectOrCreate`. Readable is an
 *     object literal, a conditional of readable values, or a `const` bound to
 *     an object literal (followed, scope-aware); a filter's spread is never
 *     read. A `data: { tokenHash }` is a write, not a lookup.
 *   - Model coverage: every token model has an analysed lookup whose position
 *     resolves to it, or a manifest `models` entry with a reason; an entry for
 *     a model that has one is stale.
 *   - Refuse rather than guess, where the call's receiver resolves to a model
 *     (`x.<handle>`, `x["<handle>"]`, `x[k]` with `const k = "<handle>"`, the
 *     handle as a bare name, or a name destructured from it). "Opaque" is:
 *       * a `where` / `cursor` / relation filter on a token model that is not
 *         an object literal (a `const` bound to one is followed) or holds a
 *         spread, a computed key or an accessor — a spread in a filter is
 *         opaque by decision, even when its value could be read;
 *       * an argument, `select` / `include` (each relation's, recursively)
 *         or `data` (of a create / update / upsert, and their nested writes)
 *         on a token model or a model with a relation to one (one hop) that is
 *         not an object literal or holds a computed key, an accessor, or a
 *         spread whose value this file cannot read (`...(c ? {a} : {})`,
 *         `...(c && {a})` and a `const`-bound literal are read in place).
 *         createMany / updateMany `data` holds scalar columns only.
 *     A function with an opaque site needs an `opaque-where` manifest entry;
 *     its count pins the sites.
 *   - Receivers the model resolution cannot follow fail: a where-taking
 *     delegate method called on an element access whose key is not a literal
 *     or a `const`-bound one; and a token-model delegate (`x.<handle>`,
 *     `x["<handle>"]`, `x[k]`, or a destructured alias) referenced other than
 *     as the receiver of a direct call with a literal method name — a value
 *     reference, an argument, `x.<handle>["findUnique"](...)`, `.call` /
 *     `.apply`, `x.<handle>.fields` — or destructured into a nested pattern.
 *     `x.<handle>.<name>` for a name no delegate has is a row's relation
 *     field, not a delegate; `$extends` (which could add such names) fails
 *     anywhere.
 *   - Raw SQL: in ANY string, template (head, middle, tail) or regular
 *     expression literal of non-test src, as written or as cooked
 *     (`token\x5fhash`), the digest column names fail (any case), and so do
 *     `U&` / `UESCAPE` (a Unicode-escaped identifier, `U&"token\005fhash"`;
 *     no-space only: PostgreSQL reads the prefix only with the ampersand
 *     directly after the U).
 *     An Unsafe call's SQL argument must be a string literal, a
 *     no-substitution template, or `renderSql(trustedSql`...`)` with both
 *     names resolving, scope-aware, to imports from src/lib/prisma/raw-sql;
 *     `$queryRaw`/`$executeRaw` must be the tag of a template (whose
 *     substitutions are bound parameters, never text). Any other spelling of
 *     a raw method fails. The literal parts of a trustedSql template are
 *     scanned here; the identifiers and fragments spliced into it
 *     (`sqlIdentifier`, `joinSql`) exist only as rendered text, so renderSql
 *     throws at run time when that text names a digest column or holds a
 *     Unicode-escape form (src/lib/prisma/raw-sql.ts; code
 *     RAW_SQL_DIGEST_COLUMN / RAW_SQL_UNICODE_ESCAPE), and the retention-GC
 *     worker refuses a digest-column registry identifier at boot.
 *     check-raw-sql-usage refuses every other way to splice text through
 *     Prisma (Prisma.raw / Prisma.sql / Prisma.join).
 *
 * Residuals — spellings this gate does not see (Anti-Deferral entries: the
 * plan's deviation log, "Code review round 3 — residuals"):
 *   - A digest key inside a filter value this file cannot read — a spread
 *     (whatever its operand: `...(c && {k})`, `...(c ? {k} : {})`, a
 *     `const`-bound literal), a `&&` / `||` / `??` expression, a helper's
 *     return, or a computed key whose name is not a pinned string — in a filter
 *     whose model is unresolved (any receiver the model resolution does not
 *     follow, including a relation filter under such a call's top-level
 *     `where`) or is not a token model (including a relation filter to a model
 *     that is not one). There it is neither a lookup nor refused as opaque.
 *   - A delegate reached by a spelling the model resolution does not follow
 *     (`Reflect.get(tx, "apiKey")`, `Object.values(tx)`, a delegate a function
 *     returns, a parameter not named by its handle): its lookups are found only
 *     where the filter is readable (above), and its opaque positions are not
 *     refused.
 *   - An opaque value more than one relation hop from a token model (a `data`
 *     or projection on a model with no token relation that hides a nested
 *     write or filter through one that has).
 *   - Raw SQL whose text never names the column: a whole-row projection
 *     compared or searched as a value (`to_jsonb(t)`, `row_to_json(t)`,
 *     `t::text`, `t.*`), dynamic SQL built inside the statement (`EXECUTE
 *     format(...)` in a DO block or a function), and database objects defined
 *     outside src (a view, function or trigger in prisma/migrations).
 *   - Raw SQL through the pg driver (a `createPool` / `createClient` result's
 *     `.query(...)`): its SQL argument is not constrained, so a column name
 *     split across a concatenation (`"token_" + "hash"`) is not seen, and
 *     renderSql is not on that path. A literal naming the column is still
 *     refused by the literal rule above.
 *
 * Each lookup or opaque site is attributed to the nearest named function,
 * method, `const`-bound function, or exported `const`; the key is
 * `<repo path>#<name>`; a key that two functions of one file share fails as
 * AMBIGUOUS_KEY. Every key needs a manifest entry
 * (bearer-passkey-gate-manifest.json) with a class, a reason, and `calls` (the
 * number of calls in it that are a lookup or opaque, each counted once).
 * Unlisted key, stale entry, count mismatch, and zero analysed all fail.
 *
 *   - per-use-gated: adjudicated on the AST. The function's own body (nested
 *     blocks included, nested functions excluded) returns nothing but an
 *     `ok: false` object literal (no spread, no computed key, one non-shorthand
 *     `ok`) before exactly one `if`
 *     that is a direct statement of the body, whose condition is
 *     `await passkeyGateBlocks(...)` — the identifier resolving, scope-aware, to
 *     the named import from src/lib/auth/policy/passkey-gate (not shadowed) —
 *     with no `else` and a consequent returning an `ok: false` literal; or a
 *     no-`else` `if (!<param>.passkeyExemption)` / `!<param>?.passkeyExemption`
 *     on one of the function's own parameters whose only statement is that
 *     gate `if`. At least one return follows it.
 *   - refresh-bound: names `refreshRoute` (a file that exists), `lifetime`
 *     (`<path>#<name>`: an exported top-level const of that file), and at
 *     least one `inlineGate` (`<path>#<fn>` keys, each designating one
 *     function whose body, callbacks included, holds an `if` whose condition
 *     is exactly a call — optionally awaited, not negated, no conjunct — of
 *     passkeyEnforcementBlocks from src/lib/auth/policy/passkey-enforcement
 *     or passkeyGateBlocks from passkey-gate, resolved scope-aware, with no
 *     `else` and a consequent returning a refusal literal: `ok: false`, or no
 *     `ok` and an `error`, or no `ok` and a string `type` other than
 *     "success").
 *   - exempt: a reason.
 *   - opaque-where: a reason; the function must still have an opaque site.
 *
 * Exemption pin (I3): the (`<path>#<handler>`, member) pairs passing
 * `{ passkeyExemption: PASSKEY_EXEMPTION.<member> }` to validateExtensionToken
 * equal EXEMPTION_PIN exactly. Every reference to validateExtensionToken must
 * be a direct call whose second argument, if any, is that one-property inline
 * literal; refused: a value reference (incl. `.call`/`.apply`, shorthand,
 * `export { x }`), a named or `export *` re-export of the module, a namespace
 * or default import of it, a dynamic import / require / import-equals of it
 * outside itself, and a dynamic import whose specifier this gate cannot read.
 *
 * Forbidden reads: `requirePasskey` / `hasPasskey` read (property access,
 * element access, destructuring) in non-test src/lib/auth/tokens/**. Object
 * literal keys (a `select`) are not reads.
 *
 * Fixture-root override: BEARER_PASSKEY_GATE_ROOT relocates the scan root
 * (src/), the schema (prisma/schema.prisma) and the manifest together.
 */
import { SyntaxKind } from "ts-morph";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFiles } from "./lib/ast-project.mjs";
import { FILTERING, RELATION_FILTERS, SchemaReadError, WRITING, loadPrismaSchema, objectLiterals } from "./lib/prisma-relation-reach.mjs";
import { bindingIndex, unwrapExpression, visibleBinding } from "./lib/scope-bindings.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = process.env.BEARER_PASSKEY_GATE_ROOT || REPO_ROOT;
const SCAN_ROOT = "src";
const SCHEMA_PATH = "prisma/schema.prisma";
const MANIFEST_PATH = "scripts/checks/bearer-passkey-gate-manifest.json";

const TOKEN_DIR = "src/lib/auth/tokens/";
const GATE_MODULE = "src/lib/auth/policy/passkey-gate";
const GATE_FN = "passkeyGateBlocks";
const ENFORCEMENT_MODULE = "src/lib/auth/policy/passkey-enforcement";
const RAW_SQL_MODULE = "src/lib/prisma/raw-sql";
const EXT_MODULE = "src/lib/auth/tokens/extension-token";
const EXT_TYPES_MODULE = "src/lib/auth/tokens/extension-token-types";
const EXT_FN = "validateExtensionToken";
const EXEMPTION_CONST = "PASSKEY_EXEMPTION";
// Bearer-token digest fields: a token's own digest, and the rotation successor's digest an
// MCP refresh row records (a lookup by it finds a row from a presented token too).
const DIGEST_KEYS = new Set(["tokenHash", "codeHash", "replacedByHash"]);
const FORBIDDEN_READS = new Set(["requirePasskey", "hasPasskey"]);
// [module, export] pairs an inline gate's `if` condition may call.
const INLINE_GATES = [[ENFORCEMENT_MODULE, "passkeyEnforcementBlocks"], [GATE_MODULE, GATE_FN]];
const CLASSES = new Set(["per-use-gated", "refresh-bound", "exempt", "opaque-where"]);
const MIN_REASON = 20;

// I3: the only call sites allowed to skip the gate (plan C5). Pinned here, not
// in the manifest — adding a fourth is a contract change, not a data edit.
const EXEMPTION_PIN = [
  ["src/app/api/extension/token/route.ts#handleDELETE", "SELF_REVOCATION"],
  ["src/app/api/extension/key/reset/route.ts#handlePOST", "SELF_REVOCATION"],
  ["src/app/api/mobile/cache-rollback-report/route.ts#handlePOST", "TAMPER_REPORT"],
];

// Delegate methods that take a `where` (FILTERING minus the create family).
const WHERE_METHODS = new Set([...FILTERING].filter((m) => !m.startsWith("create")));
// Every method a model delegate has; with "fields", every member. A client extension could add
// more, so `$extends` is refused.
const DELEGATE_METHODS = new Set([...FILTERING, ...WRITING.keys()]);
const DELEGATE_MEMBERS = new Set([...DELEGATE_METHODS, "fields"]);
// Argument keys by position: filters (a digest under one is a lookup), projections, writes.
const FILTER_KEYS = new Set(["where", "cursor", "having"]);
const PROJECTION_KEYS = new Set(["select", "include"]);
const WRITE_KEYS = new Set(["data", "create", "update"]);
// Nested-write operations under a relation field in a `data`: those whose value is a filter
// on the related model, and those whose value is `{ where?, data / create / update }`.
const WRITE_FILTER_OPS = new Set(["connect", "disconnect", "set", "delete", "deleteMany"]);
const WRITE_ARG_OPS = new Set(["update", "updateMany", "upsert", "connectOrCreate"]);
// The writes whose `data` can hold nested writes. createMany / updateMany (and their
// AndReturn forms) take scalar columns only, so their `data` cannot hide a lookup.
const RELATION_WRITE_METHODS = new Set(["create", "update", "upsert"]);
const SCALAR_WRITE_OPS = new Set(["createMany", "updateMany"]);
// A RegExp, not a string literal: check-raw-sql-usage's PRISMA_EXTENDS (the repo-wide control)
// denies a "$extends" literal in scripts/ too.
const EXTENDS_RE = /^\$extends$/;
const RAW_METHOD = /^\$(query|execute)Raw(Unsafe)?$/;
const DIGEST_COLUMN = /token_hash|code_hash|replaced_by_hash/i;
// PostgreSQL's Unicode-escape forms (`U&"token\005fhash"`, `UESCAPE`) spell an identifier
// without its plain text; refused in any literal, like the column names.
const UNICODE_ESCAPE_SQL = /u&|uescape/i;
const LOGICAL = new Set(["AND", "OR", "NOT"]);
const FN_LIKE = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

const failures = [];
const failAt = (rel, node, message) => failures.push(`${rel}:${node.getStartLineNumber()}  ${message}`);

function fatal(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

console.log(`check-bearer-passkey-gate: ROOT=${ROOT}`);

// ─── Inputs ──────────────────────────────────────────────────

let schema;
try {
  schema = loadPrismaSchema(join(ROOT, SCHEMA_PATH));
} catch (e) {
  if (e instanceof SchemaReadError) fatal(e.message);
  throw e;
}
const { models: MODELS, handles: HANDLES } = schema;
const TOKEN_MODELS = new Set(
  [...MODELS].filter(([, fields]) => [...DIGEST_KEYS].some((k) => fields.has(k))).map(([m]) => m),
);
if (TOKEN_MODELS.size === 0) fatal(`${SCHEMA_PATH} declares no model with a ${[...DIGEST_KEYS].join("/")} field, so no lookup can be classified.`);
const TOKEN_HANDLES = new Set([...HANDLES].filter(([, m]) => TOKEN_MODELS.has(m)).map(([h]) => h));
// Token models and the models with a relation field to one: a projection or a write on one of
// these can name a token model's relation and put a filter on it. One hop, like the `where`
// rule's token-model scoping: what an unreadable value could reach through a further model is
// the same residual as a spread in that model's `where` (header).
const TOKEN_ADJACENT = new Set(
  [...MODELS].filter(([m, fields]) => TOKEN_MODELS.has(m) || [...fields.values()].some((f) => TOKEN_MODELS.has(f.type))).map(([m]) => m),
);

const manifestAbs = join(ROOT, MANIFEST_PATH);
if (!existsSync(manifestAbs)) fatal(`manifest not found at ${manifestAbs}.`);
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestAbs, "utf8"));
} catch (e) {
  fatal(`manifest at ${manifestAbs} is not valid JSON: ${e.message}`);
}
if (!manifest || typeof manifest.functions !== "object" || Array.isArray(manifest.functions)) {
  fatal(`manifest at ${manifestAbs} has no "functions" object.`);
}
const ENTRIES = new Map(Object.entries(manifest.functions));
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
if (manifest.models !== undefined && !isPlainObject(manifest.models)) fatal(`manifest at ${manifestAbs} has a "models" that is not an object.`);
const MODEL_ENTRIES = new Map(Object.entries(manifest.models ?? {}));

// ─── Helpers ─────────────────────────────────────────────────

/** Repo-relative module path a specifier names (extension and /index stripped), or null for a package. */
function resolveSpecifier(fromRel, spec) {
  let p;
  if (spec.startsWith("@/")) p = `src/${spec.slice(2)}`;
  else if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    p = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  } else return null;
  return p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "").replace(/\/index$/, "");
}

const moduleOf = (rel) => rel.replace(/\.(ts|tsx)$/, "").replace(/\/index$/, "");

/** Every import binding in the file. */
function importsOf(sf, rel) {
  const out = [];
  for (const decl of sf.getImportDeclarations()) {
    const from = resolveSpecifier(rel, decl.getModuleSpecifierValue());
    const typeOnly = decl.isTypeOnly();
    const ns = decl.getNamespaceImport();
    if (ns) out.push({ local: ns.getText(), imported: "*", from, typeOnly, node: decl });
    const def = decl.getDefaultImport();
    if (def) out.push({ local: def.getText(), imported: "default", from, typeOnly, node: decl });
    for (const s of decl.getNamedImports()) {
      out.push({
        local: s.getAliasNode()?.getText() ?? s.getName(),
        imported: s.getName(),
        from,
        typeOnly: typeOnly || s.isTypeOnly(),
        node: s,
      });
    }
  }
  return out;
}

/** Does `id` name, here, the value import `imported` from module `from` (no local binding shadows it)? */
function refersToImport(id, file, from, imported) {
  if (id.getKind() !== SyntaxKind.Identifier) return false;
  const name = id.getText();
  if (visibleBinding(name, id, file.bindingsFor)) return false;
  return file.imports.some((i) => i.local === name && i.from === from && i.imported === imported && !i.typeOnly);
}

function literalName(nameNode) {
  switch (nameNode.getKind()) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
      return nameNode.getText();
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.NumericLiteral:
      return nameNode.getLiteralText();
    default:
      return null; // computed
  }
}

const isStringish = (n) =>
  n && (n.getKind() === SyntaxKind.StringLiteral || n.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral);

/** The nearest function-like ancestor. */
function enclosingFunction(node) {
  for (let p = node.getParent(); p; p = p.getParent()) if (FN_LIKE.has(p.getKind())) return p;
  return null;
}

// hasExportKeyword, not isExported: the latter asks the type checker, which builds a
// Program and resolves every module. Measured over the real repo (1044 files): the whole
// gate takes ~5.2 s with hasExportKeyword, ~7.8 s with isExported here only, and ~36 s
// with isExported at every export test.
const isExportedVar = (decl) => decl.getVariableStatement?.()?.hasExportKeyword?.() ?? false;

/**
 * `{ name, fn, owner }`: nearest named function, method, const-bound function, or exported
 * const. `owner` is the declaration the name belongs to — two owners under one key are two
 * functions sharing a name; `fn` is the function a per-use predicate reads.
 */
function attribute(node) {
  let innermostFn = null;
  for (let p = node.getParent(); p; p = p.getParent()) {
    const k = p.getKind();
    if (FN_LIKE.has(k) && !innermostFn) innermostFn = p;
    if (k === SyntaxKind.FunctionDeclaration && p.getName()) return { name: p.getName(), fn: p, owner: p };
    if (k === SyntaxKind.MethodDeclaration || k === SyntaxKind.GetAccessor || k === SyntaxKind.SetAccessor) {
      const n = literalName(p.getNameNode());
      if (n) return { name: n, fn: p, owner: p };
    }
    if (k === SyntaxKind.FunctionExpression && p.getName()) return { name: p.getName(), fn: p, owner: p };
    if (k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression) {
      const parent = p.getParent();
      if (parent?.getKind() === SyntaxKind.VariableDeclaration && unwrapExpression(parent.getInitializer()) === p) {
        if (parent.getNameNode().getKind() === SyntaxKind.Identifier) return { name: parent.getName(), fn: p, owner: p };
      }
    }
    if (k === SyntaxKind.VariableDeclaration && isExportedVar(p) && p.getNameNode().getKind() === SyntaxKind.Identifier) {
      const init = unwrapExpression(p.getInitializer());
      return { name: p.getName(), fn: init && FN_LIKE.has(init.getKind()) ? init : innermostFn, owner: p };
    }
  }
  return null;
}

// ─── Digest lookups and opaque positions ─────────────────────

/** The property an object-binding element reads (`{ a }`, `{ a: b }`, `{ ["a"]: b }`), or null. */
function bindingKey(el) {
  const pn = el.getPropertyNameNode();
  if (!pn) return el.getNameNode().getKind() === SyntaxKind.Identifier ? el.getName() : null;
  if (pn.getKind() === SyntaxKind.ComputedPropertyName) {
    const e = unwrapExpression(pn.getExpression());
    return isStringish(e) ? e.getLiteralText() : null;
  }
  return literalName(pn);
}

/** The string a value names: a string literal, or a name a `const` binds to one (scope-aware). Null otherwise. */
function constString(node, file) {
  const v = unwrapExpression(node);
  if (isStringish(v)) return v.getLiteralText();
  if (v?.getKind() !== SyntaxKind.Identifier) return null;
  const d = visibleBinding(v.getText(), v, file.bindingsFor);
  if (d?.getKind() !== SyntaxKind.VariableDeclaration || d.getNameNode().getKind() !== SyntaxKind.Identifier) return null;
  if (d.getVariableStatement?.()?.getDeclarationKind() !== "const") return null;
  const init = unwrapExpression(d.getInitializer());
  return isStringish(init) ? init.getLiteralText() : null;
}

/** The model whose delegate `id` names when it is bound by destructuring a handle (`const { apiKey: k } = tx`). */
function destructuredModel(id, file) {
  const decl = visibleBinding(id.getText(), id, file.bindingsFor);
  const pattern = decl?.getNameNode?.();
  if (!pattern || pattern.getKind() === SyntaxKind.Identifier) return null;
  for (const el of pattern.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    if (el.getNameNode().getKind() !== SyntaxKind.Identifier || el.getName() !== id.getText()) continue;
    if (el.getParent().getKind() !== SyntaxKind.ObjectBindingPattern) return null;
    const key = bindingKey(el);
    return (key && HANDLES.get(key)) || null;
  }
  return null;
}

/**
 * The model a delegate call targets (`{ model }`), `{ unreadable: true }` for a where-taking
 * method on an element access whose key this file cannot read, or null. This decides only
 * which model's opacity rules apply; whether the call is a lookup does not depend on it.
 */
function delegateTarget(call, file) {
  const callee = unwrapExpression(call.getExpression());
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression || !DELEGATE_METHODS.has(callee.getName())) return null;
  const recv = unwrapExpression(callee.getExpression());
  let handle = null;
  if (recv.getKind() === SyntaxKind.PropertyAccessExpression) handle = recv.getName();
  else if (recv.getKind() === SyntaxKind.Identifier) {
    const aliased = destructuredModel(recv, file);
    if (aliased) return { model: aliased, method: callee.getName() };
    handle = recv.getText();
  } else if (recv.getKind() === SyntaxKind.ElementAccessExpression) {
    handle = constString(recv.getArgumentExpression(), file);
    if (handle === null && WHERE_METHODS.has(callee.getName())) return { unreadable: true };
  }
  const model = handle && HANDLES.get(handle);
  return model ? { model, method: callee.getName() } : null;
}

/**
 * Is this token-model delegate reference `<ref>.<method>(...)` with a literal method name?
 * `<ref>.<name>` for a name no delegate has (`row.apiKey.userId`) reads a row's relation
 * field, not a delegate, and is not a use of one.
 */
function isDirectDelegateUse(ref) {
  const parent = ref.getParent();
  if (parent?.getKind() !== SyntaxKind.PropertyAccessExpression || parent.getExpression() !== ref) return false;
  if (!DELEGATE_MEMBERS.has(parent.getName())) return true;
  const call = parent.getParent();
  return call?.getKind() === SyntaxKind.CallExpression && call.getExpression() === parent;
}

const isNullish = (n) => {
  const v = unwrapExpression(n);
  return v?.getKind() === SyntaxKind.NullKeyword || (v?.getKind() === SyntaxKind.Identifier && v.getText() === "undefined");
};
const isBooleanLiteral = (n) => {
  const k = unwrapExpression(n)?.getKind();
  return k === SyntaxKind.TrueKeyword || k === SyntaxKind.FalseKeyword;
};
const isArrayLiteral = (n) => unwrapExpression(n)?.getKind() === SyntaxKind.ArrayLiteralExpression;
const relationOf = (model, name) => {
  const field = model && MODELS.get(model)?.get(name);
  return field && MODELS.has(field.type) ? field : null;
};

/**
 * Properties of the literals a value can be, or null (unreadable). Computed keys, accessors and
 * spreads are reported — except, with `followSpreads`, a spread whose value this file can read
 * (`...(c ? { a } : {})`, `...(c && { a })`, a `const`-bound literal), which is read in place.
 * A filter never follows spreads: there a spread is opaque by decision (plan C7).
 */
function readProps(node, ctx, onOpaque, followSpreads = false) {
  const lits = objectLiterals(node, ctx);
  if (!lits) return null;
  return lits.flatMap((lit) => literalProps(lit, ctx, onOpaque, followSpreads));
}

function literalProps(lit, ctx, onOpaque, followSpreads) {
  const props = [];
  for (const prop of lit.getProperties()) {
    const k = prop.getKind();
    if (k === SyntaxKind.PropertyAssignment || k === SyntaxKind.ShorthandPropertyAssignment) {
      const nameNode = prop.getNameNode();
      // A computed key the file pins (`[k]` with `const k = "tokenHash"`, `["tokenHash"]`) is read.
      const name = nameNode.getKind() === SyntaxKind.ComputedPropertyName ? constString(nameNode.getExpression(), ctx) : literalName(nameNode);
      if (name === null) {
        onOpaque("computed key");
        continue;
      }
      const value = k === SyntaxKind.ShorthandPropertyAssignment ? prop.getNameNode() : prop.getInitializer();
      props.push({ name, value });
    } else if (k === SyntaxKind.SpreadAssignment && followSpreads) {
      const spread = spreadLiterals(prop.getExpression(), ctx);
      if (spread) for (const s of spread) props.push(...literalProps(s, ctx, onOpaque, true));
      else onOpaque("spread");
    } else {
      onOpaque(k === SyntaxKind.SpreadAssignment ? "spread" : "accessor/method");
    }
  }
  return props;
}

/** The object literals a spread operand can be (`[]` for nothing), or null when this file cannot say. */
function spreadLiterals(expr, ctx) {
  const v = unwrapExpression(expr);
  if (!v || isNullish(v) || v.getKind() === SyntaxKind.FalseKeyword) return [];
  if (v.getKind() === SyntaxKind.ConditionalExpression) {
    const whenTrue = spreadLiterals(v.getWhenTrue(), ctx);
    const whenFalse = spreadLiterals(v.getWhenFalse(), ctx);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (v.getKind() === SyntaxKind.BinaryExpression && v.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken) {
    return spreadLiterals(v.getRight(), ctx);
  }
  return objectLiterals(v, ctx);
}

/**
 * One walk decides both questions for a call. `model` is the schema model at the position,
 * or null where the receiver did not resolve (or the key is not a relation): the walk goes on
 * either way, so a digest key under a filter position is a lookup whatever the receiver.
 * Opacity is reported only where `model` is known — in a filter on a token model, or in an
 * argument / projection / write on a model that reaches one by relation.
 */
const opaqueIf = (applies, res, label) => (detail) => {
  if (applies) res.opaque.push(`${label}: ${detail}`);
};

/** A call's argument object, or a nested relation's: its filter, projection and write positions. */
function walkArgs(node, model, res, ctx, what = "argument", writesRelations = true) {
  if (isNullish(node) || isBooleanLiteral(node)) return;
  const opaque = opaqueIf(TOKEN_ADJACENT.has(model), res, `${model} ${what}`);
  const props = readProps(node, ctx, opaque, true);
  if (!props) return opaque("not an object literal");
  for (const { name, value } of props) {
    if (FILTER_KEYS.has(name)) walkWhere(value, model, res, ctx, name);
    else if (PROJECTION_KEYS.has(name)) walkProjection(value, model, res, ctx, name);
    else if (WRITE_KEYS.has(name)) walkData(value, writesRelations ? model : null, res, ctx, name);
  }
}

/** `select` / `include`: each relation's own arguments, and `_count` (`{ select: { rel: { where } } }`). */
function walkProjection(node, model, res, ctx, what) {
  if (isNullish(node) || isBooleanLiteral(node)) return;
  const opaque = opaqueIf(TOKEN_ADJACENT.has(model), res, `${model} ${what}`);
  const props = readProps(node, ctx, opaque, true);
  if (!props) return opaque("not an object literal");
  for (const { name, value } of props) {
    if (name === "_count") walkArgs(value, model, res, ctx, "_count");
    else walkArgs(value, relationOf(model, name)?.type ?? null, res, ctx, name);
  }
}

function walkWhere(node, model, res, ctx, what = "where") {
  if (isNullish(node) || isBooleanLiteral(node)) return;
  const opaque = opaqueIf(TOKEN_MODELS.has(model), res, `${model} ${what}`);
  if (isArrayLiteral(node)) {
    for (const el of unwrapExpression(node).getElements()) {
      if (el.getKind() === SyntaxKind.SpreadElement) opaque("spread");
      else walkWhere(el, model, res, ctx, what);
    }
    return;
  }
  const props = readProps(node, ctx, opaque);
  if (!props) return opaque("not an object literal");
  walkWhereProps(props, model, res, ctx, opaque);
}

function walkWhereProps(props, model, res, ctx, opaque) {
  for (const { name, value } of props) {
    if (DIGEST_KEYS.has(name)) {
      res.lookup = true;
      if (MODELS.get(model)?.has(name)) res.lookupModels.add(model);
      continue;
    }
    if (LOGICAL.has(name)) {
      if (isArrayLiteral(value)) {
        for (const el of unwrapExpression(value).getElements()) {
          if (el.getKind() === SyntaxKind.SpreadElement) opaque(`${name} spread`);
          else walkWhere(el, model, res, ctx);
        }
      } else walkWhere(value, model, res, ctx);
      continue;
    }
    const field = relationOf(model, name);
    if (field) readRelationFilter(value, field.type, res, ctx);
    else walkWhere(value, null, res, ctx); // a scalar filter, or a key of a model this walk does not know
  }
}

function readRelationFilter(node, related, res, ctx) {
  if (isNullish(node)) return;
  const opaque = opaqueIf(TOKEN_MODELS.has(related), res, `${related} relation filter`);
  const props = readProps(node, ctx, opaque);
  if (!props) return opaque("not an object literal");
  if (props.length > 0 && props.every((p) => RELATION_FILTERS.has(p.name))) {
    for (const { value } of props) walkWhere(value, related, res, ctx);
  } else {
    walkWhereProps(props, related, res, ctx, opaqueIf(TOKEN_MODELS.has(related), res, `${related} where`)); // a direct to-one filter
  }
}

/** A `data` (or an upsert's `create`/`update`): an object, or an array of them, keyed by field. */
function walkData(node, model, res, ctx, what = "data") {
  if (isNullish(node)) return;
  const opaque = opaqueIf(TOKEN_ADJACENT.has(model), res, `${model} ${what}`);
  if (isArrayLiteral(node)) {
    for (const el of unwrapExpression(node).getElements()) {
      if (el.getKind() === SyntaxKind.SpreadElement) opaque("spread");
      else walkData(el, model, res, ctx, what);
    }
    return;
  }
  const props = readProps(node, ctx, opaque, true);
  if (!props) return opaque("not an object literal");
  for (const { name, value } of props) walkNestedWrite(value, relationOf(model, name)?.type ?? null, res, ctx, name);
}

/** A field's value in a `data`: for a relation, its nested-write operations. */
function walkNestedWrite(node, model, res, ctx, field) {
  if (isNullish(node) || isBooleanLiteral(node)) return;
  const opaque = opaqueIf(TOKEN_ADJACENT.has(model), res, `${model} ${field}`);
  const props = readProps(node, ctx, opaque, true);
  if (!props) return opaque("not an object literal");
  for (const { name, value } of props) {
    const what = `${field}.${name}`;
    if (WRITE_FILTER_OPS.has(name)) walkWhere(value, model, res, ctx, what);
    else if (name === "create") walkData(value, model, res, ctx, what);
    else if (name === "createMany") walkArgs(value, model, res, ctx, what, false);
    else if (WRITE_ARG_OPS.has(name)) {
      for (const el of isArrayLiteral(value) ? unwrapExpression(value).getElements() : [value]) {
        const elOpaque = opaqueIf(TOKEN_ADJACENT.has(model), res, `${model} ${what}`);
        if (el.getKind() === SyntaxKind.SpreadElement) {
          elOpaque("spread");
          continue;
        }
        const elProps = readProps(el, ctx, elOpaque, true);
        if (!elProps) {
          elOpaque("not an object literal");
          continue;
        }
        // `{ where, data }` / `{ where, create, update }`, or a to-one `update` given the data itself.
        if (!elProps.some((p) => p.name === "where" || WRITE_KEYS.has(p.name))) {
          for (const p of elProps) walkNestedWrite(p.value, relationOf(model, p.name)?.type ?? null, res, ctx, p.name);
          continue;
        }
        for (const p of elProps) {
          if (p.name === "where") walkWhere(p.value, model, res, ctx, `${what}.where`);
          else if (WRITE_KEYS.has(p.name)) walkData(p.value, SCALAR_WRITE_OPS.has(name) ? null : model, res, ctx, `${what}.${p.name}`);
        }
      }
    }
  }
}

/** { lookup, lookupModels, opaque[] } for one call: every argument is walked, the first under the delegate's model. */
function readCall(call, target, ctx) {
  const res = { lookup: false, lookupModels: new Set(), opaque: [] };
  call.getArguments().forEach((arg, i) => {
    const argModel = (i === 0 && target?.model) || null;
    if (arg.getKind() === SyntaxKind.SpreadElement) opaqueIf(TOKEN_ADJACENT.has(argModel), res, `${argModel} argument`)("spread");
    else if (argModel || ctx.mayHoldDigestKey) walkArgs(arg, argModel, res, ctx, "argument", !argModel || RELATION_WRITE_METHODS.has(target.method));
  });
  return res;
}

// ─── per-use-gated predicate ─────────────────────────────────

function isOkFalseLiteral(expr) {
  const v = unwrapExpression(expr);
  if (v?.getKind() !== SyntaxKind.ObjectLiteralExpression) return false;
  const props = v.getProperties();
  if (props.some((p) => p.getKind() !== SyntaxKind.PropertyAssignment && p.getKind() !== SyntaxKind.ShorthandPropertyAssignment)) return false;
  // A computed key could be a second `ok` (`["ok"]: true`) that literalName cannot see.
  if (props.some((p) => p.getNameNode().getKind() === SyntaxKind.ComputedPropertyName)) return false;
  const oks = props.filter((p) => literalName(p.getNameNode()) === "ok");
  if (oks.length !== 1 || oks[0].getKind() !== SyntaxKind.PropertyAssignment) return false;
  return unwrapExpression(oks[0].getInitializer())?.getKind() === SyntaxKind.FalseKeyword;
}

const soleStatement = (stmt) => {
  if (stmt?.getKind() !== SyntaxKind.Block) return stmt;
  const s = stmt.getStatements();
  return s.length === 1 ? s[0] : null;
};

function isGateIf(stmt, file) {
  if (stmt?.getKind() !== SyntaxKind.IfStatement || stmt.getElseStatement()) return false;
  const cond = unwrapExpression(stmt.getExpression());
  if (cond?.getKind() !== SyntaxKind.AwaitExpression) return false;
  const call = unwrapExpression(cond.getExpression());
  if (call?.getKind() !== SyntaxKind.CallExpression) return false;
  if (!refersToImport(call.getExpression(), file, GATE_MODULE, GATE_FN)) return false;
  const consequent = soleStatement(stmt.getThenStatement());
  return consequent?.getKind() === SyntaxKind.ReturnStatement && isOkFalseLiteral(consequent.getExpression());
}

function isNegatedExemption(cond, fn, file) {
  const c = unwrapExpression(cond);
  if (c?.getKind() !== SyntaxKind.PrefixUnaryExpression || c.getOperatorToken() !== SyntaxKind.ExclamationToken) return false;
  const operand = unwrapExpression(c.getOperand());
  if (operand?.getKind() !== SyntaxKind.PropertyAccessExpression || operand.getName() !== "passkeyExemption") return false;
  const recv = unwrapExpression(operand.getExpression());
  if (recv?.getKind() !== SyntaxKind.Identifier) return false;
  const decl = visibleBinding(recv.getText(), recv, file.bindingsFor);
  return decl?.getKind() === SyntaxKind.Parameter && decl.getParent() === fn;
}

function isGateStatement(stmt, fn, file) {
  if (isGateIf(stmt, file)) return true;
  if (stmt.getKind() !== SyntaxKind.IfStatement || stmt.getElseStatement()) return false;
  if (!isNegatedExemption(stmt.getExpression(), fn, file)) return false;
  return isGateIf(soleStatement(stmt.getThenStatement()), file);
}

/** Null when `fn` satisfies per-use-gated, else why not. */
function perUseGatedViolation(fn, file) {
  const body = fn?.getBody?.();
  if (!body || body.getKind() !== SyntaxKind.Block) return "has no block body";
  const gates = body.getStatements().filter((s) => isGateStatement(s, fn, file));
  if (gates.length !== 1) {
    return `needs exactly one direct-statement \`if (await ${GATE_FN}(...)) return { ok: false, ... }\` (imported from passkey-gate), found ${gates.length}`;
  }
  const gate = gates[0];
  const returns = body.getDescendantsOfKind(SyntaxKind.ReturnStatement).filter((r) => enclosingFunction(r) === fn);
  for (const r of returns) {
    if (r.getStart() < gate.getStart() && !isOkFalseLiteral(r.getExpression())) {
      return `line ${r.getStartLineNumber()} returns something other than an \`ok: false\` literal before the gate`;
    }
  }
  if (!returns.some((r) => r.getStart() >= gate.getEnd())) return "no return follows the gate";
  return null;
}

// ─── Scan ────────────────────────────────────────────────────

const project = createAstProject();
const files = new Map(); // rel -> { sf, rel, bindingsFor, imports }
const analysed = new Map(); // key -> { rel, name, fn, fns, owners, file, sites, lookups, opaque: [], lines: [] }
const lookedUpModels = new Set();
const exemptionPairs = [];

const EXT_FILE_REL = (rel) => moduleOf(rel) === EXT_MODULE;

for (const { rel, sf } of sourceFiles(project, join(ROOT, SCAN_ROOT), ROOT)) {
  let bindings;
  const file = { sf, rel, bindingsFor: () => (bindings ??= bindingIndex(sf)), imports: importsOf(sf, rel) };
  files.set(rel, file);
  // A digest key is a property name spelled as a DIGEST_KEYS member, or one an escape spells
  // (`"token\x48ash"`, `token\u0048ash`, a line continuation): a file with neither has no
  // lookup, and a call on no known delegate there need not be walked.
  const ctx = { bindingsFor: file.bindingsFor, mayHoldDigestKey: /tokenHash|codeHash|replacedByHash|\\/.test(sf.getFullText()) };


  // Digest lookups (any call) and opaque positions (calls on a resolved delegate).
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const target = delegateTarget(call, file);
    if (target?.unreadable) {
      failAt(rel, call, `delegate method called on an element access whose key this gate cannot read (\`x[k].<method>(...)\`): name the delegate (\`x.<handle>\`), or bind the key with \`const k = "<handle>"\``);
    }
    const res = readCall(call, target, ctx);
    if (!res.lookup && res.opaque.length === 0) continue;
    for (const m of res.lookupModels) lookedUpModels.add(m);
    const at = attribute(call);
    if (!at) {
      failAt(rel, call, `digest lookup or opaque site cannot be attributed to a named function, method or exported const`);
      continue;
    }
    const key = `${rel}#${at.name}`;
    if (!analysed.has(key)) analysed.set(key, { rel, name: at.name, fn: at.fn, fns: new Set(), owners: new Set(), file, sites: 0, lookups: 0, opaque: [], lines: [] });
    const a = analysed.get(key);
    a.fns.add(at.fn);
    a.owners.add(at.owner);
    // One site per call: a call that is both a lookup and opaque counts once.
    a.sites += 1;
    if (res.lookup) a.lookups += 1;
    if (res.opaque.length > 0) a.opaque.push(`line ${call.getStartLineNumber()}: ${res.opaque.join(", ")}`);
    a.lines.push(call.getStartLineNumber());
  }

  // A lookup through any receiver is found above, but opacity is judged only where the
  // receiver resolves to a model. A token-model delegate reached other than as
  // `<recv>.<handle>.<method>(...)` — a value reference, an element-access or `.call`/`.apply`
  // method, a delegate passed as an argument — would take its calls' unreadable wheres out of
  // that judgement, so it fails; an alias bound by destructuring a handle is followed.
  const delegateRefs = [];
  for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (TOKEN_HANDLES.has(pa.getName())) delegateRefs.push(pa);
    if (EXTENDS_RE.test(pa.getName())) failAt(rel, pa, `$extends: a client extension can add delegate members this gate cannot read`);
  }
  for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const key = constString(ea.getArgumentExpression(), file);
    if (key === null) continue;
    if (TOKEN_HANDLES.has(key)) delegateRefs.push(ea);
    if (EXTENDS_RE.test(key)) failAt(rel, ea, `$extends: a client extension can add delegate members this gate cannot read`);
  }
  for (const el of sf.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    if (el.getParent()?.getKind() !== SyntaxKind.ObjectBindingPattern) continue;
    const handle = bindingKey(el);
    if (!handle || !TOKEN_HANDLES.has(handle)) continue;
    const nameNode = el.getNameNode();
    if (nameNode.getKind() !== SyntaxKind.Identifier) {
      failAt(rel, el, `destructures the ${HANDLES.get(handle)} delegate into a nested pattern: its methods cannot be followed`);
      continue;
    }
    const decl = visibleBinding(el.getName(), nameNode, file.bindingsFor);
    for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (id === nameNode || id.getText() !== el.getName()) continue;
      const parent = id.getParent();
      const pk = parent.getKind();
      if (pk === SyntaxKind.PropertyAccessExpression && parent.getNameNode() === id) continue;
      if ((pk === SyntaxKind.PropertyAssignment || pk === SyntaxKind.MethodDeclaration || pk === SyntaxKind.PropertySignature || pk === SyntaxKind.PropertyDeclaration) && parent.getNameNode() === id) continue;
      if (pk === SyntaxKind.BindingElement && parent.getPropertyNameNode() === id) continue;
      if (pk === SyntaxKind.TypeQuery || pk === SyntaxKind.QualifiedName) continue;
      if (visibleBinding(id.getText(), id, file.bindingsFor) === decl) delegateRefs.push(id);
    }
  }
  for (const ref of delegateRefs) {
    if (!isDirectDelegateUse(ref)) {
      failAt(
        rel,
        ref,
        `token-model delegate referenced other than as \`<delegate>.<method>(...)\` (${ref.getParent().getKindName()}): its calls' wheres cannot be read. Call a method on it directly, read a row's relation field (\`x.<handle>.<field>\`, a name no delegate has), or rename a non-Prisma property that shares the handle's name`,
      );
    }
  }

  // Raw SQL: the digest columns and the Unicode-escape forms in any literal text (a regular
  // expression's too: `/token_hash/.source` is that text), and unreadable SQL arguments.
  for (const lit of [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.TemplateHead),
    ...sf.getDescendantsOfKind(SyntaxKind.TemplateMiddle),
    ...sf.getDescendantsOfKind(SyntaxKind.TemplateTail),
    ...sf.getDescendantsOfKind(SyntaxKind.RegularExpressionLiteral),
  ]) {
    // Source spelling and cooked value both: `token\x5fhash` spells the column only once cooked.
    const texts = [lit.getText(), lit.compilerNode.text ?? ""];
    if (texts.some((t) => DIGEST_COLUMN.test(t))) {
      failAt(rel, lit, `literal text names a digest column (token_hash/code_hash/replaced_by_hash): raw SQL digest lookups are refused`);
    }
    if (texts.some((t) => UNICODE_ESCAPE_SQL.test(t))) {
      failAt(rel, lit, `literal text holds U& / UESCAPE: a Unicode-escaped SQL identifier can spell a digest column the scan cannot read`);
    }
  }
  for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const method = pa.getName();
    if (!RAW_METHOD.test(method)) continue;
    const parent = pa.getParent();
    const unsafe = method.endsWith("Unsafe");
    if (parent.getKind() === SyntaxKind.TaggedTemplateExpression && parent.getTag() === pa && !unsafe) continue;
    if (parent.getKind() === SyntaxKind.CallExpression && parent.getExpression() === pa && unsafe) {
      const arg = parent.getArguments()[0];
      if (isStringish(arg)) continue;
      const a = unwrapExpression(arg);
      // Both names must be the raw-sql module's own exports, resolved where they are written.
      if (
        a?.getKind() === SyntaxKind.CallExpression &&
        refersToImport(a.getExpression(), file, RAW_SQL_MODULE, "renderSql") &&
        a.getArguments().length === 1 &&
        a.getArguments()[0].getKind() === SyntaxKind.TaggedTemplateExpression &&
        refersToImport(a.getArguments()[0].getTag(), file, RAW_SQL_MODULE, "trustedSql")
      ) continue;
      failAt(rel, pa, `${method}'s SQL argument is not a literal (nor renderSql(trustedSql\`...\`)): its text cannot be read`);
      continue;
    }
    failAt(rel, pa, `${method} is used other than as a template tag / a call with a literal SQL argument: its text cannot be read`);
  }
  for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const a = unwrapExpression(ea.getArgumentExpression());
    if (isStringish(a) && RAW_METHOD.test(a.getLiteralText())) failAt(rel, ea, `raw SQL method reached by element access: its text cannot be read`);
  }

  // Forbidden reads.
  if (rel.startsWith(TOKEN_DIR)) {
    for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (FORBIDDEN_READS.has(pa.getName())) failAt(rel, pa, `reads ${pa.getName()} — token validators use passkeyGateBlocks, not the raw policy fields`);
    }
    for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
      const a = unwrapExpression(ea.getArgumentExpression());
      if (isStringish(a) && FORBIDDEN_READS.has(a.getLiteralText())) failAt(rel, ea, `reads ${a.getLiteralText()} by element access`);
    }
    for (const be of sf.getDescendantsOfKind(SyntaxKind.BindingElement)) {
      if (be.getParent()?.getKind() !== SyntaxKind.ObjectBindingPattern) continue;
      const nameNode = be.getPropertyNameNode() ?? be.getNameNode();
      const name = literalName(nameNode);
      if (name && FORBIDDEN_READS.has(name)) failAt(rel, be, `destructures ${name}`);
    }
  }

  // Reachability of validateExtensionToken.
  const isExtFile = EXT_FILE_REL(rel);
  for (const decl of sf.getImportDeclarations()) {
    if (resolveSpecifier(rel, decl.getModuleSpecifierValue()) !== EXT_MODULE || decl.isTypeOnly()) continue;
    if (decl.getNamespaceImport()) failAt(rel, decl, `namespace import of extension-token: calls through it cannot be followed`);
    if (decl.getDefaultImport()) failAt(rel, decl, `default import of extension-token: cannot be followed`);
  }
  for (const decl of sf.getExportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (!spec || resolveSpecifier(rel, spec) !== EXT_MODULE) continue;
    if (!decl.hasNamedExports()) failAt(rel, decl, `\`export *\` of extension-token re-exports ${EXT_FN} past the exemption pin`);
    else if (decl.getNamedExports().some((s) => s.getName() === EXT_FN)) failAt(rel, decl, `re-export of ${EXT_FN}: calls through it cannot be followed`);
  }
  for (const ie of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const ref = ie.getModuleReference();
    if (ref.getKind() !== SyntaxKind.ExternalModuleReference) continue;
    const e = ref.getExpression();
    if (!isStringish(e) || (resolveSpecifier(rel, e.getLiteralText()) === EXT_MODULE && !isExtFile)) {
      failAt(rel, ie, `import-equals of a module this gate cannot rule out as extension-token`);
    }
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const isDynamic = callee.getKind() === SyntaxKind.ImportKeyword;
    const isRequire = callee.getKind() === SyntaxKind.Identifier && callee.getText() === "require" && !visibleBinding("require", callee, file.bindingsFor);
    if (!isDynamic && !isRequire) continue;
    const arg = unwrapExpression(call.getArguments()[0]);
    // A template whose fixed tail ends in `.json` can only load JSON, never the module.
    if (arg?.getKind() === SyntaxKind.TemplateExpression && /\.json$/.test(arg.getTemplateSpans().at(-1).getLiteral().getLiteralText())) continue;
    const spec = arg ? constString(arg, file) : null;
    if (spec === null) {
      failAt(rel, call, `dynamic import/require with a specifier this gate cannot read: it could reach ${EXT_FN}`);
      continue;
    }
    if (resolveSpecifier(rel, spec) === EXT_MODULE && !isExtFile) {
      failAt(rel, call, `dynamic import/require of extension-token: calls through it cannot be followed`);
    }
  }

  const locals = isExtFile
    ? [EXT_FN]
    : file.imports.filter((i) => i.from === EXT_MODULE && i.imported === EXT_FN && !i.typeOnly).map((i) => i.local);
  if (locals.length === 0) continue;
  const extDecl = isExtFile ? sf.getFunction(EXT_FN) : null;
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const name = id.getText();
    if (!locals.includes(name)) continue;
    const parent = id.getParent();
    const pk = parent.getKind();
    // Names that are not references to the binding.
    if (pk === SyntaxKind.ImportSpecifier || pk === SyntaxKind.ImportClause) continue;
    if (extDecl && parent === extDecl) continue;
    if (pk === SyntaxKind.PropertyAccessExpression && parent.getNameNode() === id) continue;
    if ((pk === SyntaxKind.PropertyAssignment || pk === SyntaxKind.MethodDeclaration || pk === SyntaxKind.PropertySignature || pk === SyntaxKind.PropertyDeclaration) && parent.getNameNode() === id) continue;
    if (pk === SyntaxKind.BindingElement && parent.getPropertyNameNode() === id) continue;
    if (pk === SyntaxKind.TypeQuery || pk === SyntaxKind.QualifiedName) continue;
    // Which binding does it mean here?
    const visible = visibleBinding(name, id, file.bindingsFor);
    const isRef = isExtFile ? !!visible && visible === extDecl : !visible;
    if (!isRef) continue;
    if (pk === SyntaxKind.CallExpression && parent.getExpression() === id) {
      recordCallSite(parent, file);
      continue;
    }
    failAt(rel, id, `${EXT_FN} used as a value (${parent.getKindName()}): only direct calls can be checked against the exemption pin`);
  }
}

function recordCallSite(call, file) {
  const { rel } = file;
  const args = call.getArguments();
  if (args.some((a) => a.getKind() === SyntaxKind.SpreadElement)) return failAt(rel, call, `${EXT_FN} called with a spread argument`);
  if (args.length === 1) return;
  if (args.length !== 2) return failAt(rel, call, `${EXT_FN} called with ${args.length} arguments`);
  const opts = unwrapExpression(args[1]);
  const props = opts?.getKind() === SyntaxKind.ObjectLiteralExpression ? opts.getProperties() : null;
  const prop = props?.length === 1 && props[0].getKind() === SyntaxKind.PropertyAssignment ? props[0] : null;
  const value = prop && literalName(prop.getNameNode()) === "passkeyExemption" ? unwrapExpression(prop.getInitializer()) : null;
  const holder = value?.getKind() === SyntaxKind.PropertyAccessExpression ? unwrapExpression(value.getExpression()) : null;
  const fromConst =
    holder &&
    (refersToImport(holder, file, EXT_TYPES_MODULE, EXEMPTION_CONST) || refersToImport(holder, file, EXT_MODULE, EXEMPTION_CONST));
  if (!fromConst) {
    return failAt(rel, call, `${EXT_FN}'s options must be the inline literal { passkeyExemption: ${EXEMPTION_CONST}.<member> }`);
  }
  const at = attribute(call);
  if (!at) return failAt(rel, call, `exempt ${EXT_FN} call cannot be attributed to a named handler`);
  exemptionPairs.push({ key: `${rel}#${at.name}`, member: value.getName(), line: call.getStartLineNumber() });
}

if (files.size === 0) fatal(`scanned zero source files under ${join(ROOT, SCAN_ROOT)}.`);

// The modules the predicate and the pin resolve against must exist as declared.
const fileByModule = (m) => [...files.values()].find((f) => moduleOf(f.rel) === m);
const gateFile = fileByModule(GATE_MODULE);
if (!gateFile?.sf.getFunction(GATE_FN)?.hasExportKeyword()) fatal(`${GATE_MODULE}.ts does not export function ${GATE_FN}.`);
const extFile = fileByModule(EXT_MODULE);
if (!extFile?.sf.getFunction(EXT_FN)?.hasExportKeyword()) fatal(`${EXT_MODULE}.ts does not export function ${EXT_FN}.`);
if (!fileByModule(EXT_TYPES_MODULE)?.sf.getVariableDeclaration(EXEMPTION_CONST)) fatal(`${EXT_TYPES_MODULE}.ts does not declare ${EXEMPTION_CONST}.`);

// ─── Manifest adjudication ───────────────────────────────────

/** Every function with a body that `key` (`<path>#<name>`) designates: more than one is ambiguous. */
function findNamedFunctions(key) {
  const [rel, name] = key.split("#");
  const file = files.get(rel);
  if (!file || !name) return [];
  const found = [];
  for (const node of file.sf.getDescendants()) {
    if (!FN_LIKE.has(node.getKind()) || !node.getBody?.()) continue;
    const at = attribute(node.getFirstDescendant() ?? node);
    if (at?.name === name && at.fn === node) found.push({ node, file });
  }
  return found;
}

/**
 * A refusal: an object literal (no spread, computed key or accessor) that is `ok: false`, or
 * has no `ok` and an `error`, or has no `ok` and a string-literal `type` other than "success".
 */
function isNonSuccessLiteral(expr) {
  const v = unwrapExpression(expr);
  if (v?.getKind() !== SyntaxKind.ObjectLiteralExpression) return false;
  const props = v.getProperties();
  if (props.some((p) => p.getKind() !== SyntaxKind.PropertyAssignment && p.getKind() !== SyntaxKind.ShorthandPropertyAssignment)) return false;
  if (props.some((p) => p.getNameNode().getKind() === SyntaxKind.ComputedPropertyName)) return false;
  const named = (n) => props.filter((p) => literalName(p.getNameNode()) === n);
  if (named("ok").length > 0) return isOkFalseLiteral(v);
  const errors = named("error");
  if (errors.length > 0) return errors.length === 1 && errors[0].getKind() === SyntaxKind.PropertyAssignment;
  const types = named("type");
  if (types.length !== 1 || types[0].getKind() !== SyntaxKind.PropertyAssignment) return false;
  const t = unwrapExpression(types[0].getInitializer());
  return isStringish(t) && t.getLiteralText() !== "success";
}

/**
 * Does `fn` (callbacks included) hold `if (<gate>(...))` or `if (await <gate>(...))` — the
 * condition exactly that call, an INLINE_GATES function resolved scope-aware — with no `else`
 * and a consequent that returns a refusal literal?
 */
function callsInlineGate({ node, file }) {
  return node.getDescendantsOfKind(SyntaxKind.IfStatement).some((stmt) => {
    if (stmt.getElseStatement()) return false;
    let cond = unwrapExpression(stmt.getExpression());
    if (cond?.getKind() === SyntaxKind.AwaitExpression) cond = unwrapExpression(cond.getExpression());
    if (cond?.getKind() !== SyntaxKind.CallExpression) return false;
    if (!INLINE_GATES.some(([m, n]) => refersToImport(cond.getExpression(), file, m, n))) return false;
    const consequent = soleStatement(stmt.getThenStatement());
    return consequent?.getKind() === SyntaxKind.ReturnStatement && isNonSuccessLiteral(consequent.getExpression());
  });
}

/** Is `ref` (`<path>#<name>`) an exported top-level `const` of that file? */
function isExportedConstRef(ref) {
  if (typeof ref !== "string" || !/^[^#]+#[^#]+$/.test(ref)) return false;
  const [rel, name] = ref.split("#");
  const sf = files.get(rel)?.sf;
  return !!sf?.getVariableStatements().some(
    (st) => st.hasExportKeyword() && st.getDeclarationKind() === "const" && st.getDeclarations().some((d) => d.getName() === name),
  );
}

for (const [key, a] of analysed) {
  const entry = ENTRIES.get(key);
  const calls = a.sites;
  const where = `${key} (lines ${a.lines.join(", ")})`;
  if (!entry) {
    failures.push(`UNLISTED: ${where} — ${a.lookups} digest lookup(s), ${a.opaque.length} opaque site(s)${a.opaque.length ? `: ${a.opaque.join("; ")}` : ""}. Classify it in ${MANIFEST_PATH}.`);
    continue;
  }
  if (a.owners.size > 1) {
    failures.push(`AMBIGUOUS_KEY: ${where} — ${a.owners.size} distinct functions share the name; rename one so each key designates one function.`);
    continue;
  }
  if (!CLASSES.has(entry.class)) {
    failures.push(`BAD_ENTRY: ${key} has class ${JSON.stringify(entry.class)}; expected one of ${[...CLASSES].join(", ")}.`);
    continue;
  }
  if (typeof entry.reason !== "string" || entry.reason.trim().length < MIN_REASON) {
    failures.push(`BAD_ENTRY: ${key} needs a reason of at least ${MIN_REASON} characters.`);
  }
  if (entry.calls !== calls) {
    failures.push(`COUNT_MISMATCH: ${where} has ${calls} site(s) (${a.lookups} lookup, ${a.opaque.length} opaque call(s)); the manifest says ${entry.calls}.`);
  }
  if (a.opaque.length > 0 && entry.class !== "opaque-where") {
    failures.push(`OPAQUE_WHERE: ${key} has a position this gate cannot read (${a.opaque.join("; ")}) — a human classifies it as opaque-where.`);
  }
  if (entry.class === "opaque-where" && a.opaque.length === 0) {
    failures.push(`STALE_OPAQUE: ${key} is opaque-where but every position it has is now readable — reclassify it.`);
  }
  if (entry.class === "per-use-gated") {
    const why = a.fns.size > 1 ? `its sites sit in ${a.fns.size} functions` : perUseGatedViolation(a.fn, a.file);
    if (why) failures.push(`NOT_GATED: ${key} is per-use-gated but ${why}.`);
  }
  if (entry.class === "refresh-bound") {
    if (typeof entry.refreshRoute !== "string" || !existsSync(join(ROOT, entry.refreshRoute))) {
      failures.push(`BAD_ENTRY: ${key} is refresh-bound but its refreshRoute ${JSON.stringify(entry.refreshRoute)} does not exist.`);
    }
    if (!isExportedConstRef(entry.lifetime)) {
      failures.push(`BAD_ENTRY: ${key} is refresh-bound but its lifetime ${JSON.stringify(entry.lifetime)} is not a <path>#<name> naming an exported const of that file.`);
    }
    const gates = entry.inlineGate === undefined ? [] : [].concat(entry.inlineGate);
    if (gates.length === 0) failures.push(`BAD_ENTRY: ${key} is refresh-bound but names no inlineGate: the mint it relies on must be gated.`);
    for (const g of gates) {
      const found = typeof g === "string" ? findNamedFunctions(g) : [];
      if (found.length > 1) {
        failures.push(`AMBIGUOUS_KEY: inline gate ${JSON.stringify(g)} of ${key} names ${found.length} functions.`);
      } else if (found.length === 0 || !callsInlineGate(found[0])) {
        failures.push(
          `BAD_ENTRY: ${key} relies on inline gate ${JSON.stringify(g)}, which does not exist or does not hold \`if ([await] <gate>(...)) return <refusal literal>\` (no else) for a gate of ${INLINE_GATES.map(([m, n]) => `${n} (${m})`).join(" / ")}.`,
        );
      }
    }
  }
}
for (const key of ENTRIES.keys()) {
  if (!analysed.has(key)) failures.push(`STALE_ENTRY: ${key} is in the manifest but no digest lookup or opaque site is attributed to it.`);
}

// Model coverage: a token model no analysed lookup reaches is looked up some way this gate
// cannot see (or not at all); a human says which, in the manifest's "models".
for (const model of [...TOKEN_MODELS].sort()) {
  const entry = MODEL_ENTRIES.get(model);
  if (lookedUpModels.has(model)) {
    if (entry !== undefined) failures.push(`STALE_MODEL: ${model} is in the manifest's "models" but has an analysed digest lookup — remove the entry.`);
  } else if (entry === undefined) {
    failures.push(`UNCOVERED_MODEL: ${model} declares a digest column but no analysed lookup reaches it — find its lookups, or list it in "models" with a reason.`);
  }
}
for (const [model, entry] of MODEL_ENTRIES) {
  if (!TOKEN_MODELS.has(model)) failures.push(`BAD_ENTRY: "models" names ${model}, which is not a model declaring ${[...DIGEST_KEYS].join("/")}.`);
  else if (typeof entry?.reason !== "string" || entry.reason.trim().length < MIN_REASON) {
    failures.push(`BAD_ENTRY: "models" entry ${model} needs a reason of at least ${MIN_REASON} characters.`);
  }
}

// I3: the exemption pin, exactly.
const pinKey = (k, m) => `${k} ${m}`;
const expected = EXEMPTION_PIN.map(([k, m]) => pinKey(k, m)).sort();
const actual = exemptionPairs.map((p) => pinKey(p.key, p.member)).sort();
if (JSON.stringify(expected) !== JSON.stringify(actual)) {
  failures.push(
    `EXEMPTION_PIN: the passkeyExemption call sites must be exactly\n      ${expected.join("\n      ")}\n    found\n      ${actual.join("\n      ") || "(none)"}`,
  );
}

console.log(
  `check-bearer-passkey-gate: files=${files.size} token-models=${TOKEN_MODELS.size} analysed=${analysed.size} manifest=${ENTRIES.size} exemption-sites=${exemptionPairs.length}`,
);
if (analysed.size === 0) fatal(`analysed zero functions: no digest lookup was found, so nothing was checked.`);

if (failures.length > 0) {
  console.error("\nBearer passkey gate violations (plan C7):");
  for (const f of failures) console.error(`  ${f}`);
  console.error(`\nFAIL: ${failures.length} violation(s).`);
  process.exit(1);
}
console.log("OK (every digest lookup is classified; per-use gates and the exemption pin hold)");
