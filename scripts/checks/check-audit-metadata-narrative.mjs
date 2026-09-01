#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): narrative taken from a caught value must not reach
 * any of the audit payload's free-text fields (SINK_PROPERTIES below — seven of
 * them, not `metadata` alone). Reduce it to a token first — the convention in
 * this tree is `SOMETHING_FAILED:${errorLogFields(err).code}`.
 *
 * THE SECOND SINK. check-caught-error-logging.mjs covers one audience: a caught
 * value handed to a structured LOGGER, read by operators. The audit row is a
 * second one with a WIDER audience — tenants read it through
 * /api/tenant/audit-logs — and it is durable rather than rotated. Neither of the
 * two controls on that path reaches the value's text: `sanitizeMetadata` removes
 * keys in METADATA_BLOCKLIST by NAME at any depth, and `truncateMetadata` only
 * bounds the JSON's size. That is the same shape as pino's redact-by-key, and it
 * is why a message can pass both untouched — and both controls act on `metadata`
 * only, so for the other six sinks there is no control on the path at all.
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
 * the tree after, with the SAME 1040 files and 315 catch clauses scanned either
 * way — so the difference is the rule and not the scope:
 *   CAUGHT   the two #805 sites, and nothing else: rotate-master-key/execute's
 *            `shareRevocationError` (assigned in the catch, persisted 30 lines
 *            later) and audit-anchor-publisher's `failureReason` (via `reason`).
 *            Also: a direct `metadata: { r: err.message }` inside the catch, a
 *            multi-hop launder, a `metadata` shorthand, and a value routed
 *            through a builder call.
 *   PASSES   `errorLogFields(err)` and tokens derived from it; a sentinel
 *            comparison or `switch` on `err.message`; a narrative that never
 *            reaches ANY sink field; and — the case that made the resolution
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
 *            a function in another file. Also the POSITIONAL-ARGUMENT shape: an
 *            object built under one name and passed to a callee whose PARAMETER
 *            is the sink. The live instance is the outbox worker's error
 *            recorder — it assembles the object itself and passes it positionally
 *            — so neither the sink-property anchor nor the catch-bounded taint
 *            walk sees it, and that path is how a `22P02` message carrying a
 *            narrative from `teamId`/`serviceAccountId` reaches `audit_logs`
 *            after max attempts. It is the reason those two fields are sinks
 *            here at all. Narrative reaching an HTTP response body is out of
 *            scope by audience, not by oversight — a different threat model,
 *            not adjudicated here.
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
 * The sinks are PROPERTY NAMES, not the arguments of a named list of audit
 * emitters.
 *
 * Keying on `logAuditAsync` / `logAuditInTx` / `logAuditBulkAsync` would make
 * the member set a hand-maintained list — the failure mode this whole line of
 * work exists to stop, and one a new wrapper silently escapes. These are the
 * field names the payload carries all the way to the row, so anchoring on them
 * covers the emitters, their wrappers, and the outbox payload builders alike.
 * They also cover a few non-audit fields of the same name, which is a cost worth
 * paying: free-form caught-error text does not belong in any of them.
 *
 * WHY SEVEN AND NOT ONE. `metadata` was the original anchor, on the argument
 * that it is the field the payload carries to the column. True, and not
 * exclusive — `buildOutboxPayload` carries six more free-text fields to the same
 * tenant-readable row. Two of them, `teamId` and `serviceAccountId`, were
 * adjudicated OUT twice on "a narrative there raises 22P02, so no row reaches
 * audit_logs": the premise holds and the conclusion does not, because PostgreSQL
 * embeds the offending text in the 22P02 message and the worker's error recorder
 * writes that message into `metadata.lastError` once attempts are exhausted. The
 * narrative arrives at the same sink, eight attempts later.
 *
 * OUT, each for a mechanism that actually holds: `scope`, `action`, `actorType`
 * are enum-typed on both sides; `userId` reaches the worker's own guards, which
 * hand the error recorder a CONSTRUCTED constant rather than the input; and
 * `tenantId` fails at the app-side enqueue — inside `logAuditAsync`'s try, whose
 * catch is log-only, or by aborting the caller's transaction — so it never
 * reaches a tenant-readable row. `tenantId`'s reason is not the others'.
 */
const SINK_PROPERTIES = ["metadata", "targetType", "targetId", "userAgent", "ip", "teamId", "serviceAccountId"];
const SINK_SET = new Set(SINK_PROPERTIES);
const SINK_LABEL = SINK_PROPERTIES.map((p) => `\`${p}\``).join(", ");

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

/** The value node of a sink property, or null if the property is not one. */
function metadataValue(prop) {
  if (prop.getKind() === SyntaxKind.PropertyAssignment) {
    if (!SINK_SET.has(prop.getName())) return null;
    return prop.getInitializer() ?? null;
  }
  if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
    // `logAuditAsync({ …, metadata })` — the value is the binding itself.
    if (!SINK_SET.has(prop.getName())) return null;
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
// Per-sink, because the floor below is per-sink. Object.fromEntries rather than
// a bare object so adding a member to SINK_PROPERTIES cannot leave a counter
// undefined and its floor silently un-checkable.
const sinkCounts = Object.fromEntries(SINK_PROPERTIES.map((p) => [p, 0]));

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
    const n = prop.getName();
    if (SINK_SET.has(n)) { metadataProps++; sinkCounts[n]++; }
  }
  for (const prop of sf.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)) {
    const n = prop.getName();
    if (SINK_SET.has(n)) { metadataProps++; sinkCounts[n]++; }
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
        // Which sink matched. Without it the report names one field while the
        // gate refuses on seven, and the self-test's detection predicate cannot
        // tell a targetId violation from a metadata one — the lossy-channel
        // shape this gate's own refusal booleans were split to remove.
        sink: prop.getName(),
      });
    }
  }
}

// Reachable, but only by one construction — worth stating, because the obvious
// reading is that this floor is dead code and the obvious next edit is to delete
// it. It fires when every collected file is skipped IN-LOOP, which today means a
// root whose files all sit under a `__fixtures__` segment: the walker excludes
// `*.test.*` and `__tests__/` at collection time, so those never reach `scanned`
// at all. Every other way of getting here is caught earlier or later:
// upstream by `unresolvedTargets` (a target that collects zero files refuses
// before the loop, so "point it at an empty directory" lands there, not here),
// downstream by the catch-clause floor. The self-test pins the one live path.
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
// The other half, and it is PER SINK rather than over the total. A sum cannot
// see one field go to zero: rename `ip` and 610 of the other properties keep the
// aggregate comfortably non-zero, so the floor stays silent while the gate has
// quietly stopped watching a sink. Measured, not assumed — that is the shape
// this floor exists to catch.
const unseenSinks = SINK_PROPERTIES.filter((p) => sinkCounts[p] === 0);
if (unseenSinks.length > 0) {
  fail(
    `recognised 0 ${unseenSinks.map((p) => `\`${p}\``).join(", ")} ` +
      `properties under ${SEARCH_DIRS.join(", ")} — the audit payload field was ` +
      `renamed, or the gate is not seeing that sink`,
  );
}

console.log(
  `check-audit-metadata-narrative: scanned ${scanned} files, ${catchClauses} ` +
    `catch clauses, ${metadataProps} sink properties (` +
    SINK_PROPERTIES.map((p) => `${p} ${sinkCounts[p]}`).join(", ") +
    `)`,
);

if (violations.length > 0) {
  console.error(
    `\ncheck-audit-metadata-narrative: ${violations.length} caught-error ` +
      `narrative(s) reaching an audit sink field (${SINK_LABEL}):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.path}:${v.line}  \`${v.sink}\`  catch (${v.bound})  ->  via ${v.via}`);
  }
  console.error(
    `\nEvery field above lands in a durable, tenant-readable audit_logs row
(/api/tenant/audit-logs). What differs is only HOW it gets there, and none of
the routes is safe:

  metadata          — sanitizeMetadata drops blocklisted KEYS and
                      truncateMetadata bounds SIZE; neither reads the text.
  targetType/targetId — unbounded text columns, no sanitizer at all.
  userAgent         — length-bounded only.
  ip                — VarChar(45): under that length it lands verbatim; over it
                      the insert raises 22001 and the audit event is LOST.
  teamId/serviceAccountId — uuid columns, so the insert raises 22P02 — and
                      Postgres puts the offending text IN the error message,
                      which the outbox worker's recordError then writes to
                      audit_logs.metadata.lastError. It arrives anyway, 8
                      attempts later, under AUDIT_OUTBOX_DEAD_LETTER.

A pg error's message names the DB role and host; a Prisma error's names the
failing statement and its bound parameters. Reduce it to a token:

    SOMETHING_FAILED:\${${REDUCER}(err).code}      // from @/lib/logger/error-fields

Keep the full reduced pair on the LOG line beside it if diagnosis needs the name.\n`,
  );
  process.exit(1);
}

console.log("check-audit-metadata-narrative: OK");
