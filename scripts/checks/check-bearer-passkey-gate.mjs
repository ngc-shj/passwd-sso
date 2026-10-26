#!/usr/bin/env node
/**
 * CI gate (AST, ts-morph, no Program): every user-bound bearer validator is
 * gated per use by `passkeyGateBlocks`, or refresh-bound with a stated
 * lifetime (I1), and only the three self-protection call sites skip the gate
 * (I3). Plan: docs/archive/review/api-key-passkey-requirement-plan.md, C7.
 *
 * The class is derived from the code, not from a list:
 *
 *   - Token models: every model in prisma/schema.prisma declaring a `tokenHash`
 *     or `codeHash` field (read as source through lib/prisma-relation-reach.mjs
 *     — the static-checks job need not have a generated client). An empty set
 *     fails.
 *   - A digest lookup: a delegate call (`<recv>.<handle>.<method>(...)`, the
 *     handle also as a bare identifier or a string element access) whose
 *     argument's `where` contains a `tokenHash`/`codeHash` key — directly,
 *     under AND/OR/NOT, or under a relation filter.
 *   - Refuse rather than guess: where the position's model is a token model, a
 *     `where` (or the argument holding it) that is not an object literal — a
 *     `const` bound to one is followed, scope-aware — or that holds a spread,
 *     a computed key or an accessor, is "opaque". A function with an opaque
 *     site needs an `opaque-where` manifest entry; its count pins the sites.
 *   - Raw SQL: the column names `token_hash` / `code_hash` in ANY string or
 *     template literal text fail outright — a fragment interpolated into a
 *     tagged template is invisible at the call, so the name is refused wherever
 *     it is written. An Unsafe call's SQL argument must be a string literal, a
 *     no-substitution template, or `renderSql(trustedSql`...`)` (whose text is
 *     literal and scanned by the rule above); `$queryRaw`/`$executeRaw` must be
 *     tag of a template. Any other spelling of a raw method fails.
 *
 * Each lookup or opaque site is attributed to the nearest named function,
 * method, `const`-bound function, or exported `const`; the key is
 * `<repo path>#<name>`. Every key needs a manifest entry
 * (bearer-passkey-gate-manifest.json) with a class, a reason, and `calls` (the
 * number of calls in it that are a lookup or opaque, each counted once). Unlisted key, stale entry, count mismatch, and
 * zero analysed all fail.
 *
 *   - per-use-gated: adjudicated on the AST. The function's own body (nested
 *     blocks included, nested functions excluded) returns nothing but an
 *     `ok: false` object literal (no spread, one `ok`) before exactly one `if`
 *     that is a direct statement of the body, whose condition is
 *     `await passkeyGateBlocks(...)` — the identifier resolving, scope-aware, to
 *     the named import from src/lib/auth/policy/passkey-gate (not shadowed) —
 *     with no `else` and a consequent returning an `ok: false` literal; or a
 *     no-`else` `if (!<param>.passkeyExemption)` / `!<param>?.passkeyExemption`
 *     on one of the function's own parameters whose only statement is that
 *     gate `if`. At least one return follows it.
 *   - refresh-bound: names `refreshRoute` (a file that exists), `lifetime` (an
 *     exported const declared under src/), and optionally `inlineGate`
 *     (`<path>#<fn>` keys whose bodies, callbacks included, call
 *     passkeyEnforcementBlocks or passkeyGateBlocks).
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
import { FILTERING, RELATION_FILTERS, SchemaReadError, loadPrismaSchema, objectLiterals } from "./lib/prisma-relation-reach.mjs";
import { bindingIndex, unwrapExpression, visibleBinding } from "./lib/scope-bindings.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = process.env.BEARER_PASSKEY_GATE_ROOT || REPO_ROOT;
const SCAN_ROOT = "src";
const SCHEMA_PATH = "prisma/schema.prisma";
const MANIFEST_PATH = "scripts/checks/bearer-passkey-gate-manifest.json";

const TOKEN_DIR = "src/lib/auth/tokens/";
const GATE_MODULE = "src/lib/auth/policy/passkey-gate";
const GATE_FN = "passkeyGateBlocks";
const EXT_MODULE = "src/lib/auth/tokens/extension-token";
const EXT_TYPES_MODULE = "src/lib/auth/tokens/extension-token-types";
const EXT_FN = "validateExtensionToken";
const EXEMPTION_CONST = "PASSKEY_EXEMPTION";
const DIGEST_KEYS = new Set(["tokenHash", "codeHash"]);
const FORBIDDEN_READS = new Set(["requirePasskey", "hasPasskey"]);
const INLINE_GATE_FNS = new Set(["passkeyEnforcementBlocks", GATE_FN]);
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
const RAW_METHOD = /^\$(query|execute)Raw(Unsafe)?$/;
const DIGEST_COLUMN = /token_hash|code_hash/i;
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
if (TOKEN_MODELS.size === 0) fatal(`${SCHEMA_PATH} declares no model with a tokenHash/codeHash field, so no lookup can be classified.`);

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

const isExportedVar = (decl) => decl.getVariableStatement?.()?.isExported?.() ?? false;

/** `{ name, fn }`: nearest named function, method, const-bound function, or exported const. */
function attribute(node) {
  let innermostFn = null;
  for (let p = node.getParent(); p; p = p.getParent()) {
    const k = p.getKind();
    if (FN_LIKE.has(k) && !innermostFn) innermostFn = p;
    if (k === SyntaxKind.FunctionDeclaration && p.getName()) return { name: p.getName(), fn: p };
    if (k === SyntaxKind.MethodDeclaration || k === SyntaxKind.GetAccessor || k === SyntaxKind.SetAccessor) {
      const n = literalName(p.getNameNode());
      if (n) return { name: n, fn: p };
    }
    if (k === SyntaxKind.FunctionExpression && p.getName()) return { name: p.getName(), fn: p };
    if (k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression) {
      const parent = p.getParent();
      if (parent?.getKind() === SyntaxKind.VariableDeclaration && unwrapExpression(parent.getInitializer()) === p) {
        if (parent.getNameNode().getKind() === SyntaxKind.Identifier) return { name: parent.getName(), fn: p };
      }
    }
    if (k === SyntaxKind.VariableDeclaration && isExportedVar(p) && p.getNameNode().getKind() === SyntaxKind.Identifier) {
      const init = unwrapExpression(p.getInitializer());
      return { name: p.getName(), fn: init && FN_LIKE.has(init.getKind()) ? init : innermostFn };
    }
  }
  return null;
}

// ─── Digest lookups and opaque wheres ────────────────────────

/** The model a delegate call targets, if it is a where-taking delegate method. */
function delegateModel(call) {
  const callee = unwrapExpression(call.getExpression());
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  if (!WHERE_METHODS.has(callee.getName())) return null;
  const recv = unwrapExpression(callee.getExpression());
  let handle = null;
  if (recv.getKind() === SyntaxKind.PropertyAccessExpression) handle = recv.getName();
  else if (recv.getKind() === SyntaxKind.Identifier) handle = recv.getText();
  else if (recv.getKind() === SyntaxKind.ElementAccessExpression) {
    const a = unwrapExpression(recv.getArgumentExpression());
    if (isStringish(a)) handle = a.getLiteralText();
  }
  return (handle && HANDLES.get(handle)) || null;
}

const isNullish = (n) => {
  const v = unwrapExpression(n);
  return v?.getKind() === SyntaxKind.NullKeyword || (v?.getKind() === SyntaxKind.Identifier && v.getText() === "undefined");
};

/** Properties of the literals a value can be, or null (unreadable). Spreads/computed/accessors are reported. */
function readProps(node, ctx, onOpaque) {
  const lits = objectLiterals(node, ctx);
  if (!lits) return null;
  const props = [];
  for (const lit of lits) {
    for (const prop of lit.getProperties()) {
      const k = prop.getKind();
      if (k === SyntaxKind.PropertyAssignment || k === SyntaxKind.ShorthandPropertyAssignment) {
        const name = literalName(prop.getNameNode());
        if (name === null) {
          onOpaque("computed key");
          continue;
        }
        const value = k === SyntaxKind.ShorthandPropertyAssignment ? prop.getNameNode() : prop.getInitializer();
        props.push({ name, value });
      } else {
        onOpaque(k === SyntaxKind.SpreadAssignment ? "spread" : "accessor/method");
      }
    }
  }
  return props;
}

const opaqueFor = (model, res, what) => (detail) => {
  if (TOKEN_MODELS.has(model)) res.opaque.push(`${model} ${what}: ${detail}`);
};

function readWhere(node, model, res, ctx) {
  if (isNullish(node)) return;
  const opaque = opaqueFor(model, res, "where");
  const props = readProps(node, ctx, opaque);
  if (!props) return opaque("not an object literal");
  walkWhereProps(props, model, res, ctx);
}

function walkWhereProps(props, model, res, ctx) {
  const opaque = opaqueFor(model, res, "where");
  for (const { name, value } of props) {
    if (DIGEST_KEYS.has(name)) {
      res.lookup = true;
      continue;
    }
    if (LOGICAL.has(name)) {
      const v = unwrapExpression(value);
      if (v?.getKind() === SyntaxKind.ArrayLiteralExpression) {
        for (const el of v.getElements()) {
          if (el.getKind() === SyntaxKind.SpreadElement) opaque(`${name} spread`);
          else readWhere(el, model, res, ctx);
        }
      } else readWhere(value, model, res, ctx);
      continue;
    }
    const field = MODELS.get(model)?.get(name);
    if (field && MODELS.has(field.type)) readRelationFilter(value, field.type, res, ctx);
  }
}

function readRelationFilter(node, related, res, ctx) {
  if (isNullish(node)) return;
  const opaque = opaqueFor(related, res, "relation filter");
  const props = readProps(node, ctx, opaque);
  if (!props) return opaque("not an object literal");
  if (props.length > 0 && props.every((p) => RELATION_FILTERS.has(p.name))) {
    for (const { value } of props) readWhere(value, related, res, ctx);
  } else {
    walkWhereProps(props, related, res, ctx); // a direct to-one filter
  }
}

/** { lookup, opaque[] } for one delegate call on `model`. */
function readCall(call, model, ctx) {
  const res = { lookup: false, opaque: [] };
  const args = call.getArguments();
  if (args.length === 0) return res;
  const opaque = opaqueFor(model, res, "argument");
  if (args[0].getKind() === SyntaxKind.SpreadElement) {
    opaque("spread");
    return res;
  }
  const props = readProps(args[0], ctx, opaque);
  if (!props) {
    opaque("not an object literal");
    return res;
  }
  for (const { name, value } of props) if (name === "where") readWhere(value, model, res, ctx);
  return res;
}

// ─── per-use-gated predicate ─────────────────────────────────

function isOkFalseLiteral(expr) {
  const v = unwrapExpression(expr);
  if (v?.getKind() !== SyntaxKind.ObjectLiteralExpression) return false;
  const props = v.getProperties();
  if (props.some((p) => p.getKind() !== SyntaxKind.PropertyAssignment && p.getKind() !== SyntaxKind.ShorthandPropertyAssignment)) return false;
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
const analysed = new Map(); // key -> { rel, name, fn, lookups, opaque: [], lines: [] }
const exportedConsts = new Set();
const exemptionPairs = [];

const EXT_FILE_REL = (rel) => moduleOf(rel) === EXT_MODULE;

for (const { rel, sf } of sourceFiles(project, join(ROOT, SCAN_ROOT), ROOT)) {
  let bindings;
  const file = { sf, rel, bindingsFor: () => (bindings ??= bindingIndex(sf)), imports: importsOf(sf, rel) };
  files.set(rel, file);
  const ctx = { bindingsFor: file.bindingsFor };

  for (const stmt of sf.getVariableStatements()) {
    if (stmt.isExported()) for (const d of stmt.getDeclarations()) exportedConsts.add(d.getName());
  }

  // Digest lookups and opaque wheres.
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const model = delegateModel(call);
    if (!model) continue;
    const res = readCall(call, model, ctx);
    if (!res.lookup && res.opaque.length === 0) continue;
    const at = attribute(call);
    if (!at) {
      failAt(rel, call, `token-model lookup cannot be attributed to a named function, method or exported const`);
      continue;
    }
    const key = `${rel}#${at.name}`;
    if (!analysed.has(key)) analysed.set(key, { rel, name: at.name, fn: at.fn, file, sites: 0, lookups: 0, opaque: [], lines: [] });
    const a = analysed.get(key);
    // One site per call: a call that is both a lookup and opaque counts once.
    a.sites += 1;
    if (res.lookup) a.lookups += 1;
    if (res.opaque.length > 0) a.opaque.push(`line ${call.getStartLineNumber()}: ${res.opaque.join(", ")}`);
    a.lines.push(call.getStartLineNumber());
  }

  // Raw SQL: the digest columns in any literal text, and unreadable SQL arguments.
  for (const lit of [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.TemplateHead),
    ...sf.getDescendantsOfKind(SyntaxKind.TemplateMiddle),
    ...sf.getDescendantsOfKind(SyntaxKind.TemplateTail),
  ]) {
    if (DIGEST_COLUMN.test(lit.getText())) failAt(rel, lit, `literal text names a digest column (token_hash/code_hash): raw SQL digest lookups are refused`);
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
      if (
        a?.getKind() === SyntaxKind.CallExpression &&
        a.getExpression().getText() === "renderSql" &&
        a.getArguments().length === 1 &&
        a.getArguments()[0].getKind() === SyntaxKind.TaggedTemplateExpression &&
        a.getArguments()[0].getTag().getText() === "trustedSql"
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
    let arg = unwrapExpression(call.getArguments()[0]);
    if (arg?.getKind() === SyntaxKind.Identifier) {
      const d = visibleBinding(arg.getText(), arg, file.bindingsFor);
      const init = d?.getKind() === SyntaxKind.VariableDeclaration && d.getVariableStatement?.()?.getDeclarationKind() === "const" ? unwrapExpression(d.getInitializer()) : null;
      arg = isStringish(init) ? init : arg;
    }
    // A template whose fixed tail ends in `.json` can only load JSON, never the module.
    if (arg?.getKind() === SyntaxKind.TemplateExpression && /\.json$/.test(arg.getTemplateSpans().at(-1).getLiteral().getLiteralText())) continue;
    if (!isStringish(arg)) {
      failAt(rel, call, `dynamic import/require with a specifier this gate cannot read: it could reach ${EXT_FN}`);
      continue;
    }
    if (resolveSpecifier(rel, arg.getLiteralText()) === EXT_MODULE && !isExtFile) {
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
if (!gateFile?.sf.getFunction(GATE_FN)?.isExported()) fatal(`${GATE_MODULE}.ts does not export function ${GATE_FN}.`);
const extFile = fileByModule(EXT_MODULE);
if (!extFile?.sf.getFunction(EXT_FN)?.isExported()) fatal(`${EXT_MODULE}.ts does not export function ${EXT_FN}.`);
if (!fileByModule(EXT_TYPES_MODULE)?.sf.getVariableDeclaration(EXEMPTION_CONST)) fatal(`${EXT_TYPES_MODULE}.ts does not declare ${EXEMPTION_CONST}.`);

// ─── Manifest adjudication ───────────────────────────────────

/** The named function `key` (`<path>#<name>`) designates, if it exists. */
function findNamedFunction(key) {
  const [rel, name] = key.split("#");
  const file = files.get(rel);
  if (!file || !name) return null;
  for (const node of file.sf.getDescendants()) {
    if (!FN_LIKE.has(node.getKind())) continue;
    const at = attribute(node.getFirstDescendant() ?? node);
    if (at?.name === name && at.fn === node) return { node, file };
  }
  return null;
}

for (const [key, a] of analysed) {
  const entry = ENTRIES.get(key);
  const calls = a.sites;
  const where = `${key} (lines ${a.lines.join(", ")})`;
  if (!entry) {
    failures.push(`UNLISTED: ${where} — ${a.lookups} digest lookup(s), ${a.opaque.length} opaque site(s)${a.opaque.length ? `: ${a.opaque.join("; ")}` : ""}. Classify it in ${MANIFEST_PATH}.`);
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
    failures.push(`OPAQUE_WHERE: ${key} has a where this gate cannot read (${a.opaque.join("; ")}) — a human classifies it as opaque-where.`);
  }
  if (entry.class === "opaque-where" && a.opaque.length === 0) {
    failures.push(`STALE_OPAQUE: ${key} is opaque-where but every where it has is now readable — reclassify it.`);
  }
  if (entry.class === "per-use-gated") {
    const why = perUseGatedViolation(a.fn, a.file);
    if (why) failures.push(`NOT_GATED: ${key} is per-use-gated but ${why}.`);
  }
  if (entry.class === "refresh-bound") {
    if (typeof entry.refreshRoute !== "string" || !existsSync(join(ROOT, entry.refreshRoute))) {
      failures.push(`BAD_ENTRY: ${key} is refresh-bound but its refreshRoute ${JSON.stringify(entry.refreshRoute)} does not exist.`);
    }
    if (typeof entry.lifetime !== "string" || !exportedConsts.has(entry.lifetime)) {
      failures.push(`BAD_ENTRY: ${key} is refresh-bound but its lifetime ${JSON.stringify(entry.lifetime)} is not an exported const under ${SCAN_ROOT}/.`);
    }
    for (const g of entry.inlineGate === undefined ? [] : [].concat(entry.inlineGate)) {
      const found = typeof g === "string" ? findNamedFunction(g) : null;
      const gated = found?.node
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .some((c) => INLINE_GATE_FNS.has(c.getExpression().getText()));
      if (!gated) failures.push(`BAD_ENTRY: ${key} relies on inline gate ${JSON.stringify(g)}, which does not exist or does not call ${[...INLINE_GATE_FNS].join("/")}.`);
    }
  }
}
for (const key of ENTRIES.keys()) {
  if (!analysed.has(key)) failures.push(`STALE_ENTRY: ${key} is in the manifest but no digest lookup or opaque where is attributed to it.`);
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
