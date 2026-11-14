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
 * by the shape of a call's argument; every spelling of a digest key, by its role
 * in the parse tree; raw SQL, by the lexed text of its literals (backed at run
 * time by renderSql and the raw-sql module's mints); the SQL files that define
 * database objects; and the pg driver's `.query` and pool factory. It does not
 * follow values across files or through types.
 * Plan: docs/archive/review/bearer-passkey-gate-coverage-plan.md (C1-C6; SC1-SC7
 * name what stays out).
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
 *   - Digest-key spelling census (C1): the lookup rule sees a key only where the walk
 *     reads it, so every SPELLING of a digest key in non-test src is accounted for, by
 *     role and not by value: each identifier whose text is a digest key, and each string
 *     or no-substitution template literal whose cooked value equals one. A binding (a
 *     declared name, or a reference resolving to a local binding) and a type position
 *     are not spellings. Every other role is a key: a property (plain, shorthand,
 *     string-literal, computed and pinned), a member or element access, a destructured
 *     property, a string in a value position, a reference with no visible binding, and
 *     any role not listed (an enum member, a JSX attribute, an export alias, a label —
 *     the default arm errs toward a site). A key is PLACED when the walk read it as a
 *     lookup (any receiver), a scalar write at a data / create / update position, or a
 *     select / omit key, the last two only on a receiver that resolves to a model
 *     declaring the field (createMany / updateMany included; placement is its own channel
 *     and changes no model the walkers receive). A key not placed is FLOATING: one site of
 *     the function that spells it, unless it sits inside a counted call, or inside another
 *     floating key, of the same manifest key. A function holding a floating WRITE key
 *     (a property, an assignment target `w.tokenHash = h`, a string handed to a call
 *     `Reflect.set(w, "tokenHash", h)`) builds a digest-keyed object, so a direct call of it
 *     (a local function, or a named import of its module) is one site of the caller; one
 *     level only. A floating key attributed to no named function or exported const fails.
 *   - Computed keys (C2): a computed key this file cannot pin (`[k]` with a parameter, a
 *     `let`) is opaque in every filter position the walk reaches (where, cursor, having,
 *     relation and nested-write filters), whatever the model — resolved or not, token or not
 *     (an unresolved receiver is walked only in a file that spells a digest key or holds a
 *     backslash). Every other opacity reason below stays scoped to the token models.
 *   - Model coverage: every token model has an analysed lookup whose position
 *     resolves to it, or a manifest `models` entry with a reason; an entry for
 *     a model that has one is stale.
 *   - Refuse rather than guess, where the call's receiver resolves to a model
 *     (`x.<handle>`, `x["<handle>"]`, `x[k]` with `const k = "<handle>"`, the
 *     handle as a bare name, or a name destructured from it). "Opaque" is:
 *       * a `where` / `cursor` / relation filter on a token model that is not
 *         an object literal (a `const` bound to one is followed) or holds a
 *         spread, a computed key or an accessor — a spread in a filter is
 *         opaque by decision, even when its value could be read (a computed
 *         key is opaque on every model: see C2 above);
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
 *     scanned here; the identifiers, tables and fragments spliced into it
 *     (`sqlIdentifier`, `sqlTable`, `joinSql`) exist only as rendered text, so renderSql
 *     throws at run time when that text names a digest column or holds a
 *     Unicode-escape form (src/lib/prisma/raw-sql.ts; code
 *     RAW_SQL_DIGEST_COLUMN / RAW_SQL_UNICODE_ESCAPE), and the retention-GC
 *     worker refuses a digest-column registry identifier at boot.
 *     check-raw-sql-usage refuses every other way to splice text through
 *     Prisma (Prisma.raw / Prisma.sql / Prisma.join).
 *   - SQL-bearing literals (C3, rules W1-W6): the template of a `$queryRaw` /
 *     `$executeRaw` tag, the literal argument of an Unsafe call, a trustedSql template
 *     (import-resolved) and the literal argument of a `.query(...)` call, lexed with
 *     lib/sql-scan.mjs. A name compares case-insensitively unquoted and exactly quoted; a
 *     schema qualifier is skipped; a quoted identifier holding a substitution is judged as
 *     that substitution. A token table is the @@map table of a model declaring a digest key.
 *     A RELATION POSITION is a name chain directly after FROM / JOIN / UPDATE / INTO / ONLY
 *     (not `DISTINCT FROM`, nor the FROM of trim / extract / substring / overlay) followed by
 *     an alias, a keyword of a closed follow-set (an unlisted word reads as an alias, which
 *     errs toward refusal), `,`, `)`, `;` or the end; a name followed by `::`, `[` or `(` is a
 *     value, except the column list after INTO. A token relation is a token table in
 *     relation position, and in a trustedSql template a substituted relation; its alias is the
 *     name after it, optionally after AS.
 *       * W1: a `*` other than `count(*)` fails.
 *       * W2: a token table's name, or a token relation's alias, fails unless it is in relation
 *         position or qualifies a declared column (`t.<column>` of that table; for the alias
 *         of a substituted relation, a column of some schema model; a substitution is no
 *         column). A name in a comma list, `FOR UPDATE OF`, `LOCK TABLE` or `TABLE t` fails.
 *       * W3: an alias followed by `(` fails (a column alias list renames the digest column).
 *       * W4 (every literal): EXECUTE, PREPARE, a statement-initial DO, a CREATE / ALTER of a
 *         function, procedure, view, trigger or rule, and calls to query_to_xml*,
 *         table_to_xml*, cursor_to_xml*, schema_to_xml*, database_to_xml*, dblink* and ts_stat.
 *       * W5: a token table's name as a whole word, any case, inside a string token's body (its
 *         delimiters stripped, so `$$api_keys$$` counts; only letters, digits and `_` join a
 *         word) fails: SQL carried as a string argument is invisible to W1-W3.
 *       * W6 (trustedSql templates, whose substituted tables the run-time mint places by the
 *         template's own text): a substitution after a FROM that is no relation FROM; in
 *         relation position followed by `::`, `[` or `(` (not INTO's column list); a
 *         substituted qualifier `${x}.<name>` whose name is no column of any schema model;
 *         directly adjacent to a letter, digit, `_` or `$` of the template (`api_${x}`); or a
 *         substitution a comment swallowed (the lexer drops it, while the run-time mint still
 *         reads the text around it: `-- ${x} FROM\n ${t}`).
 *     W1-W3 and W5 apply to a literal that names a token table (as a name or inside a string)
 *     and to every trustedSql template; W4 to every literal; W6 to trustedSql templates only.
 *     Each failure names its rule. A literal holding U+E000 (the lexer's substitution marker,
 *     which would make a quoted identifier look like a substitution) fails as SQL_SENTINEL, as
 *     does an SQL file holding it. A quoted lower-case function name is the same function as its
 *     unquoted spelling (W4's calls, count(*)); quoting a keyword makes an identifier, so keyword
 *     tests read unquoted words only.
 *   - TOKEN_TABLE_NAMES: src/lib/prisma/raw-sql.ts exports a (frozen) array literal of string
 *     literals equal, as a set, to the schema's token tables; sqlIdentifier refuses those
 *     names at run time, so a token table reaches rendered SQL only through sqlTable.
 *   - SQL files (C4): prisma/migrations/<dir>/migration.sql, infra/postgres/initdb/*.sql and
 *     scripts/*.sql are lexed (dollar-quoted and single-quoted bodies re-lexed, recursively;
 *     a non-ASCII dollar tag is rewritten by check-migration-rls-dml's normaliser, an
 *     unterminated one fails). A file needs a manifest `sqlObjects` entry (reason) when it
 *     holds: a CREATE of a function, procedure, view, materialized view, trigger or rule
 *     whose statement or body names a token table or a digest column, or a function or
 *     procedure whose body holds EXECUTE (a trigger's EXECUTE FUNCTION clause is not one); a
 *     DO block creating such an object and naming a token table or a digest column, or one that
 *     EXECUTEs a CREATE / ALTER of such an object (whatever it names); or any
 *     statement naming a digest column that is not plain (a CREATE TABLE without AS, an ADD
 *     COLUMN without GENERATED, ADD / DROP CONSTRAINT, CREATE INDEX, DROP, an INSERT ... VALUES
 *     with no SELECT and no ON CONFLICT DO UPDATE) — a REFERENCES or GENERATED clause reading a
 *     digest column is never plain, so a copy, a rename, a foreign key and a policy qualify.
 *     A stale entry fails; no migration read is fatal. Schema checks (fatal): the digest-key
 *     fields' @map columns equal the digest-column set both ways and a field mapped to one is
 *     named a digest key; no `view` block; a unique (or @@unique member) String field named
 *     or mapped ending in hash / digest is a digest key or listed in `nonBearerHashFields`
 *     (`Model.field`, reason; an entry that no longer names such a field is stale); no @relation
 *     references a digest key; no `model` / `view` opens its block on a later line (the shared
 *     schema reader would not see it). The schema is read over logical lines: attributes
 *     continued on the next line, and parentheses or brackets spanning lines, are joined first.
 *   - The pg driver (C5): a call of a member named `query` (property, optional chain, pinned
 *     element access) takes a string literal or no-substitution template as its first
 *     argument, which is then a SQL-bearing literal. The files importing createPool or
 *     createClient from src/lib/db/pool-factory equal the manifest's `pgPools`; in them and in
 *     pool-factory, a reference to `query` other than such a direct call fails (a value,
 *     `.call` / `.apply` / `.bind`, a destructuring). pool-factory is loaded by named imports
 *     only: a namespace or default import, a re-export, a dynamic import, a require or an
 *     import-equals of it fails.
 *
 * Residuals — spellings this gate does not see (Anti-Deferral entries: the
 * plan's deviation log, "Code review round 3 — residuals"; the plan's SC1-SC7):
 *   - A digest key that is never spelled as a key (SC3): built by concatenation or
 *     character codes, held inside longer string text (`JSON.parse`), or compared
 *     without naming the field (`Object.values(row)`). A key spelled in a filter value
 *     this file cannot read (a spread, `&&` / `||` / `??`, a helper's return, a computed
 *     key pinned by a `const`, a held variable) is no longer a residual: the census
 *     counts it wherever it is spelled, though it is neither a lookup nor refused as
 *     opaque on an unresolved or non-token model.
 *   - A delegate reached by a spelling the model resolution does not follow
 *     (`Reflect.get(tx, "apiKey")`, `Object.values(tx)`, a delegate a function
 *     returns, a parameter not named by its handle) (SC1): its lookups are found only
 *     where the filter is readable (above) or its key is spelled (census), and its
 *     opaque positions are not refused.
 *   - A builder of a digest-keyed object reached other than by a direct call of a local
 *     function or a named import (a method call, a namespace import, a re-export, a
 *     builder passed as a value, a builder two calls away) (SC6).
 *   - An opaque value more than one relation hop from a token model (SC2): a `data` or
 *     projection on a model with no token relation that hides a nested write or filter
 *     through one that has (a spelled key there is still counted by the census).
 *   - SQL the lexer cannot judge (SC4): an alias declared in one trustedSql fragment and
 *     used as a bare value in another; a table name assembled across two fragments; objects
 *     created by hand outside the three SQL roots; a database function called by a name that
 *     says nothing about what it reads (its definition is what `sqlObjects` classifies).
 *   - TypeScript outside src/ (SC5): scripts/, cli/, extension/, ios/.
 *   - A pool handed out of an importer file and queried elsewhere through a non-call spelling
 *     of `query` (SC7), e.g. `pool.query.bind(pool)` in a module that received the pool.
 *
 * Each lookup, opaque or floating-key site is attributed to the nearest named function,
 * method, `const`-bound function, or exported `const`; the key is
 * `<repo path>#<name>`; a key that two functions of one file share fails as
 * AMBIGUOUS_KEY. Every key needs a manifest entry
 * (bearer-passkey-gate-manifest.json) with a class, a reason, and `calls` (the
 * number of sites in it: lookup calls, opaque calls, floating digest keys and builder
 * calls, each counted once). A failure reports the four counts separately, and each
 * floating key's line and role.
 * Unlisted key, stale entry, count mismatch, and zero analysed all fail. The summary
 * line prints the census: digest-keys (key-role spellings), placed, floating.
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
 * (src/), the schema (prisma/schema.prisma), the SQL file roots and the manifest together.
 * The summary line prints the SQL counts after the census: sql-literals,
 * token-table-literals, sql-files, sql-qualifying.
 */
import { SyntaxKind, ts } from "ts-morph";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFiles } from "./lib/ast-project.mjs";
import { FILTERING, RELATION_FILTERS, SchemaReadError, WRITING, loadPrismaSchema, objectLiterals } from "./lib/prisma-relation-reach.mjs";
import { bindingIndex, resolveLocalFunction, unwrapExpression, visibleBinding } from "./lib/scope-bindings.mjs";
import { TOKEN, nameOf, sqlInputFromNode, tokenizeSql } from "./lib/sql-scan.mjs";
import { normalizeDollarTags } from "./check-migration-rls-dml.mjs";

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
const POOL_MODULE = "src/lib/db/pool-factory";
const POOL_FNS = new Set(["createPool", "createClient"]);
// The raw-sql names this gate reads at a use site. Each is named once here, so
// check-raw-sql-usage's measured literal exemption for this file (one each) holds.
const RENDER_SQL_FN = "renderSql";
const TRUSTED_SQL_TAG = "trustedSql";
const TOKEN_TABLE_LIST = "TOKEN_TABLE_NAMES";
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
/** A manifest entry's reason must be a string of at least MIN_REASON characters; `what` names the entry in the failure. */
function checkReason(what, entry) {
  if (typeof entry?.reason !== "string" || entry.reason.trim().length < MIN_REASON) failures.push(`BAD_ENTRY: ${what} needs a reason of at least ${MIN_REASON} characters.`);
}

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
const SCALAR_WRITE_OPS = new Set(["updateMany"]);
// A RegExp, not a string literal: check-raw-sql-usage's PRISMA_EXTENDS (the repo-wide control)
// denies a "$extends" literal in scripts/ too.
const EXTENDS_RE = /^\$extends$/;
const RAW_METHOD = /^\$(query|execute)Raw(Unsafe)?$/;
const DIGEST_COLUMN = /token_hash|code_hash|replaced_by_hash/i;
// The @map columns of the digest-key fields; the schema must map exactly these (see schemaViolation).
const DIGEST_COLUMNS = new Set(["token_hash", "code_hash", "replaced_by_hash"]);
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
// An optional manifest section: a missing one is empty, a present one must be an object.
function manifestSection(name) {
  if (manifest[name] !== undefined && !isPlainObject(manifest[name])) fatal(`manifest at ${manifestAbs} has a "${name}" that is not an object.`);
  return new Map(Object.entries(manifest[name] ?? {}));
}
const MODEL_ENTRIES = manifestSection("models");
const SQL_OBJECT_ENTRIES = manifestSection("sqlObjects");
const PG_POOL_ENTRIES = manifestSection("pgPools");
const NON_BEARER_HASH_ENTRIES = manifestSection("nonBearerHashFields");

// ─── Schema-derived SQL facts and schema checks (C3, C4) ─────

// A token table is the @@map table of a token model; a column is a scalar field's @map name.
const TOKEN_TABLES = new Set([...TOKEN_MODELS].map((m) => schema.tables.get(m)));
const scalarColumns = (model) => new Set([...MODELS.get(model).values()].filter((f) => !MODELS.has(f.type)).map((f) => f.column));
const COLUMNS_BY_TABLE = new Map([...MODELS.keys()].map((m) => [schema.tables.get(m), scalarColumns(m)]));
const ALL_COLUMNS = new Set([...COLUMNS_BY_TABLE.values()].flatMap((cols) => [...cols]));

/**
 * Facts the schema loader does not keep: `view` blocks, unique fields, `@relation(references: [...])` lists, and
 * blocks whose brace is on a later line (the loader reads only `model X {` on one line, so it cannot see them).
 * Physical lines are joined into logical ones first: inside unbalanced parentheses or brackets, and a line that
 * starts with an attribute (`@unique` under its field).
 */
function scanSchemaSource(text) {
  const out = { views: [], unique: [], references: [], braceOnNextLine: [] };
  const logical = [];
  let depth = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "");
    const continues = depth > 0 || /^[ \t]+@(?!@)/.test(line);
    if (continues && logical.length > 0) logical[logical.length - 1] += ` ${line.trim()}`;
    else logical.push(line);
    for (const c of line) depth += c === "(" || c === "[" ? 1 : c === ")" || c === "]" ? -1 : 0;
    if (depth < 0) depth = 0;
  }
  let model = null;
  logical.forEach((line, k) => {
    const lone = /^(model|view)\s+(\w+)\s*$/.exec(line);
    if (lone && /^\s*\{/.test(logical[k + 1] ?? "")) out.braceOnNextLine.push(lone[2]);
    const open = /^(model|view)\s+(\w+)\s*\{/.exec(line);
    if (open) {
      if (open[1] === "view") out.views.push(open[2]);
      model = open[1] === "model" ? open[2] : null;
      return;
    }
    if (/^\}/.test(line)) {
      model = null;
      return;
    }
    if (!model) return;
    const field = /^[ \t]+(\w+)[ \t]+[A-Za-z_]\w*(?:\[\])?\??/.exec(line)?.[1];
    if (field && /@unique\b/.test(line)) out.unique.push({ model, field });
    const composite = /@@unique\(\s*(?:fields:\s*)?\[([^\]]*)\]/.exec(line);
    if (composite) for (const m of composite[1].split(",")) out.unique.push({ model, field: /^\s*(\w+)/.exec(m)?.[1] });
    const references = /@relation\([^)]*references:\s*\[([^\]]*)\]/.exec(line);
    if (references) out.references.push({ model, field, names: references[1].split(",").map((n) => n.trim()) });
  });
  return out;
}
const SCHEMA_SOURCE = scanSchemaSource(readFileSync(join(ROOT, SCHEMA_PATH), "utf8"));
const endsHashLike = (name) => /(hash|digest)$/i.test(name);
/** Unique String fields that end in hash / digest (by name or column) and are not digest keys: `Model.field`. */
const UNIQUE_HASH_FIELDS = new Set(
  SCHEMA_SOURCE.unique
    .filter(({ model, field }) => {
      const f = MODELS.get(model)?.get(field);
      return f && f.type === "String" && !DIGEST_KEYS.has(field) && (endsHashLike(field) || endsHashLike(f.column));
    })
    .map(({ model, field }) => `${model}.${field}`),
);

/** The first schema check that fails, as a fatal message, or null. */
function schemaViolation() {
  if (SCHEMA_SOURCE.braceOnNextLine.length > 0) return `${SCHEMA_PATH}: ${SCHEMA_SOURCE.braceOnNextLine[0]} opens its block on a later line: the schema reader cannot see it.`;
  const mapped = new Set();
  for (const [model, fields] of MODELS) {
    for (const [name, f] of fields) {
      if (DIGEST_KEYS.has(name)) {
        if (!DIGEST_COLUMNS.has(f.column)) return `${SCHEMA_PATH}: ${model}.${name} maps to column "${f.column}", which is not a digest column (${[...DIGEST_COLUMNS].join("/")}): map it, or the gate's digest-column set is out of date.`;
        mapped.add(f.column);
      } else if (DIGEST_COLUMNS.has(f.column)) {
        return `${SCHEMA_PATH}: ${model}.${name} is mapped to digest column "${f.column}" but is not named ${[...DIGEST_KEYS].join("/")}: a lookup by it would not be recognised.`;
      }
    }
  }
  for (const column of DIGEST_COLUMNS) {
    if (!mapped.has(column)) return `${SCHEMA_PATH}: no digest-key field maps to column "${column}": the digest-column set and the schema disagree.`;
  }
  if (SCHEMA_SOURCE.views.length > 0) return `${SCHEMA_PATH}: view ${SCHEMA_SOURCE.views[0]}: a database view can project a digest column without naming it in a query.`;
  for (const key of UNIQUE_HASH_FIELDS) {
    if (!NON_BEARER_HASH_ENTRIES.has(key)) {
      return `${SCHEMA_PATH}: ${key} is a unique String ending in hash/digest but is not a digest key (${[...DIGEST_KEYS].join("/")}): name it one, or list "${key}" in the manifest's "nonBearerHashFields" with a reason.`;
    }
  }
  for (const { model, field, names } of SCHEMA_SOURCE.references) {
    const digest = names.find((n) => DIGEST_KEYS.has(n));
    if (digest) return `${SCHEMA_PATH}: ${model}${field ? `.${field}` : ""} references ${digest}: a foreign key gives another column the digest's values.`;
  }
  return null;
}
const schemaProblem = schemaViolation();
if (schemaProblem) fatal(schemaProblem);

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

/** The string literal `constString` read: the literal itself, or the initializer of the `const` it names. Only after a non-null `constString`. */
function pinningLiteral(node, file) {
  const v = unwrapExpression(node);
  if (isStringish(v)) return v;
  return unwrapExpression(visibleBinding(v.getText(), v, file.bindingsFor).getInitializer());
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
      // `occ`: the node that spells the key (the census places it when the walk reads it as one).
      const occ = nameNode.getKind() === SyntaxKind.ComputedPropertyName ? pinningLiteral(nameNode.getExpression(), ctx) : nameNode;
      props.push({ name, value, occ });
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

// A filter's computed key this file cannot pin hides which field the filter names, so it is
// opaque on every model (C2) — the other reasons stay scoped to the token models.
const filterOpaque = (model, res, label) => (detail) => {
  if (TOKEN_MODELS.has(model) || detail === "computed key") res.opaque.push(`${label}: ${detail}`);
};

/**
 * Placement (C1) is a channel of its own: a digest key the walk read as a lookup, a scalar write
 * or a projection is pushed to `res.placed`. The model it is judged against is the call's own
 * (`pmodel`), not the one the walkers receive — createMany / updateMany walk their `data` with
 * no model, and the key is still a write to the model that declares it.
 */
const placeIfDeclared = (res, pmodel, name, occ) => {
  if (DIGEST_KEYS.has(name) && MODELS.get(pmodel)?.has(name)) res.placed.push(occ);
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
    else if (WRITE_KEYS.has(name)) walkData(value, writesRelations ? model : null, res, ctx, name, model);
    // `omit` is a projection for placement only: the opacity rules never read it.
    else if (name === "omit") for (const p of readProps(value, ctx, () => {}, true) ?? []) placeIfDeclared(res, model, p.name, p.occ);
  }
}

/** `select` / `include`: each relation's own arguments, and `_count` (`{ select: { rel: { where } } }`). */
function walkProjection(node, model, res, ctx, what) {
  if (isNullish(node) || isBooleanLiteral(node)) return;
  const opaque = opaqueIf(TOKEN_ADJACENT.has(model), res, `${model} ${what}`);
  const props = readProps(node, ctx, opaque, true);
  if (!props) return opaque("not an object literal");
  for (const { name, value, occ } of props) {
    if (what === "select") placeIfDeclared(res, model, name, occ);
    if (name === "_count") walkArgs(value, model, res, ctx, "_count");
    else walkArgs(value, relationOf(model, name)?.type ?? null, res, ctx, name);
  }
}

function walkWhere(node, model, res, ctx, what = "where") {
  if (isNullish(node) || isBooleanLiteral(node)) return;
  const opaque = filterOpaque(model, res, `${model ?? "unresolved"} ${what}`);
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
  for (const { name, value, occ } of props) {
    if (DIGEST_KEYS.has(name)) {
      res.lookup = true;
      res.placed.push(occ);
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
  const opaque = filterOpaque(related, res, `${related ?? "unresolved"} relation filter`);
  const props = readProps(node, ctx, opaque);
  if (!props) return opaque("not an object literal");
  if (props.length > 0 && props.every((p) => RELATION_FILTERS.has(p.name))) {
    for (const { value } of props) walkWhere(value, related, res, ctx);
  } else {
    walkWhereProps(props, related, res, ctx, opaqueIf(TOKEN_MODELS.has(related), res, `${related} where`)); // a direct to-one filter
  }
}

/** A `data` (or an upsert's `create`/`update`): an object, or an array of them, keyed by field. `pmodel` is the position's real model (see placeIfDeclared). */
function walkData(node, model, res, ctx, what = "data", pmodel = model) {
  if (isNullish(node)) return;
  const opaque = opaqueIf(TOKEN_ADJACENT.has(model), res, `${model} ${what}`);
  if (isArrayLiteral(node)) {
    for (const el of unwrapExpression(node).getElements()) {
      if (el.getKind() === SyntaxKind.SpreadElement) opaque("spread");
      else walkData(el, model, res, ctx, what, pmodel);
    }
    return;
  }
  const props = readProps(node, ctx, opaque, true);
  if (!props) return opaque("not an object literal");
  for (const { name, value, occ } of props) {
    placeIfDeclared(res, pmodel, name, occ);
    walkNestedWrite(value, relationOf(model, name)?.type ?? null, res, ctx, name);
  }
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
          else if (WRITE_KEYS.has(p.name)) walkData(p.value, SCALAR_WRITE_OPS.has(name) ? null : model, res, ctx, `${what}.${p.name}`, model);
        }
      }
    }
  }
}

/** { lookup, lookupModels, opaque[], placed[] } for one call: every argument is walked, the first under the delegate's model. */
function readCall(call, target, ctx) {
  const res = { lookup: false, lookupModels: new Set(), opaque: [], placed: [] };
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

// ─── Digest-key spelling census (C1) ─────────────────────────

// Every identifier whose text is a digest key, and every string / no-substitution template
// literal whose cooked value equals one, has a role. A binding (a declared name, or a reference
// to a local binding) and a type position are not spellings; every other role is a key, and a
// role not listed here is a key too: the census errs toward a site.
const TYPE_DECLARATIONS = new Set([SyntaxKind.InterfaceDeclaration, SyntaxKind.TypeAliasDeclaration, SyntaxKind.TypeParameter]);
// Parents whose own `name` declares a local binding.
const DECLARED_NAME_PARENTS = new Set([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.Parameter,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.ModuleDeclaration,
  SyntaxKind.ImportClause,
  SyntaxKind.NamespaceImport,
  SyntaxKind.ImportEqualsDeclaration,
]);
// Parents in which an identifier (other than a name) is an expression, so it refers to a binding.
const VALUE_PARENTS = new Set([
  SyntaxKind.CallExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.AwaitExpression,
  SyntaxKind.YieldExpression,
  SyntaxKind.TypeOfExpression,
  SyntaxKind.VoidExpression,
  SyntaxKind.DeleteExpression,
  SyntaxKind.SpreadElement,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.TemplateSpan,
  SyntaxKind.ArrowFunction,
  SyntaxKind.ComputedPropertyName,
  SyntaxKind.ReturnStatement,
  SyntaxKind.ThrowStatement,
  SyntaxKind.ExpressionStatement,
  SyntaxKind.IfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.CaseClause,
  SyntaxKind.ExportAssignment,
  SyntaxKind.JsxExpression,
  SyntaxKind.JsxSpreadAttribute,
  SyntaxKind.Decorator,
  SyntaxKind.ExpressionWithTypeArguments,
]);
// Wrappers a string passes through on its way to being a call's argument (`f([["tokenHash", h]])`).
const ARGUMENT_WRAPPERS = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
]);

/** Is `node` inside a type (a type node, an interface / alias body, a type parameter)? A class's `extends` expression is a value. */
function inType(node) {
  for (let p = node; p; p = p.getParent()) {
    const k = p.getKind();
    if (TYPE_DECLARATIONS.has(k)) return true;
    if (k === SyntaxKind.ExpressionWithTypeArguments) {
      const heritage = p.getParent();
      const isClassExtends = heritage?.getKind() === SyntaxKind.HeritageClause && heritage.getToken() === SyntaxKind.ExtendsKeyword && heritage.getParent()?.getKind() === SyntaxKind.ClassDeclaration;
      if (!isClassExtends) return true;
    } else if (ts.isTypeNode(p.compilerNode)) return true;
  }
  return false;
}

/** Is the access `<expr>.k` / `<expr>["k"]` the left side of an assignment (`w.tokenHash = h`)? */
function isAssignmentTarget(access) {
  const p = access.getParent();
  if (p?.getKind() !== SyntaxKind.BinaryExpression || p.getLeft() !== access) return false;
  const op = p.getOperatorToken().getKind();
  return op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment;
}

/** Is the string `lit` a call's argument, directly or inside array / parenthesised wrappers? */
function isCallArgument(lit) {
  let n = lit;
  while (n.getParent() && ARGUMENT_WRAPPERS.has(n.getParent().getKind())) n = n.getParent();
  const p = n.getParent();
  return p?.getKind() === SyntaxKind.CallExpression && p.getArguments().includes(n);
}

/** A reference with a visible local binding is not a spelling; one with none is a key. */
function referenceRole(id, file) {
  return visibleBinding(id.getText(), id, file.bindingsFor) ? null : { label: "unresolved reference", write: false };
}

/**
 * `null` for a binding or a type position (not a spelling), else `{ label, write }`: the role of
 * a key. `write` marks a spelling that builds a digest-keyed object (a property, an assignment
 * target, a string handed to a call) as against one that only reads or names it.
 */
function keyRole(occ, file) {
  if (inType(occ)) return null;
  const parent = occ.getParent();
  const pk = parent.getKind();
  const node = occ.compilerNode;
  if (occ.getKind() !== SyntaxKind.Identifier) {
    if (pk === SyntaxKind.PropertyAssignment && parent.compilerNode.name === node) return { label: "property", write: true };
    if (pk === SyntaxKind.ComputedPropertyName) {
      return parent.getParent().getKind() === SyntaxKind.PropertyAssignment ? { label: "computed property", write: true } : { label: "computed name", write: false };
    }
    if (pk === SyntaxKind.ElementAccessExpression && parent.compilerNode.argumentExpression === node) return { label: "element access", write: isAssignmentTarget(parent) };
    return { label: "string", write: isCallArgument(occ) };
  }
  if (DECLARED_NAME_PARENTS.has(pk) && parent.compilerNode.name === node) return null;
  switch (pk) {
    case SyntaxKind.PropertyAssignment:
      if (parent.compilerNode.name === node) return { label: "property", write: true };
      break;
    case SyntaxKind.ShorthandPropertyAssignment:
      // `{ tokenHash }` names the field whatever the local binding it also reads.
      if (parent.compilerNode.name === node) return { label: "shorthand property", write: true };
      break;
    case SyntaxKind.PropertyAccessExpression:
      if (parent.compilerNode.name === node) return { label: "member access", write: isAssignmentTarget(parent) };
      return referenceRole(occ, file);
    case SyntaxKind.BindingElement: {
      const isObjectPattern = parent.getParent().getKind() === SyntaxKind.ObjectBindingPattern;
      if (parent.compilerNode.propertyName === node) return { label: "destructured property", write: false };
      if (parent.compilerNode.name === node) return parent.compilerNode.propertyName || !isObjectPattern ? null : { label: "destructured property", write: false };
      break;
    }
    case SyntaxKind.ImportSpecifier:
      if (parent.compilerNode.name === node) return null;
      break;
    case SyntaxKind.ExportSpecifier:
      if (!(parent.compilerNode.propertyName && parent.compilerNode.name === node)) return referenceRole(occ, file);
      break;
    default:
  }
  if (parent.compilerNode.initializer === node || VALUE_PARENTS.has(pk)) return referenceRole(occ, file);
  return { label: `other (${parent.getKindName()})`, write: false };
}

/** The node a key's own property spans: another floating key inside it is part of the same spelling. */
function keySpan(occ) {
  let p = occ.getParent();
  if (p?.getKind() === SyntaxKind.ComputedPropertyName) p = p.getParent();
  // A shorthand property holds nothing but its name, so only a property with a value can contain another key.
  return p?.getKind() === SyntaxKind.PropertyAssignment ? p : occ;
}

/** Every key-role spelling of a digest key in the file: `{ occ, label, write, span }`. */
function censusKeys(file) {
  const out = [];
  const { sf } = file;
  for (const occ of [
    ...sf.getDescendantsOfKind(SyntaxKind.Identifier),
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ]) {
    const text = occ.getKind() === SyntaxKind.Identifier ? occ.getText() : occ.getLiteralText();
    if (!DIGEST_KEYS.has(text)) continue;
    const role = keyRole(occ, file);
    if (role) out.push({ occ, ...role, span: keySpan(occ) });
  }
  return out.sort((a, b) => a.occ.getStart() - b.occ.getStart());
}

const within = (outer, inner) => outer.getStart() <= inner.getStart() && inner.getEnd() <= outer.getEnd();

// ─── Raw SQL static rules (C3) ───────────────────────────────

// sql-scan keeps a substitution's offset as this private-use character; inside a quoted
// identifier (`"${t}"`) it is the only trace of the substitution left in the token's value.
const SQL_SUBSTITUTION = "";
const RELATION_KEYWORDS = new Set(["FROM", "JOIN", "UPDATE", "INTO", "ONLY"]);
// Functions whose `FROM` is syntax, not a relation: `trim(x FROM y)`, `extract(f FROM y)`, ...
const NON_RELATION_FROM_FUNCTIONS = new Set(["trim", "extract", "substring", "overlay"]);
// `UPDATE` after these is a lock clause, an action or a trigger event, not a relation keyword.
const NON_RELATION_UPDATE_PREV = new Set(["FOR", "ON", "DO", "KEY", "OF", "OR", "AFTER", "BEFORE"]);
// What may follow a relation's name without being its alias. A word missing from this closed
// list is read as an alias, which errs toward refusal.
const RELATION_FOLLOW = new Set([
  "WHERE", "SET", "ON", "USING", "VALUES", "RETURNING", "SELECT", "DEFAULT", "OVERRIDING",
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "LATERAL", "OUTER",
  "UNION", "INTERSECT", "EXCEPT", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "FETCH",
  "FOR", "WINDOW", "WITH", "TABLESAMPLE",
]);
// Dynamic SQL and object definitions (W4). `CREATE` / `ALTER` of one of these kinds, after these modifiers.
const OBJECT_KINDS = new Set(["FUNCTION", "PROCEDURE", "VIEW", "TRIGGER", "RULE"]);
const OBJECT_MODIFIERS = new Set(["OR", "REPLACE", "TEMP", "TEMPORARY", "RECURSIVE", "MATERIALIZED", "CONSTRAINT", "EVENT", "UNLOGGED", "GLOBAL", "LOCAL"]);
const XML_AND_LINK_CALL = /^(?:query_to_xml|table_to_xml|cursor_to_xml|schema_to_xml|database_to_xml|dblink)/;
const SQL_WORD_CHAR = /[\p{L}\p{N}_$]/u;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isSqlWord = (t, upper) => t !== undefined && t.type === TOKEN.WORD && t.upper === upper;
const isNameToken = (t) => t !== undefined && (t.type === TOKEN.WORD || t.type === TOKEN.QIDENT || t.type === TOKEN.OPAQUE);
// A substitution, or a quoted identifier holding one (`"${t}"`), is judged as that substitution.
const isSubstitution = (t) => t !== undefined && (t.type === TOKEN.OPAQUE || (t.type === TOKEN.QIDENT && t.value.includes(SQL_SUBSTITUTION)));
const isNamedToken = (t) => t !== undefined && (t.type === TOKEN.WORD || t.type === TOKEN.QIDENT) && !isSubstitution(t);
const isTokenTableName = (t) => isNamedToken(t) && TOKEN_TABLES.has(nameOf(t));
const TOKEN_TABLE_WORD =
  TOKEN_TABLES.size > 0 ? new RegExp(`(?<![A-Za-z0-9_])(${[...TOKEN_TABLES].map(escapeRegExp).join("|")})(?![A-Za-z0-9_])`, "gi") : null;
/** The token tables a string token's body (delimiters stripped; `$` is no word character there) names as a whole word, in any case. */
const tablesInString = (t) => (t.type === TOKEN.STRING && TOKEN_TABLE_WORD ? [...new Set([...stringBody(t.text).matchAll(TOKEN_TABLE_WORD)].map((m) => m[1].toLowerCase()))] : []);

/**
 * The relation positions of a token stream: a name chain (`schema.name`) directly after
 * FROM / JOIN / UPDATE / INTO / ONLY, where that FROM is not `DISTINCT FROM`, `trim`, `extract`,
 * `substring` or `overlay`'s. `table` indexes the chain's last name; a name followed by `::`,
 * `[` or `(` is a value (`isValue`), except the column list after `INTO t`. `alias` indexes the
 * name after the relation, optionally after AS, when it is not in the follow-set.
 * `looseFrom` lists the tokens after a FROM that is no relation.
 */
function sqlRelations(tk) {
  const enclosing = [];
  const open = [];
  tk.forEach((t, i) => {
    if (t.type === TOKEN.RPAREN) open.pop();
    enclosing[i] = open.at(-1);
    if (t.type === TOKEN.LPAREN) open.push(i);
  });
  const relations = [];
  const looseFrom = [];
  tk.forEach((t, i) => {
    if (t.type !== TOKEN.WORD || !RELATION_KEYWORDS.has(t.upper)) return;
    if (t.upper === "FROM") {
      const o = enclosing[i];
      const fn = o !== undefined && tk[o - 1]?.type === TOKEN.WORD ? tk[o - 1].text.toLowerCase() : null;
      if (isSqlWord(tk[i - 1], "DISTINCT") || (fn && NON_RELATION_FROM_FUNCTIONS.has(fn))) {
        looseFrom.push(i + 1);
        return;
      }
    }
    if (t.upper === "UPDATE" && tk[i - 1]?.type === TOKEN.WORD && NON_RELATION_UPDATE_PREV.has(tk[i - 1].upper)) return;
    let j = i + 1;
    if (!isNameToken(tk[j])) return;
    while (tk[j + 1]?.type === TOKEN.DOT && isNameToken(tk[j + 2])) j += 2;
    const next = tk[j + 1];
    let isRelation;
    if (next === undefined || next.type === TOKEN.COMMA || next.type === TOKEN.RPAREN || next.type === TOKEN.SEMI) isRelation = true;
    else if (next.type === TOKEN.LPAREN) isRelation = t.upper === "INTO";
    else isRelation = next.type === TOKEN.WORD || next.type === TOKEN.QIDENT;
    const isValue = !isRelation && (next.type === TOKEN.LPAREN || (next.type === TOKEN.OP && (next.text === ":" || next.text === "[")));
    let alias = null;
    if (isRelation && next !== undefined) {
      if (isSqlWord(next, "AS") && (tk[j + 2]?.type === TOKEN.WORD || tk[j + 2]?.type === TOKEN.QIDENT)) alias = j + 2;
      else if ((next.type === TOKEN.WORD && !RELATION_FOLLOW.has(next.upper)) || next.type === TOKEN.QIDENT) alias = j + 1;
    }
    if (isRelation || isValue) relations.push({ keyword: t.upper, table: j, alias, isValue });
  });
  return { relations, looseFrom };
}

/** The function a name token calls: an unquoted word folds to lower case, and a quoted lower-case name is the same function. */
const functionName = (t) => (t?.type === TOKEN.WORD ? t.text.toLowerCase() : t?.type === TOKEN.QIDENT && !isSubstitution(t) ? t.value : null);

/** Is this `*` the one in `count(*)`? */
const isCountStar = (tk, i) => tk[i - 1]?.type === TOKEN.LPAREN && functionName(tk[i - 2]) === "count" && tk[i + 1]?.type === TOKEN.RPAREN;

/**
 * W1-W6 over one SQL-bearing literal (`input` is sqlInputFromNode's). `trusted` marks a
 * trustedSql template, whose substitutions are text, not bound parameters. Returns
 * `{ names, violations: [{ rule, line, message }] }`; `names` is whether the literal names a
 * token table (a name token, or a whole word inside a string token).
 */
function checkSqlLiteral(input, trusted) {
  const tk = tokenizeSql(input);
  const violations = [];
  const add = (rule, token, message) => violations.push({ rule, line: token.line, message: `${rule}: ${message}` });
  const inString = tk.map(tablesInString); // the token tables each string token names
  const names = tk.some((t, i) => isTokenTableName(t) || inString[i].length > 0);

  // W4 — dynamic SQL and object definitions, in every SQL-bearing literal.
  tk.forEach((t, i) => {
    const called = tk[i + 1]?.type === TOKEN.LPAREN ? functionName(t) : null;
    if (called !== null && XML_AND_LINK_CALL.test(called)) add("W4", t, `${called}(...) reads whole rows or runs SQL given as a string`);
    else if (called === "ts_stat") add("W4", t, "ts_stat(...) runs SQL given as a string");
    if (t.type !== TOKEN.WORD) return;
    if (t.upper === "EXECUTE" || t.upper === "PREPARE") add("W4", t, `${t.upper} builds SQL the lexer cannot read`);
    else if (t.upper === "DO" && (i === 0 || tk[i - 1].type === TOKEN.SEMI)) add("W4", t, "a DO block runs SQL the lexer cannot read");
    else if (t.upper === "CREATE" || t.upper === "ALTER") {
      const kind = definedKind(tk, i);
      if (kind) add("W4", t, `${t.upper} ${kind} defines an object whose body the lexer cannot read`);
    }
  });

  if (!names && !trusted) return { names, violations };

  const { relations, looseFrom } = sqlRelations(tk);
  const asRelation = new Set(relations.filter((r) => !r.isValue).map((r) => r.table));
  const aliasDeclarations = new Set();
  const aliases = new Map(); // normalised alias -> columns its qualifier may name
  for (const r of relations) {
    if (r.isValue) continue;
    const table = tk[r.table];
    const isTokenRelation = isTokenTableName(table) || (trusted && isSubstitution(table));
    if (!isTokenRelation || r.alias === null) continue;
    aliasDeclarations.add(r.alias);
    aliases.set(nameOf(tk[r.alias]), isSubstitution(table) ? ALL_COLUMNS : COLUMNS_BY_TABLE.get(nameOf(table)));
    // W3 — a column alias list renames the digest column.
    if (tk[r.alias + 1]?.type === TOKEN.LPAREN) add("W3", tk[r.alias], `alias ${tk[r.alias].text} of a token relation is followed by a column alias list`);
  }

  // W1 — a whole-row projection reads the digest column without naming it.
  tk.forEach((t, i) => {
    if (t.type === TOKEN.OP && t.text === "*" && !isCountStar(tk, i)) add("W1", t, 'a "*" other than count(*) reads whole rows, digest column included');
  });

  // W2 — a token table's name or a token relation's alias outside relation position that does not qualify a declared column.
  const qualifiesColumn = (i, columns) => {
    if (tk[i + 1]?.type !== TOKEN.DOT) return false;
    const n = tk[i + 2];
    return (n?.type === TOKEN.OP && n.text === "*") || (isNamedToken(n) && columns.has(nameOf(n)));
  };
  tk.forEach((t, i) => {
    if (!isNamedToken(t) || asRelation.has(i) || aliasDeclarations.has(i)) return;
    if (isTokenTableName(t)) {
      if (!qualifiesColumn(i, COLUMNS_BY_TABLE.get(nameOf(t)))) add("W2", t, `token table ${nameOf(t)} outside relation position (and not qualifying one of its columns)`);
    } else if (aliases.has(nameOf(t)) && tk[i - 1]?.type !== TOKEN.DOT && !qualifiesColumn(i, aliases.get(nameOf(t)))) {
      add("W2", t, `alias ${t.text} of a token relation outside relation position (and not qualifying a declared column)`);
    }
  });

  // W5 — SQL carried as a string argument is invisible to W1-W3.
  tk.forEach((t, i) => inString[i].forEach((name) => add("W5", t, `a string names token table ${name}: SQL inside a string is not read`)));

  if (!trusted) return { names, violations };

  // W6 — what the run-time mint cannot see: the syntax around a substituted table.
  const looseFromSet = new Set(looseFrom);
  const valueRelationTables = new Set(relations.filter((r) => r.isValue && isSubstitution(tk[r.table])).map((r) => r.table));
  tk.forEach((t, i) => {
    if (!isSubstitution(t)) return;
    if (looseFromSet.has(i)) add("W6", t, "a substitution after a FROM that is not a relation FROM");
    if (valueRelationTables.has(i)) add("W6", t, "a substitution in relation position followed by :: / [ / ( is a value, not a relation");
    if (tk[i + 1]?.type === TOKEN.DOT) {
      const n = tk[i + 2];
      if (!(n?.type === TOKEN.OP && n.text === "*") && !(isNamedToken(n) && ALL_COLUMNS.has(nameOf(n)))) {
        add("W6", t, `a substituted qualifier names ${n ? (isSubstitution(n) ? "a substitution" : n.text) : "nothing"}, not a column of any schema model`);
      }
    }
  });
  // A substitution touching a word character assembles a name from parts (`api_${x}`); one a comment swallowed is
  // invisible here while the run-time mint still reads the text around it (`-- ${x} FROM\n ${t}`).
  const present = []; // the substitutions the lexer kept, in order: a token's source text, or null inside a quoted token
  for (const t of tk) {
    if (t.type === TOKEN.OPAQUE) present.push(t.text);
    else if (t.type === TOKEN.QIDENT || t.type === TOKEN.STRING) for (const c of t.type === TOKEN.QIDENT ? t.value : t.text) if (c === SQL_SUBSTITUTION) present.push(null);
  }
  let kept = 0;
  let line = 0;
  input.substitutions.forEach((substitution, k) => {
    line += [...input.parts[k]].filter((c) => c === "\n").length;
    if (kept < present.length && (present[kept] === null || present[kept] === substitution)) kept += 1;
    else add("W6", { line }, "a substitution inside a comment is invisible to the lexer");
    const before = input.parts[k].at(-1);
    const after = input.parts[k + 1][0];
    if ((before && SQL_WORD_CHAR.test(before)) || (after && SQL_WORD_CHAR.test(after))) {
      add("W6", { line }, "a substitution adjacent to a word character assembles a name from parts");
    }
    line += [...substitution].filter((c) => c === "\n").length;
  });
  return { names, violations };
}

// ─── Database objects defined in SQL files (C4) ──────────────

const SQL_NESTING_LIMIT = 8;
const isDigestColumnName = (t) => isNamedToken(t) && DIGEST_COLUMNS.has(nameOf(t));

/** The text a STRING token holds: a dollar-quoted body, or a quoted one with its escapes undone. */
function stringBody(text) {
  const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text)?.[0];
  if (tag) return text.slice(tag.length, text.endsWith(tag) && text.length >= 2 * tag.length ? -tag.length : undefined);
  const escaped = /^[Ee]'/.test(text);
  const body = text.slice(escaped ? 2 : 1, text.endsWith("'") ? -1 : undefined);
  return escaped ? body.replace(/\\(.)/gs, "$1") : body.replaceAll("''", "'");
}

/** A token stream and, recursively, the stream of every string token in it (a function body, an EXECUTE literal). */
function nestedStreams(tk, depth = 0) {
  const out = { lists: [tk], depths: [depth], tooDeep: false };
  for (const t of tk) {
    if (t.type !== TOKEN.STRING) continue;
    if (depth >= SQL_NESTING_LIMIT) {
      out.tooDeep = true;
      continue;
    }
    const inner = nestedStreams(tokenizeSql(stringBody(t.text)), depth + 1);
    out.lists.push(...inner.lists);
    out.depths.push(...inner.depths);
    out.tooDeep ||= inner.tooDeep;
  }
  return out;
}

/** The object kind a `CREATE` / `ALTER` at `tk[i]` defines (after its modifiers), or null. */
function definedKind(tk, i) {
  let j = i + 1;
  while (tk[j]?.type === TOKEN.WORD && OBJECT_MODIFIERS.has(tk[j].upper)) j++;
  return tk[j]?.type === TOKEN.WORD && OBJECT_KINDS.has(tk[j].upper) ? tk[j].upper : null;
}

/** Does a `REFERENCES t (cols)` clause in `tk` list a digest column? */
function referencesDigest(tk) {
  return tk.some((t, i) => {
    if (!isSqlWord(t, "REFERENCES")) return false;
    let j = i + 1;
    while (tk[j + 1]?.type === TOKEN.DOT && isNameToken(tk[j + 2])) j += 2;
    const open = tk[j + 1];
    return open?.type === TOKEN.LPAREN && open.match !== undefined && tk.slice(j + 2, open.match).some(isDigestColumnName);
  });
}

/** Does a `GENERATED ... AS (expr)` clause in `tk` read a digest column? */
function generatesFromDigest(tk) {
  return tk.some((t, i) => {
    if (!isSqlWord(t, "GENERATED")) return false;
    const as = isSqlWord(tk[i + 2], "AS") ? i + 2 : undefined; // GENERATED ALWAYS AS (expr)
    const open = as === undefined ? undefined : tk[as + 1];
    return open?.type === TOKEN.LPAREN && open.match !== undefined && tk.slice(as + 2, open.match).some(isDigestColumnName);
  });
}

/** Is a statement that names a digest column one of the plain forms (a definition, an index, a drop, a seed)? */
function isPlainStatement(tk) {
  const first = tk[0];
  if (first.upper === "DROP") return true;
  if (first.upper === "INSERT") {
    const hasWord = (w) => tk.some((t) => isSqlWord(t, w));
    const upsertsOver = tk.some((t, i) => isSqlWord(t, "DO") && isSqlWord(tk[i + 1], "UPDATE"));
    return hasWord("VALUES") && !hasWord("SELECT") && !upsertsOver;
  }
  let j = 1;
  if (first.upper === "CREATE") {
    while (tk[j]?.type === TOKEN.WORD && ["UNIQUE", "GLOBAL", "LOCAL", "TEMP", "TEMPORARY", "UNLOGGED"].includes(tk[j].upper)) j++;
    if (isSqlWord(tk[j], "INDEX")) return true;
    // `CREATE TABLE ... AS <query>` copies rows; a column definition's `GENERATED ... AS (...)` sits inside the parentheses.
    return isSqlWord(tk[j], "TABLE") && !tk.some((t) => t.depth === 0 && isSqlWord(t, "AS"));
  }
  if (first.upper === "ALTER" && isSqlWord(tk[1], "TABLE")) {
    j = 2;
    if (isSqlWord(tk[j], "IF") && isSqlWord(tk[j + 1], "EXISTS")) j += 2;
    if (isSqlWord(tk[j], "ONLY")) j++;
    while (tk[j + 1]?.type === TOKEN.DOT) j += 2;
    // Every depth-0 action is an ADD or a DROP COLUMN / CONSTRAINT; a rename or a type change is not plain.
    const starts = [j + 1, ...tk.flatMap((t, i) => (i > j && t.type === TOKEN.COMMA && t.depth === 0 ? [i + 1] : []))];
    return starts.every((s) => isSqlWord(tk[s], "ADD") || (isSqlWord(tk[s], "DROP") && (isSqlWord(tk[s + 1], "COLUMN") || isSqlWord(tk[s + 1], "CONSTRAINT"))));
  }
  return false;
}

/** Why a statement (top-level tokens, no `;`) makes its file need an entry: `[why, ...]`. */
function sqlObjectReasons(tk) {
  const { lists, depths, tooDeep } = nestedStreams(tk);
  const all = lists.flat();
  const namesDigest = all.some(isDigestColumnName);
  const namesTable = all.some(isTokenTableName);
  const reasons = [];
  if (tooDeep) reasons.push(`strings nested more than ${SQL_NESTING_LIMIT} deep, which this scan does not read`);
  const first = tk[0];
  if (isSqlWord(first, "CREATE")) {
    const kind = definedKind(tk, 0);
    if (kind && (namesDigest || namesTable)) reasons.push(`CREATE ${kind} naming a token table or a digest column`);
    // A trigger's `EXECUTE FUNCTION` clause is no dynamic SQL; a routine's PL/pgSQL EXECUTE is.
    if ((kind === "FUNCTION" || kind === "PROCEDURE") && all.some((t) => isSqlWord(t, "EXECUTE"))) reasons.push(`CREATE ${kind} whose body holds EXECUTE`);
  }
  if (isSqlWord(first, "DO")) {
    const creates = (l) => l.some((t, i) => isSqlWord(t, "CREATE") && definedKind(l, i));
    if ((namesDigest || namesTable) && lists.slice(1).some(creates)) reasons.push("DO block creating a database object and naming a token table or a digest column");
    // A CREATE / ALTER inside an EXECUTE string (a list two strings deep: body, then the executed text) is built at run time.
    if (lists.some((l, i) => depths[i] >= 2 && l.some((t, k) => (isSqlWord(t, "CREATE") || isSqlWord(t, "ALTER")) && definedKind(l, k)))) {
      reasons.push("DO block executing a CREATE or ALTER of a database object");
    }
  }
  if (namesDigest && (lists.some((l) => referencesDigest(l) || generatesFromDigest(l)) || !isPlainStatement(tk))) {
    reasons.push(`statement naming a digest column that is not a plain definition, index, drop or seed (${first.text})`);
  }
  return reasons;
}

/** `[{ line, why }]` for the statements of one SQL file that need a `sqlObjects` entry. */
function sqlFileFindings(text) {
  const { sql, errors } = normalizeDollarTags(text);
  const findings = errors.map((e) => ({ line: e.line + 1, why: `${e.reason}: the file cannot be read` }));
  // The lexer's substitution marker: a real one in a file would pass for a substitution.
  if (text.includes(SQL_SUBSTITUTION)) findings.push({ line: text.slice(0, text.indexOf(SQL_SUBSTITUTION)).split("\n").length, why: "holds U+E000, the lexer's substitution marker: the file cannot be read" });
  const tk = tokenizeSql(sql);
  let start = 0;
  const statement = (end) => {
    const part = tk.slice(start, end);
    start = end + 1;
    if (part.length === 0) return;
    for (const why of sqlObjectReasons(part)) findings.push({ line: part[0].line + 1, why });
  };
  tk.forEach((t, i) => {
    if (t.type === TOKEN.SEMI && t.depth === 0) statement(i);
  });
  statement(tk.length);
  return findings;
}

/** Every SQL file the gate reads: migrations (a missing directory is the caller's fatal), initdb and scripts. */
function sqlFilePaths() {
  const migrations = [];
  const migrationsDir = join(ROOT, "prisma/migrations");
  if (existsSync(migrationsDir)) {
    for (const d of readdirSync(migrationsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (existsSync(join(migrationsDir, d.name, "migration.sql"))) migrations.push(`prisma/migrations/${d.name}/migration.sql`);
    }
  }
  const flat = (dir) =>
    existsSync(join(ROOT, dir))
      ? readdirSync(join(ROOT, dir), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".sql")).map((e) => `${dir}/${e.name}`).sort()
      : [];
  return { migrations, others: [...flat("infra/postgres/initdb"), ...flat("scripts")] };
}

// ─── Scan ────────────────────────────────────────────────────

const project = createAstProject();
const files = new Map(); // rel -> { sf, rel, bindingsFor, imports }
const analysed = new Map(); // key -> { rel, name, fn, fns, owners, file, sites, lookups, opaque: [], floating: [], builderCalls: [], lines: [] }
const lookedUpModels = new Set();
const exemptionPairs = [];
const census = { keys: 0, placed: 0, floating: 0 };
const sqlCensus = { literals: 0, naming: 0 }; // SQL-bearing literals read, and those naming a token table
const poolImporters = new Set(); // files importing createPool / createClient from pool-factory

/** W1-W6 on one SQL-bearing literal; each violation is one line, `<file>:<line>  <rule>: <why>`. */
function analyseSqlLiteral(rel, node, trusted) {
  const input = sqlInputFromNode(node);
  if (!input) return;
  sqlCensus.literals += 1;
  // The lexer marks a substitution with U+E000 inside a quoted identifier's value; a real one in the
  // text would be indistinguishable from it, so such a literal is refused outright.
  if (input.parts.some((p) => p.includes(SQL_SUBSTITUTION))) {
    failures.push(`${rel}:${node.getStartLineNumber()}  SQL_SENTINEL: the literal holds U+E000, the lexer's substitution marker: a quoted identifier holding it could not be told from a substitution`);
    return;
  }
  const { names, violations } = checkSqlLiteral(input, trusted);
  if (names) sqlCensus.naming += 1;
  const base = node.getStartLineNumber();
  const lines = new Set(violations.map((v) => `${rel}:${base + v.line}  ${v.message}`));
  failures.push(...lines);
}
const builders = []; // functions holding a floating write key: { rel, name, fn }

/** The analysed entry of the function `at` names, created on first use; a site is added by the caller. */
function entryFor(rel, at, file) {
  const key = `${rel}#${at.name}`;
  if (!analysed.has(key)) analysed.set(key, { rel, name: at.name, fn: at.fn, fns: new Set(), owners: new Set(), file, sites: 0, lookups: 0, opaque: [], floating: [], builderCalls: [], lines: [] });
  const a = analysed.get(key);
  a.fns.add(at.fn);
  a.owners.add(at.owner);
  return a;
}

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
  const placed = new Set(); // digest-key spellings the walk read as a lookup, a write or a projection
  const countedCalls = []; // { call, key }: the calls that count as a site
  const sqlLiterals = new Map(); // SQL-bearing literal node -> is it a trustedSql template (C3)
  const addSqlLiteral = (node, trusted) => sqlLiterals.set(node, sqlLiterals.get(node) || trusted);
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    // The pg driver's `.query(...)` (C5): its first argument must be a SQL literal, which is then read like any other.
    const callee = unwrapExpression(call.getExpression());
    const isQuery =
      (callee.getKind() === SyntaxKind.PropertyAccessExpression && callee.getName() === "query") ||
      (callee.getKind() === SyntaxKind.ElementAccessExpression && constString(callee.getArgumentExpression(), file) === "query");
    if (isQuery) {
      const arg = call.getArguments()[0];
      if (isStringish(arg)) addSqlLiteral(arg, false);
      else failAt(rel, call, `C5: \`.query(...)\` must take a string literal (or a no-substitution template) as its SQL argument: its text cannot be read`);
    }
    const target = delegateTarget(call, file);
    if (target?.unreadable) {
      failAt(rel, call, `delegate method called on an element access whose key this gate cannot read (\`x[k].<method>(...)\`): name the delegate (\`x.<handle>\`), or bind the key with \`const k = "<handle>"\``);
    }
    const res = readCall(call, target, ctx);
    for (const n of res.placed) placed.add(n);
    if (!res.lookup && res.opaque.length === 0) continue;
    for (const m of res.lookupModels) lookedUpModels.add(m);
    const at = attribute(call);
    if (!at) {
      failAt(rel, call, `digest lookup or opaque site cannot be attributed to a named function, method or exported const`);
      continue;
    }
    const a = entryFor(rel, at, file);
    countedCalls.push({ call, key: `${rel}#${at.name}` });
    // One site per call: a call that is both a lookup and opaque counts once.
    a.sites += 1;
    if (res.lookup) a.lookups += 1;
    if (res.opaque.length > 0) a.opaque.push(`line ${call.getStartLineNumber()}: ${res.opaque.join(", ")}`);
    a.lines.push(call.getStartLineNumber());
  }

  // Digest-key spellings (C1): a key the walk placed is accounted for; every other one is
  // floating and adds a site to the function that spells it — unless it sits inside a counted
  // call, or inside another floating key, of that same manifest key (its function's entry
  // already covers the construct it is part of).
  const keys = ctx.mayHoldDigestKey ? censusKeys(file) : [];
  census.keys += keys.length;
  const floating = keys.filter((k) => !placed.has(k.occ));
  census.placed += keys.length - floating.length;
  census.floating += floating.length;
  const keyOf = (node) => {
    const at = attribute(node);
    return at && { at, key: `${rel}#${at.name}` };
  };
  const owned = floating.map((k) => ({ ...k, owner: keyOf(k.occ) }));
  for (const k of owned) {
    if (!k.owner) {
      failAt(rel, k.occ, `digest-key spelling (${k.label}) cannot be attributed to a named function, method or exported const: move it into a named function or an exported const`);
      continue;
    }
    if (k.write) builders.push({ rel, name: k.owner.at.name, fn: k.owner.at.fn });
    const covered =
      countedCalls.some((c) => c.key === k.owner.key && within(c.call, k.occ)) ||
      owned.some((g) => g !== k && g.owner?.key === k.owner.key && within(g.span, k.occ));
    if (covered) continue;
    const a = entryFor(rel, k.owner.at, file);
    a.sites += 1;
    a.floating.push({ line: k.occ.getStartLineNumber(), label: k.label });
    a.lines.push(k.occ.getStartLineNumber());
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
      if (isStringish(arg)) {
        addSqlLiteral(arg, false);
        continue;
      }
      const a = unwrapExpression(arg);
      // Both names must be the raw-sql module's own exports, resolved where they are written.
      if (
        a?.getKind() === SyntaxKind.CallExpression &&
        refersToImport(a.getExpression(), file, RAW_SQL_MODULE, RENDER_SQL_FN) &&
        a.getArguments().length === 1 &&
        a.getArguments()[0].getKind() === SyntaxKind.TaggedTemplateExpression &&
        refersToImport(a.getArguments()[0].getTag(), file, RAW_SQL_MODULE, TRUSTED_SQL_TAG)
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

  // SQL-bearing literals (C3): a `$queryRaw` / `$executeRaw` template, an Unsafe call's literal, a
  // trustedSql template (import-resolved), a `.query(...)` literal. The Unsafe and `.query`
  // literals were collected above; the tagged templates are collected here.
  if (/\$(?:query|execute)Raw|trustedSql/.test(sf.getFullText())) {
    for (const tagged of sf.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
      const tag = unwrapExpression(tagged.getTag());
      if (refersToImport(tag, file, RAW_SQL_MODULE, TRUSTED_SQL_TAG)) addSqlLiteral(tagged.getTemplate(), true);
      else if (tag.getKind() === SyntaxKind.PropertyAccessExpression && RAW_METHOD.test(tag.getName()) && !tag.getName().endsWith("Unsafe")) addSqlLiteral(tagged.getTemplate(), false);
    }
  }
  for (const [node, trusted] of sqlLiterals) analyseSqlLiteral(rel, node, trusted);

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

  // The pg pool factory (C5): the files importing createPool / createClient are the manifest's
  // "pgPools"; in them, and in the factory, the pool's `query` is only ever called directly; and
  // the module is loaded by named imports only.
  const isPoolFile = moduleOf(rel) === POOL_MODULE;
  if (file.imports.some((i) => i.from === POOL_MODULE && POOL_FNS.has(i.imported) && !i.typeOnly)) poolImporters.add(rel);
  if (!isPoolFile) {
    for (const decl of sf.getImportDeclarations()) {
      if (resolveSpecifier(rel, decl.getModuleSpecifierValue()) !== POOL_MODULE || decl.isTypeOnly()) continue;
      if (decl.getNamespaceImport()) failAt(rel, decl, `C5: namespace import of pool-factory: its pools cannot be followed`);
      if (decl.getDefaultImport()) failAt(rel, decl, `C5: default import of pool-factory: its pools cannot be followed`);
    }
    for (const decl of sf.getExportDeclarations()) {
      const spec = decl.getModuleSpecifierValue();
      if (spec && resolveSpecifier(rel, spec) === POOL_MODULE) failAt(rel, decl, `C5: re-export of pool-factory: its pools cannot be followed`);
    }
    for (const ie of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
      const ref = ie.getModuleReference();
      const e = ref.getKind() === SyntaxKind.ExternalModuleReference ? ref.getExpression() : null;
      if (isStringish(e) && resolveSpecifier(rel, e.getLiteralText()) === POOL_MODULE) failAt(rel, ie, `C5: import-equals of pool-factory: its pools cannot be followed`);
    }
  }
  if (isPoolFile || poolImporters.has(rel)) {
    const isDirectCall = (node) => node.getParent()?.getKind() === SyntaxKind.CallExpression && node.getParent().getExpression() === node;
    const reference = `C5: a reference to \`query\` other than a direct call with a literal SQL argument (a value, .call / .apply / .bind, a destructuring): the pool's SQL cannot be read`;
    for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (pa.getName() === "query" && !isDirectCall(pa)) failAt(rel, pa, reference);
    }
    for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
      if (constString(ea.getArgumentExpression(), file) === "query" && !isDirectCall(ea)) failAt(rel, ea, reference);
    }
    for (const be of sf.getDescendantsOfKind(SyntaxKind.BindingElement)) {
      if (be.getParent()?.getKind() === SyntaxKind.ObjectBindingPattern && bindingKey(be) === "query") failAt(rel, be, reference);
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
    if (resolveSpecifier(rel, spec) === POOL_MODULE && !isPoolFile) {
      failAt(rel, call, `C5: dynamic import/require of pool-factory: its pools cannot be followed`);
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

// Consumers of a builder (C1): a function that spells a digest key outside every position the
// walk reads builds a digest-keyed object another function can pass to a lookup, so a direct call
// of it is one site of its caller. The callee resolves scope-aware — a local function, or a
// named import of the builder's module. One level only: the caller needs its own entry, and a
// caller of that caller is not followed (a builder reached by a method call, a namespace import
// or as a value is the plan's SC6).
const buildersByFn = new Map(builders.map((b) => [b.fn, b]));
for (const b of buildersByFn.values()) {
  for (const file of files.values()) {
    if (!file.sf.getFullText().includes(b.name)) continue;
    for (const call of file.sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = unwrapExpression(call.getExpression());
      if (callee?.getKind() !== SyntaxKind.Identifier) continue;
      const isBuilder =
        file.rel === b.rel
          ? resolveLocalFunction(callee.getText(), callee, file.bindingsFor) === b.fn
          : refersToImport(callee, file, moduleOf(b.rel), b.name);
      if (!isBuilder) continue;
      const at = attribute(call);
      if (at?.fn === b.fn) continue; // a builder calling itself is no consumer
      if (!at) {
        failAt(file.rel, call, `call of ${b.name}, which builds a digest-keyed object (${b.rel}), cannot be attributed to a named function, method or exported const`);
        continue;
      }
      const a = entryFor(file.rel, at, file);
      a.sites += 1;
      a.builderCalls.push({ line: call.getStartLineNumber(), name: b.name });
      a.lines.push(call.getStartLineNumber());
    }
  }
}

// The modules the predicate and the pin resolve against must exist as declared.
const fileByModule = (m) => [...files.values()].find((f) => moduleOf(f.rel) === m);
const gateFile = fileByModule(GATE_MODULE);
if (!gateFile?.sf.getFunction(GATE_FN)?.hasExportKeyword()) fatal(`${GATE_MODULE}.ts does not export function ${GATE_FN}.`);
const extFile = fileByModule(EXT_MODULE);
if (!extFile?.sf.getFunction(EXT_FN)?.hasExportKeyword()) fatal(`${EXT_MODULE}.ts does not export function ${EXT_FN}.`);
if (!fileByModule(EXT_TYPES_MODULE)?.sf.getVariableDeclaration(EXEMPTION_CONST)) fatal(`${EXT_TYPES_MODULE}.ts does not declare ${EXEMPTION_CONST}.`);

// TOKEN_TABLE_NAMES (C3): raw-sql refuses these names to sqlIdentifier, so the list is the schema's token tables.
function checkTokenTableList() {
  const file = fileByModule(RAW_SQL_MODULE);
  const decl = file?.sf.getVariableDeclaration(TOKEN_TABLE_LIST);
  if (!decl?.getVariableStatement()?.hasExportKeyword()) fatal(`${RAW_SQL_MODULE}.ts does not export ${TOKEN_TABLE_LIST}: the list sqlIdentifier refuses.`);
  let list = unwrapExpression(decl.getInitializer());
  // The module freezes it through its captured alias (`freeze([...])`) or `Object.freeze([...])`.
  if (list?.getKind() === SyntaxKind.CallExpression && list.getArguments().length === 1 && ["freeze", "Object.freeze"].includes(list.getExpression().getText())) {
    list = unwrapExpression(list.getArguments()[0]);
  }
  if (list?.getKind() !== SyntaxKind.ArrayLiteralExpression) fatal(`${RAW_SQL_MODULE}.ts: ${TOKEN_TABLE_LIST} is not an array literal of string literals (optionally frozen).`);
  const listed = new Set();
  for (const el of list.getElements()) {
    if (isStringish(el)) listed.add(el.getLiteralText());
    else failAt(file.rel, el, `${TOKEN_TABLE_LIST} element is not a string literal`);
  }
  for (const name of [...TOKEN_TABLES].sort()) if (!listed.has(name)) failAt(file.rel, decl, `${TOKEN_TABLE_LIST} lacks ${name}, a token table of the schema`);
  for (const name of [...listed].sort()) if (!TOKEN_TABLES.has(name)) failAt(file.rel, decl, `${TOKEN_TABLE_LIST} lists ${name}, which is not a token table of the schema`);
}
checkTokenTableList();

// pgPools (C5): the files that can make a pg pool are a human-reviewed copy of the importers.
for (const rel of [...poolImporters].sort()) {
  if (!PG_POOL_ENTRIES.has(rel)) failures.push(`PG_POOL_UNLISTED: ${rel} imports createPool / createClient from pool-factory — list it in "pgPools" in ${MANIFEST_PATH} with a reason.`);
}
for (const [rel, entry] of PG_POOL_ENTRIES) {
  if (!poolImporters.has(rel)) failures.push(`STALE_PG_POOL: ${rel} is in "pgPools" but imports neither createPool nor createClient from pool-factory.`);
  else checkReason(`"pgPools" entry ${rel}`, entry);
}

// sqlObjects (C4): SQL files that define or copy what a query can reach without naming a digest column.
const sqlFiles = sqlFilePaths();
if (sqlFiles.migrations.length === 0) fatal(`no prisma/migrations/<name>/migration.sql under ${ROOT}: no SQL file was read, so no database object could be classified.`);
const sqlQualifying = new Map();
for (const rel of [...sqlFiles.migrations, ...sqlFiles.others]) {
  const findings = sqlFileFindings(readFileSync(join(ROOT, rel), "utf8"));
  if (findings.length > 0) sqlQualifying.set(rel, findings);
}
for (const [rel, findings] of sqlQualifying) {
  const entry = SQL_OBJECT_ENTRIES.get(rel);
  if (!entry) {
    const why = [...new Map(findings.map((f) => [`line ${f.line}: ${f.why}`, 1])).keys()].join("; ");
    failures.push(`SQL_OBJECT_UNLISTED: ${rel} — ${why}. List it in "sqlObjects" in ${MANIFEST_PATH} with a reason.`);
  } else checkReason(`"sqlObjects" entry ${rel}`, entry);
}
for (const rel of SQL_OBJECT_ENTRIES.keys()) {
  if (!sqlQualifying.has(rel)) failures.push(`STALE_SQL_OBJECT: ${rel} is in "sqlObjects" but no statement in it (or no such file) needs an entry.`);
}

// nonBearerHashFields (C4): an entry must still name a unique String ending in hash / digest that is no digest key (UNIQUE_HASH_FIELDS).
for (const [key, entry] of NON_BEARER_HASH_ENTRIES) {
  if (!UNIQUE_HASH_FIELDS.has(key)) failures.push(`STALE_NON_BEARER_HASH: "${key}" is in "nonBearerHashFields" but names no unique non-digest String field ending in hash or digest.`);
  else checkReason(`"nonBearerHashFields" entry ${key}`, entry);
}

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
  const where = `${key} (lines ${[...a.lines].sort((x, y) => x - y).join(", ")})`;
  if (!entry) {
    // Floating keys and builder calls are named only when there are some; the counts stay separate from the lookups'.
    const counts = [`${a.lookups} digest lookup(s)`, `${a.opaque.length} opaque site(s)`];
    if (a.floating.length) counts.push(`${a.floating.length} floating key(s)`);
    if (a.builderCalls.length) counts.push(`${a.builderCalls.length} builder call(s)`);
    const details = [];
    if (a.opaque.length) details.push(a.opaque.join("; "));
    if (a.floating.length) details.push(`floating: ${a.floating.map((f) => `line ${f.line} ${f.label}`).join(", ")}`);
    if (a.builderCalls.length) details.push(`builder calls: ${a.builderCalls.map((b) => `line ${b.line} ${b.name}`).join(", ")}`);
    failures.push(`UNLISTED: ${where} — ${counts.join(", ")}${details.length ? `: ${details.join("; ")}` : ""}. Classify it in ${MANIFEST_PATH}.`);
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
  checkReason(key, entry);
  if (entry.calls !== calls) {
    failures.push(`COUNT_MISMATCH: ${where} has ${calls} site(s) (${a.lookups} lookup, ${a.opaque.length} opaque call(s), ${a.floating.length} floating key(s), ${a.builderCalls.length} builder call(s)); the manifest says ${entry.calls}.`);
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
  if (!analysed.has(key)) failures.push(`STALE_ENTRY: ${key} is in the manifest but no digest lookup, opaque site, floating digest key or builder call is attributed to it.`);
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
  else checkReason(`"models" entry ${model}`, entry);
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
  `check-bearer-passkey-gate: files=${files.size} token-models=${TOKEN_MODELS.size} analysed=${analysed.size} manifest=${ENTRIES.size} exemption-sites=${exemptionPairs.length} digest-keys=${census.keys} placed=${census.placed} floating=${census.floating} sql-literals=${sqlCensus.literals} token-table-literals=${sqlCensus.naming} sql-files=${sqlFiles.migrations.length + sqlFiles.others.length} sql-qualifying=${sqlQualifying.size}`,
);
if (analysed.size === 0) fatal(`analysed zero functions: no digest lookup was found, so nothing was checked.`);

if (failures.length > 0) {
  console.error("\nBearer passkey gate violations (plan C7):");
  for (const f of failures) console.error(`  ${f}`);
  console.error(`\nFAIL: ${failures.length} violation(s).`);
  process.exit(1);
}
console.log("OK (every digest lookup is classified; per-use gates and the exemption pin hold)");
