#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): narrative taken from a caught value must not reach
 * an audit `metadata` field. Reduce it to a token first — the convention in
 * this tree is `SOMETHING_FAILED:${errorLogFields(err).code}`.
 *
 * THE SECOND SINK. check-caught-error-logging.mjs covers one audience: a caught
 * value handed to a structured LOGGER, read by operators. `audit_logs.metadata`
 * is a second one with a WIDER audience — tenants read it through
 * /api/tenant/audit-logs — and it is durable rather than rotated. Neither of the
 * two controls on that path reaches the value's text: `sanitizeMetadata` removes
 * keys in METADATA_BLOCKLIST by NAME at any depth, and `truncateMetadata` only
 * bounds the JSON's size. That is the same shape as pino's redact-by-key, and it
 * is why a message can pass both untouched.
 *
 * WHY THIS GATE RATHER THAN THE SIBLING'S SCAN. The sibling anchors on a logger
 * CALL and reads its field object, so it cannot see a value that leaves the
 * catch block in a variable and is persisted after the block closes. Both sites
 * fixed in #805 were exactly that shape, and its header names them under MISSED.
 * Widening the sibling would not have worked either: the defect is not a
 * spelling at the call site, it is a data path across statements. So this gate
 * tracks the path instead.
 *
 * THE CLASS IS DERIVED, NOT LISTED. Its defining primitive is "narrative
 * extracted from a `catch` binding" — `.message`, `.stack`, `String(x)`,
 * `` `${x}` ``, `x + "…"`, `JSON.stringify(x)` — regardless of where it goes.
 * Measured over src+scripts: 67 such extractions, of which 26 are sentinel
 * comparisons (`err.message === "SCIM_RESOURCE_EXISTS"` and one `switch`),
 * 13 are client-side `setError`/`setFetchError`/`onError` (browser only), 17 go
 * to CLI stderr or are already reduced, and the remainder reach an HTTP response
 * body. The sentinel cases are structurally distinct — a comparison against a
 * literal, not an extraction into a value — which is what makes the durable-sink
 * subset separable without a hand-maintained exemption list.
 *
 * CONTROL CLASS (R49): fail-closed verification gate over a BOUNDED scan root.
 * NOT an enforceable boundary — bypassable by editing the gate, by laundering
 * the value through a shape it does not model (see MISSED), or by adding code
 * outside SEARCH_DIRS.
 *
 * Measured against the tree at f5dacefb3^ (before #805 reduced them) and against
 * the tree after, with the SAME 1042 files and 315 catch clauses scanned either
 * way — so the difference is the rule and not the scope:
 *   CAUGHT   the two #805 sites, and nothing else: rotate-master-key/execute's
 *            `shareRevocationError` (assigned in the catch, persisted 30 lines
 *            later) and audit-anchor-publisher's `failureReason` (via `reason`).
 *            Also: a direct `metadata: { r: err.message }` inside the catch, a
 *            multi-hop launder, a `metadata` shorthand, and a value routed
 *            through a builder call.
 *   PASSES   `errorLogFields(err)` and tokens derived from it; a sentinel
 *            comparison or `switch` on `err.message`; a narrative that never
 *            reaches a `metadata` field; and — the case that made the resolution
 *            rule load-bearing — a DIFFERENT binding of the same name declared
 *            in a nested scope. The anchor publisher has an inner
 *            `catch (uploadErr) { const reason = `${dest.name}_UPLOAD_FAILED` }`
 *            under the same function as the outer catch's tainted `reason`;
 *            resolving by name across the function reported its SUCCESS audit
 *            event as a violation. Measured: function-wide name matching gives
 *            3 findings on that tree, innermost-binder-first gives the 2 real
 *            ones.
 *   MISSED   laundering through a MODULE-level binding (the walk is bounded by
 *            the catch's enclosing function, deliberately — see the resolution
 *            note); through an object PROPERTY (`o.reason = err.message`) or an
 *            array element; through a helper's return value, which needs a call
 *            graph this gate runs without; and a `metadata` object assembled by
 *            a function in another file. Narrative reaching an HTTP response
 *            body is out of scope by audience, not by oversight — that is a
 *            different threat model and is not adjudicated here.
 *
 * Runs without a Program (in-memory project).
 */
import { SyntaxKind } from "ts-morph";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAstProject,
  sourceFilesFrom,
  unresolvedTargets,
} from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.AUDIT_METADATA_NARRATIVE_ROOT
  ? process.env.AUDIT_METADATA_NARRATIVE_ROOT
  : join(__dirname, "..", "..");

// Env pollution guard, same reasoning as the sibling gate: the overrides exist
// for the self-test, and left ungated they are a way to silently NARROW what CI
// examines. The `scanned === 0` floor fails loudly; a wrong-but-non-empty scope
// prints OK.
const HAS_OVERRIDE =
  Boolean(process.env.AUDIT_METADATA_NARRATIVE_ROOT) ||
  Boolean(process.env.AUDIT_METADATA_NARRATIVE_DIRS);
if (
  process.env.CI === "true" &&
  HAS_OVERRIDE &&
  process.env.AUDIT_METADATA_NARRATIVE_FIXTURE_MODE !== "1"
) {
  console.error(
    "check-audit-metadata-narrative: AUDIT_METADATA_NARRATIVE_ROOT/DIRS must not " +
      "be set in CI (they would narrow the scan). Set " +
      "AUDIT_METADATA_NARRATIVE_FIXTURE_MODE=1 only from the self-test.",
  );
  process.exit(1);
}

// src AND scripts: `scripts/audit-anchor-publisher.ts` is a worker entrypoint
// that emits audit events, so an app-only root would exclude an emitter.
const SEARCH_DIRS = (
  process.env.AUDIT_METADATA_NARRATIVE_DIRS ?? "src,scripts"
)
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

const REDUCER = "errorLogFields";

/**
 * The sink is any property named `metadata`, not the argument of a named list
 * of audit emitters.
 *
 * Keying on `logAuditAsync` / `logAuditInTx` / `logAuditBulkAsync` would make
 * the member set a hand-maintained list — the failure mode this whole line of
 * work exists to stop, and one a new wrapper silently escapes. `metadata` is the
 * field name the payload carries all the way to the column, so anchoring on it
 * covers the emitters, their wrappers, and the outbox payload builders alike.
 * It also covers a few non-audit `metadata` fields, which is a cost worth
 * paying: free-form caught-error text does not belong in any of them.
 */
const SINK_PROPERTY = "metadata";

const FN_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
]);

function fail(msg) {
  console.error(`check-audit-metadata-narrative: ${msg}`);
  process.exit(1);
}

/**
 * The catch clause's nearest enclosing function — the bound of the taint walk.
 *
 * Not the file. A file-wide walk resolves a name against another function's
 * binding, which is fail-OPEN in the direction that matters here: it clears a
 * real sink whenever some unrelated function happens to rebind the name.
 */
function enclosingFunction(node) {
  for (let cur = node.getParent(); cur; cur = cur.getParent()) {
    if (FN_KINDS.has(cur.getKind())) return cur;
  }
  return node.getSourceFile();
}

/** True when `node` sits inside an `errorLogFields(...)` call's arguments. */
function insideReducer(node) {
  for (let cur = node.getParent(); cur; cur = cur.getParent()) {
    if (
      cur.getKind() === SyntaxKind.CallExpression &&
      cur.getExpression().getText() === REDUCER
    ) {
      return true;
    }
  }
  return false;
}

/** True when `id` NAMES a property rather than reading a binding. */
function isPropertyName(id) {
  const p = id.getParent();
  if (!p) return false;
  switch (p.getKind()) {
    case SyntaxKind.PropertyAccessExpression:
      return p.getNameNode() === id;
    case SyntaxKind.PropertyAssignment:
      return p.getNameNode() === id;
    case SyntaxKind.BindingElement:
      return p.getNameNode() === id;
    default:
      return false;
  }
}

/**
 * The declaration `id` binds to, resolved from the identifier OUTWARD with the
 * innermost binder winning.
 *
 * `null` means the walker found none — a parameter destructured out of an outer
 * closure, an import, a module-level binding. Callers treat that as UNRESOLVED
 * and fail closed, because "I could not bind this name" must not be spelled the
 * same as "this name is a different, safe binding".
 */
function resolveDeclaration(id) {
  const name = id.getText();
  for (let cur = id.getParent(); cur; cur = cur.getParent()) {
    if (cur.getKind() === SyntaxKind.CatchClause) {
      const d = cur.getVariableDeclaration();
      if (d && d.getNameNode().getText() === name) return d;
    }
    if (FN_KINDS.has(cur.getKind())) {
      for (const p of cur.getParameters()) {
        if (p.getNameNode().getText() === name) return p;
      }
    }
    if (typeof cur.getStatements === "function") {
      for (const stmt of cur.getStatements()) {
        if (stmt.getKind() !== SyntaxKind.VariableStatement) continue;
        for (const d of stmt.getDeclarations()) {
          if (d.getNameNode().getText() === name) return d;
        }
      }
    }
  }
  return null;
}

/**
 * Expressions inside `clause` that turn the caught binding into free-form text.
 *
 * A read wrapped in `errorLogFields(...)` is not one: that call returns a fresh
 * `{ name, code }` whose fields are token-shaped, which is the whole point of
 * the reducer. So `` `X_FAILED:${errorLogFields(err).code}` `` seeds nothing,
 * while `` `X_FAILED:${err.message}` `` seeds the template.
 */
function narrativeSeeds(clause, boundDecl) {
  const seeds = new Set();
  const name = boundDecl.getNameNode().getText();

  for (const id of clause.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== name) continue;
    if (isPropertyName(id) || insideReducer(id)) continue;
    // A nested `catch (err)` or a `const err = …` rebinds the name; the read
    // there is not the caught value this clause introduced.
    if (resolveDeclaration(id) !== boundDecl) continue;

    // Walk out to the smallest enclosing expression that produces text.
    for (let cur = id; cur && cur !== clause; cur = cur.getParent()) {
      const k = cur.getKind();
      if (k === SyntaxKind.PropertyAccessExpression) {
        const n = cur.getName();
        if (n === "message" || n === "stack") {
          seeds.add(cur);
          break;
        }
        continue; // `err.cause.message` — keep walking out
      }
      if (k === SyntaxKind.CallExpression) {
        const fn = cur.getExpression().getText();
        if (fn === "String" || fn === "JSON.stringify") seeds.add(cur);
        break;
      }
      if (k === SyntaxKind.TemplateExpression) {
        seeds.add(cur);
        break;
      }
      if (k === SyntaxKind.BinaryExpression) {
        if (cur.getOperatorToken().getKind() === SyntaxKind.PlusToken) seeds.add(cur);
        break;
      }
    }
  }
  return seeds;
}

function containsNode(outer, inner) {
  return (
    outer.getSourceFile() === inner.getSourceFile() &&
    inner.getStart() >= outer.getStart() &&
    inner.getEnd() <= outer.getEnd()
  );
}

/**
 * Does `node` carry narrative — a seed expression, or a reference binding to one
 * of the tainted declarations?
 */
function carriesNarrative(node, seeds, taintedDecls) {
  for (const s of seeds) if (containsNode(node, s)) return true;
  if (taintedDecls.size === 0) return false;

  const names = new Set();
  for (const d of taintedDecls) names.add(d.getNameNode().getText());

  const ids =
    node.getKind() === SyntaxKind.Identifier
      ? [node]
      : node.getDescendantsOfKind(SyntaxKind.Identifier);
  for (const id of ids) {
    if (!names.has(id.getText()) || isPropertyName(id)) continue;
    const d = resolveDeclaration(id);
    if (d === null || taintedDecls.has(d)) return true; // unresolved fails closed
  }
  return false;
}

/** The value node of a `metadata` property, or null if the property is not one. */
function metadataValue(prop) {
  if (prop.getKind() === SyntaxKind.PropertyAssignment) {
    if (prop.getName() !== SINK_PROPERTY) return null;
    return prop.getInitializer() ?? null;
  }
  if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
    // `logAuditAsync({ …, metadata })` — the value is the binding itself.
    if (prop.getName() !== SINK_PROPERTY) return null;
    return prop.getNameNode();
  }
  return null;
}

{
  const missing = unresolvedTargets(SEARCH_DIRS, REPO_ROOT);
  if (missing.length > 0) {
    fail(
      `scan target(s) resolved to no source file: ${missing.join(", ")} — ` +
        `moved, renamed, or misspelled. A target the gate cannot find is not a ` +
        `target it may skip.`,
    );
  }
}

const project = createAstProject();
const violations = [];
let scanned = 0;
let catchClauses = 0;
let metadataProps = 0;

for (const { rel: path, sf } of sourceFilesFrom(project, SEARCH_DIRS, REPO_ROOT)) {
  if (
    path.includes("__tests__") ||
    path.includes("__fixtures__") ||
    /\.test\.tsx?$/.test(path)
  ) {
    continue;
  }
  scanned++;

  // Counted over the WHOLE file, not only inside tainted functions: this is the
  // gate's subject floor, and it must not move with the findings.
  for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (prop.getName() === SINK_PROPERTY) metadataProps++;
  }
  for (const prop of sf.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)) {
    if (prop.getName() === SINK_PROPERTY) metadataProps++;
  }

  for (const clause of sf.getDescendantsOfKind(SyntaxKind.CatchClause)) {
    const boundDecl = clause.getVariableDeclaration();
    if (!boundDecl) continue;
    if (boundDecl.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
    catchClauses++;

    const seeds = narrativeSeeds(clause, boundDecl);
    if (seeds.size === 0) continue;

    const scope = enclosingFunction(clause);
    const taintedDecls = new Set();

    // Fixed point over the enclosing function. Bounded rather than `while`: a
    // gate that can loop forever on a pathological input is a CI hang, and the
    // chains this models are 1-3 hops.
    for (let pass = 0; pass < 8; pass++) {
      const before = taintedDecls.size;
      for (const d of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const init = d.getInitializer();
        if (init && carriesNarrative(init, seeds, taintedDecls)) taintedDecls.add(d);
      }
      for (const be of scope.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (be.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
        const lhs = be.getLeft();
        if (lhs.getKind() !== SyntaxKind.Identifier) continue;
        if (!carriesNarrative(be.getRight(), seeds, taintedDecls)) continue;
        const d = resolveDeclaration(lhs);
        if (d) taintedDecls.add(d);
      }
      if (taintedDecls.size === before) break;
    }

    const props = [
      ...scope.getDescendantsOfKind(SyntaxKind.PropertyAssignment),
      ...scope.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment),
    ];
    for (const prop of props) {
      const value = metadataValue(prop);
      if (!value) continue;
      if (!carriesNarrative(value, seeds, taintedDecls)) continue;
      const via =
        [...taintedDecls].map((d) => d.getNameNode().getText()).join(", ") ||
        "the catch binding directly";
      violations.push({
        path,
        line: prop.getStartLineNumber(),
        bound: boundDecl.getNameNode().getText(),
        via,
      });
    }
  }
}

if (scanned === 0) {
  fail(
    `scanned 0 source files under ${SEARCH_DIRS.join(", ")} — scan root is ` +
      `wrong or the tree moved`,
  );
}
if (catchClauses === 0) {
  fail(
    `recognised 0 catch clauses under ${SEARCH_DIRS.join(", ")} — the gate is ` +
      `not seeing half its subject`,
  );
}
if (metadataProps === 0) {
  // The other half. A gate that recognises every catch and no sink prints the
  // same OK as one with nothing to report, and the two mean opposite things.
  fail(
    `recognised 0 \`${SINK_PROPERTY}\` properties under ${SEARCH_DIRS.join(", ")} — ` +
      `the audit payload field was renamed, or the gate is not seeing its sink`,
  );
}

console.log(
  `check-audit-metadata-narrative: scanned ${scanned} files, ${catchClauses} ` +
    `catch clauses, ${metadataProps} ${SINK_PROPERTY} properties`,
);

if (violations.length > 0) {
  console.error(
    `\ncheck-audit-metadata-narrative: ${violations.length} caught-error ` +
      `narrative(s) reaching an audit \`${SINK_PROPERTY}\` field:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.path}:${v.line}  catch (${v.bound})  ->  via ${v.via}`);
  }
  console.error(
    `\naudit_logs.metadata is durable and tenant-readable (/api/tenant/audit-logs),
and neither control on that path reads the value's text: sanitizeMetadata drops
blocklisted KEYS, truncateMetadata bounds SIZE. A pg error's message names the DB
role and host; a Prisma error's names the failing statement and its bound
parameters. Reduce it to a token:

    SOMETHING_FAILED:\${${REDUCER}(err).code}      // from @/lib/logger/error-fields

Keep the full reduced pair on the LOG line beside it if diagnosis needs the name.\n`,
  );
  process.exit(1);
}

console.log("check-audit-metadata-narrative: OK");
