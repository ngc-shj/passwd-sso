#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): a read or write against an RLS-protected table from
 * a worker or one-shot script must run inside a transaction that established an
 * RLS context — `$transaction` + `setBypassRlsGucs`, `withBypassRls`, or
 * `withTenantRls`. A statement issued on the top-level client instead is
 * evaluated with `app.tenant_id` unset (or reverted to '' after an earlier
 * transaction on that pooled connection), and the tenant_isolation policy then
 * either returns ZERO ROWS WITH NO ERROR or raises 22P02.
 *
 * Why this gate exists, and why it is not check-bypass-rls.mjs: that gate is an
 * ALLOWLIST over `withBypassRls` usage — it answers "who may bypass", and it
 * only parses files that mention one of its four helper NAMES. It is therefore
 * structurally unable to report a MISSING context, which is the defect class
 * that actually shipped three times:
 *   - audit-outbox-worker checkDepthAlert       (22P02 every 30s in production)
 *   - audit-outbox-worker processDeliveryBatch  (same, latent)
 *   - audit-chain-verify-worker                 (0 rows, silent, control inert)
 * Two of those live in a file the name-prefilter skipped, and the third is in
 * `scripts/`, which that gate does not scan at all. Matching spellings could not
 * close this; the mechanism had to change.
 *
 * CONTROL CLASS (R49): fail-closed verification gate over a BOUNDED scan root.
 * NOT an enforceable boundary — it is bypassable by editing the gate or by
 * adding code outside SEARCH_DIRS.
 *
 * Every entry below was measured against a synthetic tree, not assumed:
 *
 *   CAUGHT   bare model read; bare raw call; tagged-template raw; bare
 *            `$transaction` whose callback never sets the GUC; SQL the gate
 *            cannot read (reported as UNRESOLVED rather than skipped);
 *            client alias chains (`const p = prisma`, and chains up to
 *            ALIAS_HOP_LIMIT hops), INCLUDING a chain whose name is also bound
 *            to a transaction client in a sibling scope — bindings resolve from
 *            the statement outward, so a shadowing declaration elsewhere in the
 *            file cannot clear a bare-client read; model-accessor alias
 *            (`const m = prisma.auditOutbox`); `this.prisma.<model>`; element access on
 *            either half (`prisma["auditLog"].findMany`, `prisma.auditLog
 *            ["findMany"]`); a method or accessor DETACHED by destructuring
 *            (`const { findMany } = prisma.auditOutbox`, `const { auditOutbox }
 *            = prisma`, and the renamed form `{ findMany: fm }`)
 *   PASSES   context helpers; `$transaction` + setBypassRlsGucs; a parameter
 *            typed TransactionClient/TxClient/RawExecutor; every indirect
 *            spelling above when the chain ends at a context binding
 *   MISSED   a client reached through a data structure, a computed key
 *            (`prisma[name]`), or a returned closure; a GUC established through
 *            an element-access raw call (`tx["$executeRaw"]`) — fail-CLOSED, it
 *            reports rather than accepts; `.mjs`/`.js` files, which the shared
 *            AST helper does not treat as scannable (no `.mjs` in the scan
 *            roots issues a Prisma statement today)
 *
 * `src/app` and the rest of `src/lib` are out of scope because the app's
 * mechanism is AMBIENT, not lexical: `src/lib/prisma.ts` exports a Proxy that
 * rebinds `prisma` to the AsyncLocalStorage-active transaction, so a statement
 * written as `prisma.x.findMany()` is already tenant-scoped at runtime with
 * nothing in the syntax to show it. This gate's model is lexical, so scanning
 * there would report hundreds of false positives (measured: 310 in src/app, 67
 * in src/lib). `src/lib/health.ts` is named individually in SEARCH_DIRS anyway,
 * because that ambient argument does not reach it — see the comment there.
 *
 * Table set is DERIVED, never re-typed: manifest ∩ schema @@map.
 *
 * Runs without a Program (in-memory project).
 */
import { SyntaxKind } from "ts-morph";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAstProject,
  sourceFilesFrom,
  unresolvedTargets,
} from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.RLS_READ_CONTEXT_ROOT
  ? process.env.RLS_READ_CONTEXT_ROOT
  : join(__dirname, "..", "..");

// Env pollution guard. The overrides exist for the self-test, which drives the
// gate against a synthetic tree. Left ungated they are a way to silently NARROW
// what CI examines: `scanned === 0` fails loudly, but a wrong-but-non-empty
// scope prints OK — the same "examined nothing, reported nothing wrong" shape
// this gate exists to close. Mirrors the guard in
// check-gate-selftest-coverage.sh.
const HAS_OVERRIDE =
  Boolean(process.env.RLS_READ_CONTEXT_ROOT) ||
  Boolean(process.env.RLS_READ_CONTEXT_DIRS);
if (
  process.env.CI === "true" &&
  HAS_OVERRIDE &&
  process.env.RLS_READ_CONTEXT_FIXTURE_MODE !== "1"
) {
  console.error(
    "check-rls-read-context: RLS_READ_CONTEXT_ROOT/DIRS must not be set in CI " +
      "(they would narrow the scan). Set RLS_READ_CONTEXT_FIXTURE_MODE=1 only " +
      "from the self-test.",
  );
  process.exit(1);
}

// Directories, plus SINGLE FILES where the lexical model happens to hold (see
// the docblock on why src/lib as a whole is out of scope). sourceFilesFrom
// takes both; check-null-tenant-fail-closed mixes them the same way.
//
// src/lib/health.ts is here because it is the one src/lib member of this class
// that the ambient-Proxy argument does NOT cover: it runs from a health probe,
// outside any AsyncLocalStorage transaction, so `prisma` there really is the
// bare client. Measured: 1 violation before the fix, 0 after, no false
// positives from the file's other $queryRaw (`SELECT 1` names no RLS table).
const SEARCH_DIRS = (
  process.env.RLS_READ_CONTEXT_DIRS ?? "src/workers,scripts,src/lib/health.ts"
)
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

console.log(`check-rls-read-context: SEARCH_DIRS=${SEARCH_DIRS.join(", ")}`);


// These helpers set the GUC themselves, so their callback parameter is
// context-bearing by construction.
const CONTEXT_HELPERS = new Set([
  "withBypassRls",
  "withTenantRls",
  "withUserTenantRls",
  "withTeamTenantRls",
]);

// $transaction does NOT establish a context — it only opens a transaction. The
// GUC has to be set inside, and a $transaction whose callback never sets one is
// exactly the shape of the checkDepthAlert defect. Accepting the bare form would
// re-admit the class this gate exists to close, so it is checked separately.
const TX_OPENING = "$transaction";

// Matches set_config on an RLS GUC and captures the VALUE argument.
const GUC_SQL_RE =
  /set_config\s*\(\s*['"`]app\.(bypass_rls|tenant_id)['"`]\s*,\s*([^,]*?)\s*,/;

/**
 * True when the SQL sets an RLS GUC to something other than the empty string.
 * The empty case is excluded deliberately: `set_config('app.tenant_id','',true)`
 * IS the reverted-GUC state this gate exists to catch, not an establishment of
 * context. Checked as a captured value rather than a lookahead — `\s*,\s*`
 * backtracks past the space, so a lookahead for `''` silently misses.
 */
function setsGucNonEmpty(sql) {
  const m = GUC_SQL_RE.exec(sql);
  if (!m) return false;
  const value = m[2].trim();
  return value !== "''" && value !== '""' && value !== "``" && value !== "";
}

const MODEL_METHODS = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "findUnique",
  "findUniqueOrThrow", "count", "aggregate", "groupBy",
  "update", "updateMany", "updateManyAndReturn", "delete", "deleteMany",
  "create", "createMany", "createManyAndReturn", "upsert",
]);

const RAW_METHODS = new Set([
  "$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe",
]);

function fail(msg) {
  console.error(`check-rls-read-context: ${msg}`);
  process.exit(1);
}

/** Manifest tables — the authoritative RLS table set. */
function loadRlsTables() {
  const p = join(REPO_ROOT, "scripts/rls-cross-tenant-tables.manifest");
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    // Fail loudly: an unreadable manifest must not be spelled like an empty one.
    fail(`cannot read ${p}: ${err.message}`);
  }
  const tables = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (tables.length === 0) fail(`manifest ${p} yielded 0 tables`);
  return new Set(tables);
}

/** table -> prisma client accessor, from schema @@map. */
function loadModelAccessors(rlsTables) {
  const p = join(REPO_ROOT, "prisma/schema.prisma");
  let schema;
  try {
    schema = readFileSync(p, "utf8");
  } catch (err) {
    fail(`cannot read ${p}: ${err.message}`);
  }
  const accessors = new Map();
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = modelRe.exec(schema)) !== null) {
    const [, modelName, body] = m;
    const mapped = body.match(/@@map\("([^"]+)"\)/);
    const table = mapped ? mapped[1] : modelName;
    if (!rlsTables.has(table)) continue;
    accessors.set(modelName[0].toLowerCase() + modelName.slice(1), table);
  }
  if (accessors.size === 0) {
    fail("derived 0 RLS model accessors from prisma/schema.prisma — the manifest/schema join broke");
  }
  return accessors;
}

// A parameter carrying one of these in its type annotation IS a transaction
// client: the caller opened the transaction and threaded it in. Matched on the
// annotation text, so it needs no Program.
const TX_TYPE_RE = /\b(TransactionClient|TxClient|RawExecutor)\b/;

/**
 * Does `callback` establish an RLS GUC on the binding named `recvText`, at a
 * position before `beforeNode`?
 *
 * AST, not a text match over `getText()`. A regex over the callback source is
 * satisfied by a comment, a string literal, a setter applied to a DIFFERENT
 * binding, or a call sitting after the read in dead code — every one of which
 * re-admits the defect this rule exists to reject. Same reasoning, and same
 * shape, as hasResolvedPreflightCall.
 *
 * Returns "established" | "absent" | "unresolved".
 */
function gucEstablishedOn(callback, recvText, beforeNode) {
  const limit = beforeNode.getStart();
  let sawUndecidable = false;

  // setBypassRlsGucs(<recvText>) — the shared worker helper.
  for (const call of callback.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getStart() >= limit) continue;
    const callee = call.getExpression();
    if (callee.getText() !== "setBypassRlsGucs") continue;
    const arg0 = call.getArguments()[0];
    if (!arg0) continue;
    if (arg0.getText() === recvText) return "established";
    // Right helper, different binding: says nothing about this one.
  }

  // <recvText>.$executeRaw`... set_config('app.tenant_id', ...) ...`
  const rawNodes = [
    ...callback.getDescendantsOfKind(SyntaxKind.CallExpression),
    ...callback.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression),
  ];
  for (const n of rawNodes) {
    if (n.getStart() >= limit) continue;
    const isTagged = n.getKind() === SyntaxKind.TaggedTemplateExpression;
    const expr = isTagged ? n.getTag() : n.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    if (!RAW_METHODS.has(expr.getName())) continue;
    if (expr.getExpression().getText() !== recvText) continue;
    const sqlNode = isTagged ? n.getTemplate() : n.getArguments()[0];
    const sql = sqlNode?.getText() ?? "";
    if (setsGucNonEmpty(sql)) return "established";
    // A raw statement on this binding whose SQL we cannot read could be the
    // setter. Do not conclude "absent" from it.
    if (!/set_config/.test(sql) && /^[A-Za-z_$][\w$]*$/.test(sql.trim())) {
      sawUndecidable = true;
    }
  }

  // A call passing this binding to some other function may establish the GUC
  // out of sight (e.g. a project-local establishTenantContext(tx, ...)).
  for (const call of callback.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getStart() >= limit) continue;
    const callee = call.getExpression().getText();
    if (callee === "setBypassRlsGucs") continue;
    if (RAW_METHODS.has(call.getExpression().getLastChildByKind?.(SyntaxKind.Identifier)?.getText() ?? "")) continue;
    if (call.getArguments().some((a) => a.getText() === recvText)) {
      sawUndecidable = true;
    }
  }

  return sawUndecidable ? "unresolved" : "absent";
}

// An alias chain is followed this far before the gate gives up and reports.
// One hop covered the shapes that occur today (`const db = tx`), but a chain
// that ends at a context binding is CORRECT code, and flagging it left no
// suppression path — the pressure that gets a gate routed around. Bounded
// rather than unbounded so a pathological file cannot make the gate the slow
// step; the bound is far above any chain a reviewer would accept.
const ALIAS_HOP_LIMIT = 8;

/**
 * Where a same-file binding came from, as TEXT, or null.
 *
 * Covers both spellings, because a destructured binding is the same statement
 * with the member access moved to the left-hand side:
 *   `const p = prisma`                        -> "prisma"
 *   `const m = prisma.auditOutbox`            -> "prisma.auditOutbox"
 *   `const { findMany } = prisma.auditOutbox` -> "prisma.auditOutbox.findMany"
 *   `const { auditOutbox } = prisma`          -> "prisma.auditOutbox"
 * Rewriting the destructured forms into the member access they are equivalent
 * to means one resolver serves both, instead of a second code path that has to
 * be kept in step with this one.
 */
/** The text `decl` binds to `name`, or null if it binds some other name. */
function bindingTextFor(decl, name) {
  const init = decl.getInitializer();
  if (!init) return null;
  const nameNode = decl.getNameNode();
  if (nameNode.getKind() === SyntaxKind.Identifier) {
    return nameNode.getText() === name ? init.getText() : null;
  }
  if (nameNode.getKind() !== SyntaxKind.ObjectBindingPattern) return null;
  for (const el of nameNode.getElements()) {
    if (el.getName() !== name) continue;
    // `{ findMany: fm }` binds `fm` but reads the `findMany` property.
    const prop = el.getPropertyNameNode()?.getText() ?? el.getName();
    return `${init.getText()}.${prop.replace(/^["'`]|["'`]$/g, "")}`;
  }
  return null;
}

/**
 * The initializer text bound to `name` in the innermost scope enclosing `node`.
 *
 * SCOPE-AWARE, and that is the whole point. A file-wide "first declaration
 * wins" index reads correct until one file declares the same local name twice —
 * and then it adjudicates the SECOND statement using the FIRST's initializer:
 *
 *   async function drain(tx: TransactionClient) {
 *     const db = tx;                                  // indexed first
 *     return db.$queryRaw`... audit_outbox ...`;      // correct
 *   }
 *   async function depthAlert(tx: TransactionClient) {
 *     const db = prisma;                              // shadow, never consulted
 *     return db.$queryRaw`... audit_outbox ...`;      // NOT flagged — fail-open
 *   }
 *
 * That second function is the name and the shape of the defect this gate exists
 * to catch, and the gate cleared it. `db` has to be resolved from where the
 * STATEMENT is, not from where the file happens to declare it first.
 *
 * Walking outward also gives the right answer for free when two sibling scopes
 * declare a name and neither encloses the statement: nothing resolves, so no
 * context is proven, so the statement is reported. Unresolvable must fail
 * CLOSED here — an alias the gate cannot follow is not an alias it may assume
 * safe.
 */
function resolveBindingAt(node, name) {
  for (let cur = node.getParent(); cur; cur = cur.getParent()) {
    if (typeof cur.getStatements !== "function") continue;
    for (const stmt of cur.getStatements()) {
      if (stmt.getKind() !== SyntaxKind.VariableStatement) continue;
      for (const decl of stmt.getDeclarations()) {
        const text = bindingTextFor(decl, name);
        if (text !== null) return text;
      }
    }
  }
  return null;
}

// Splits a receiver's TEXT into client + member for BOTH access spellings.
// `prisma["auditLog"]` reaches the same table as `prisma.auditLog`, and a gate
// that reads only the dotted form reports the element-access form as clean.
const MEMBER_TEXT_RE =
  /^(.*)(?:\.([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])$/;

/** { clientText, member } for `a.b` / `a["b"]` given as text, else null. */
function splitMemberText(text) {
  const m = MEMBER_TEXT_RE.exec(text.trim());
  if (!m) return null;
  return { clientText: m[1], member: m[2] ?? m[3] };
}

/**
 * Follow `name` through its bindings until the text reads as `<client>.<member>`.
 * `const m = prisma.auditOutbox; const n = m; n.findMany()` is the chained form
 * of the alias case, and stopping at one hop reported it as clean.
 */
function resolveMemberChain(node, name) {
  const seen = new Set();
  let text = name;
  for (let hop = 0; hop <= ALIAS_HOP_LIMIT; hop++) {
    const split = splitMemberText(text);
    if (split) return split;
    if (seen.has(text)) return null; // `const a = b; const b = a`
    seen.add(text);
    const next = resolveBindingAt(node, text);
    if (!next || next === text) return null;
    text = next;
  }
  return null;
}

/**
 * The member a call/tagged-template invokes, and the text of what it is invoked
 * on: `{ method, recvText }`. Handles `x.m()`, `x["m"]()`, and a method
 * DETACHED from its receiver by destructuring (`const { findMany } =
 * prisma.auditOutbox; findMany({})`), which is a bare Identifier at the call
 * site and was skipped entirely.
 */
function resolveInvocation(expr, node) {
  const kind = expr.getKind();
  if (kind === SyntaxKind.PropertyAccessExpression) {
    return { method: expr.getName(), recvText: expr.getExpression().getText() };
  }
  if (kind === SyntaxKind.ElementAccessExpression) {
    const split = splitMemberText(expr.getText());
    return split ? { method: split.member, recvText: split.clientText } : null;
  }
  if (kind !== SyntaxKind.Identifier) return null;
  // The bare identifier is only interesting if it is BOUND to something —
  // resolving on the name alone would miss `const { findMany: fm } = ...`,
  // where the local name is nothing a method set knows about.
  const origin = resolveMemberChain(node, expr.getText());
  if (!origin) return null;
  return { method: origin.member, recvText: origin.clientText };
}

/**
 * True when `recvText` names a binding that is already transaction-scoped:
 * either the parameter of a callback passed to a context-establishing call, or
 * a parameter annotated as a transaction client and threaded in by its caller.
 */
function hasRlsContext(node, recvText, seen = new Set()) {
  let cur = node.getParent();
  while (cur) {
    if (
      cur.getKind() === SyntaxKind.ArrowFunction ||
      cur.getKind() === SyntaxKind.FunctionExpression ||
      cur.getKind() === SyntaxKind.FunctionDeclaration ||
      cur.getKind() === SyntaxKind.MethodDeclaration
    ) {
      for (const param of cur.getParameters()) {
        if (param.getName() !== recvText) continue;
        const typeText = param.getTypeNode()?.getText() ?? "";
        if (TX_TYPE_RE.test(typeText)) return true;
      }
      const params = cur.getParameters().map((p) => p.getName());
      if (params.includes(recvText)) {
        const call = cur.getParent();
        if (call && call.getKind() === SyntaxKind.CallExpression) {
          const expr = call.getExpression();
          const name =
            expr.getKind() === SyntaxKind.PropertyAccessExpression
              ? expr.getName()
              : expr.getText();
          if (CONTEXT_HELPERS.has(name)) return true;
          // Bare $transaction: accept only if the callback actually sets the
          // GUC on THIS binding, before this statement.
          if (name === TX_OPENING) {
            const verdict = gucEstablishedOn(cur, recvText, node);
            if (verdict === "established") return true;
            if (verdict === "unresolved") {
              // Cannot decide: refuse rather than accept. Surfaced at the call
              // site as an UNRESOLVED violation so the failure mode is "someone
              // annotates this" rather than "a defect ships".
              return false;
            }
          }
        }
      }
    }
    cur = cur.getParent();
  }
  // Follow the alias chain: `const db = tx` inside a context callback is correct
  // code, and flagging it is the false positive that gets a gate routed around.
  // `seen` bounds a cycle (`const a = b; const b = a`), which no hop counter
  // alone would terminate cheaply.
  if (seen.size <= ALIAS_HOP_LIMIT && !seen.has(recvText)) {
    seen.add(recvText);
    const aliased = resolveBindingAt(node, recvText);
    if (aliased && aliased !== recvText) {
      return hasRlsContext(node, aliased, seen);
    }
  }
  return false;
}

/** RLS tables named by a raw-SQL literal. */
function tablesInSql(text, rlsTables) {
  const hits = new Set();
  for (const t of rlsTables) {
    // Word-boundary match so `audit_logs` does not match `audit_logs_archive`.
    if (new RegExp(`\\b${t}\\b`).test(text)) hits.add(t);
  }
  return hits;
}

const rlsTables = loadRlsTables();
const modelAccessors = loadModelAccessors(rlsTables);
// Per-ENTRY, not per-run. `scanned === 0` below cannot fire while src/workers
// and scripts still resolve, so renaming or misspelling the single-file entry
// drops the one src/lib member this gate was extended to cover and still prints
// OK. Measured: `src/lib/heaith.ts` gave `scanned 30 files` / OK / exit 0.
{
  const missing = unresolvedTargets(SEARCH_DIRS, REPO_ROOT);
  if (missing.length > 0) {
    fail(
      `scan target(s) resolved to no source file: ${missing.join(", ")} — ` +
        `moved, renamed, or misspelled. A target the gate cannot find is not a target it may skip.`,
    );
  }
}

console.log(
  `check-rls-read-context: ${rlsTables.size} RLS tables, ${modelAccessors.size} model accessors`,
);

const project = createAstProject();
const violations = [];
let scanned = 0;

for (const { rel: path, sf } of sourceFilesFrom(project, SEARCH_DIRS, REPO_ROOT)) {
  if (
    /\.(test|spec)\.[cm]?tsx?$/.test(path) ||
    path.includes("__tests__") ||
    // Gate fixtures are deliberately-malformed inputs for OTHER gates.
    path.includes("__fixtures__") ||
    // Developer scratch tools: not shipped, not scheduled, not part of any
    // deployment path. (They are NOT uniformly superuser-connected —
    // share-access-audit.ts uses the app client and withBypassRls — so the
    // load-bearing reason is the deployment one, not the credential one.)
    path.includes("scripts/manual-tests/")
  ) {
    continue;
  }
  scanned++;

  // BOTH node kinds. `prisma.$queryRaw`...`` is a TaggedTemplateExpression, not
  // a CallExpression — walking only calls silently skipped the dominant raw form
  // in this repo (every set_config line, and src/lib/health.ts).
  const statements = [
    ...sf.getDescendantsOfKind(SyntaxKind.CallExpression),
    ...sf.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression),
  ];

  for (const node of statements) {
    const isTagged = node.getKind() === SyntaxKind.TaggedTemplateExpression;
    const expr = isTagged ? node.getTag() : node.getExpression();
    const invocation = resolveInvocation(expr, node);
    if (!invocation) continue;
    let { method } = invocation;
    const { recvText } = invocation;

    let subject = null;

    if (RAW_METHODS.has(method)) {
      const sqlNode = isTagged ? node.getTemplate() : node.getArguments()[0];
      const sqlText = sqlNode?.getText() ?? "";
      const literal =
        isTagged ||
        (sqlNode &&
          (sqlNode.getKind() === SyntaxKind.StringLiteral ||
            sqlNode.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral ||
            sqlNode.getKind() === SyntaxKind.TemplateExpression));
      if (!literal) {
        // SQL the gate cannot read (an identifier, a built string). Do not spell
        // "unreadable" the same as "touches no RLS table": report it unless the
        // receiver is already proven context-bearing.
        if (hasRlsContext(node, recvText)) continue;
        violations.push({
          path,
          line: node.getStartLineNumber(),
          recvText,
          method,
          subject: "UNRESOLVED SQL (non-literal argument)",
        });
        continue;
      }
      const hits = tablesInSql(sqlText, rlsTables);
      if (hits.size === 0) continue;
      subject = [...hits].join(",");
    } else if (MODEL_METHODS.has(method)) {
      if (isTagged) continue;
      // recvText is `<client>.<accessor>` (either access spelling), or an
      // identifier bound to one (`const m = prisma.auditOutbox; m.findMany()`).
      const split = splitMemberText(recvText) ?? resolveMemberChain(node, recvText);
      if (!split) continue;
      if (!modelAccessors.has(split.member)) continue;
      subject = modelAccessors.get(split.member);
      // Print the accessor too: `prisma.findMany` alone hides which model.
      method = `${split.member}.${method}`;
      if (hasRlsContext(node, split.clientText)) continue;
      violations.push({
        path,
        line: node.getStartLineNumber(),
        recvText: split.clientText,
        method,
        subject,
      });
      continue;
    } else {
      continue;
    }

    if (hasRlsContext(node, recvText)) continue;

    violations.push({
      path,
      line: node.getStartLineNumber(),
      recvText,
      method,
      subject,
    });
  }
}

if (scanned === 0) {
  // "Examined nothing" must not be spelled like "found nothing wrong".
  fail(
    `scanned 0 source files under ${SEARCH_DIRS.join(", ")} — scan root is wrong or the tree moved`,
  );
}

console.log(`check-rls-read-context: scanned ${scanned} files`);

if (violations.length > 0) {
  console.error(
    `\ncheck-rls-read-context: ${violations.length} RLS-table statement(s) with no RLS context:\n`,
  );
  for (const v of violations) {
    console.error(
      `  ${v.path}:${v.line}  ${v.recvText}.${v.method}  ->  ${v.subject}`,
    );
  }
  console.error(
    `\nWith no RLS context these run with app.tenant_id unset or '' — the policy
returns zero rows with no error, or raises 22P02. Wrap the statement in
$transaction + setBypassRlsGucs (workers), or withTenantRls/withBypassRls.\n`,
  );
  process.exit(1);
}

console.log("check-rls-read-context: OK");
