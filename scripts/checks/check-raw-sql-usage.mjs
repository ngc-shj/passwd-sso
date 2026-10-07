#!/usr/bin/env node
/**
 * CI guard: raw-SQL usage allowlist + unforgeable-SQL-text AST gate (C2/C3,
 * plan: unforgeable SQL text for raw-SQL calls, #635 guard 3).
 *
 * Two independent layers:
 *
 * Layer 1 (file allowlist, unchanged behaviour — FR5): every production file
 * matching the shared `rawSql` regex (route-class-patterns.json) MUST appear
 * in raw-sql-usage.txt with a purpose (>=10 chars). A listed file that no
 * longer matches the regex fails as STALE_EXEMPT.
 *
 * Layer 2 (ts-morph AST pass, no Program — same no-type-resolution precedent
 * as check-destructive-wrapper-derivation.mjs / src/__tests__/proxy/ast-guards.ts):
 * the runtime guarantee lives in src/lib/prisma/raw-sql.ts (a module-private
 * WeakMap adjudicates which values are genuine); this gate enforces only the
 * SYNTAX the runtime cannot see — every occurrence of a sensitive name is
 * judged by its syntactic POSITION alone, never by what it is bound to
 * (positional allowlists, no binding/type resolution). Fail-closed reasons:
 *
 *   - UNSAFE_ARG: an Unsafe call's (`$queryRawUnsafe` / `$executeRawUnsafe`)
 *     first argument must be a string literal, a no-substitution template, or
 *     a direct `renderSql(...)` call — nothing wrapped around or appended.
 *   - RAW_SQL_NAMES: every occurrence of `renderSql` / `trustedSql` /
 *     `sqlIdentifier` / `joinSql` must sit in one of a small set of allowed
 *     positions (the single canonical unaliased import from raw-sql.ts —
 *     "from raw-sql.ts" meaning the on-disk resolver below lands EXACTLY,
 *     case-sensitively, on src/lib/prisma/raw-sql.ts;
 *     `renderSql`/`sqlIdentifier`/`joinSql` as an ordinary call's callee AND
 *     `trustedSql` as a tagged-template tag, each ONLY when that name also has
 *     a canonical import in the same file — a positionally-shaped call alone
 *     proves nothing about what the name is bound to; a type position). A
 *     decoded string/no-substitution-template literal equal to one of the four
 *     names, in expression position, denies too (a literal-keyed forge —
 *     `globalThis["renderSql"] = …` — never produces an Identifier occurrence;
 *     exempt: raw-sql.ts, this gate's own source). Any other module-loading
 *     form of raw-sql.ts (namespace/default import, `export * from`,
 *     `require()`, `import()`, `import x = require()`) denies outright, as
 *     does a scanned file that itself SHADOWS raw-sql.ts's module resolution
 *     — a `raw-sql.<ext>` sibling for every scanned extension OTHER than
 *     `.ts` (including `.tsx`, since Next/esbuild resolve `.tsx` before
 *     `.ts`), OR a `src/lib/prisma/raw-sql/` DIRECTORY, checked directly
 *     against the filesystem (S-R3-1b: its mere existence denies, whatever
 *     sits inside it). These deny-side matches (module-loading forms, shadow
 *     files, the directory) are case-INsensitive and over-broad on purpose;
 *     only the GRANT (the canonical import) is exact.
 *   - IMPORT_EQUALS_ENTITY: `import x = <entity name>` (`import r =
 *     Prisma.raw`, including `export import` inside a namespace) denies
 *     unconditionally — a QualifiedName entity name is not a type position,
 *     and this binding form aliases whatever it denotes past every other
 *     expression-position check. `import x = require(...)` is unaffected
 *     (different AST shape; handled by RAW_SQL_NAMES / UNSCANNED_IMPORT).
 *   - SPECIFIER_LITERAL: a string/no-substitution-template literal, in
 *     expression position, whose decoded value HAS A PATH SEGMENT (split on
 *     `/` and `\`) equal to `@prisma`/`.prisma` (not merely start-anchored —
 *     a relative or `node_modules`-reaching path counts too) or NAMES
 *     raw-sql.ts (case-insensitive path match), denies unless it IS the specifier of a static import/export
 *     declaration (every other sighting — a computed `require()`/`import()`
 *     argument, a reassigned loader — is unaccounted for by construction and
 *     must fail closed). A `node_modules` path segment in any MODULE-SPECIFIER
 *     position (import/export declaration, `import x = require()`, a literal
 *     `require()`/`import()` argument) denies independently of the Prisma/
 *     raw-sql match. This gate's own source is exempt (it spells the allowed
 *     specifiers as data).
 *   - UNSCANNED_IMPORT: a relative (`./`, `../`, bare `.`/`..`) or `@/`
 *     specifier that reaches code this gate does not parse denies. Resolution is ONE on-disk resolver
 *     (resolveOnDisk): `?`/`#` suffix stripped; candidates tried in Node/TS
 *     order (the exact path; `.js/.jsx/.mjs/.cjs` → TS source rewrite; each
 *     code extension appended, plus `.json`/`.node`; then a directory's
 *     package.json, then its `index.<ext>`), each matched against readdir
 *     names with EXACT case, so the answer is identical on case-sensitive
 *     (Linux CI/Docker) and case-insensitive (macOS/Windows) hosts. Denies
 *     when the specifier (a) walks `..` above the repository root, (b)
 *     contains `%` (Node ESM percent-decodes; this gate does not), (c) first
 *     matches an existing candidate only case-INsensitively, (d) resolves to
 *     a directory carrying package.json (its "main"/"exports" is not
 *     followed), (e) resolves to an existing file outside the Layer 2 scan
 *     set — a test file, a file under an unscanned root (`docs/`, `cli/`,
 *     `extension/`, …), or an unscanned extension (`.TS`, `.css`, …) —
 *     unless its extension is exactly `.json`, or (f) resolves to nothing on
 *     disk but its normalized path matches the excluded-test-path shape
 *     (`*.test.*`, `__tests__/`, `manual-tests/`, `e2e/`, case-insensitive),
 *     so a not-yet-created test path still denies. Inspected positions: a
 *     scanned file's import/export declaration, `import x = require()`, a
 *     `require()`/`import()` call's literal argument, AND (N1) every OTHER
 *     string/no-substitution-template literal in expression position,
 *     whatever its parent — closing laundering through a loader reached
 *     under another name (`createRequire(...)(...)`, `module.require(...)`,
 *     `require.call(...)`, `new Worker(new URL(...))`, …); each literal is
 *     reported once. Exempt: this gate's own source (from the N1 scan), and
 *     a measured PER-(file, literal value) table with exact occurrence
 *     counts (UNSCANNED_LITERAL_EXEMPTIONS: repo-root path literals such as
 *     `new URL("../..", import.meta.url)`, a CSS import, Next's generated
 *     type references, the extension crypto golden-fixture generator, a
 *     test-helper module name held as data); any other such literal in an
 *     exempted file, or a count drift, still denies.
 *   - RAW_METHOD: any spelling of `/^\$(query|execute)Raw\w*$/` — identifier,
 *     property-access name, or decoded literal value (string OR
 *     no-substitution template) — in expression position, denies UNLESS it is
 *     `$queryRaw`/`$executeRaw` as the tag of a tagged template, or
 *     `$queryRawUnsafe`/`$executeRawUnsafe` as the direct callee of a call
 *     (optional chaining allowed, no wrapping parens). `scripts/checks/**` is
 *     exempt from the literal-VALUE clause only (this directory's gates spell
 *     the names as data); every other clause still applies there.
 *   - PRISMA_IMPORT: every specifier with a `@prisma`/`.prisma` PATH SEGMENT
 *     (case insensitive, same segment match as SPECIFIER_LITERAL) is denied
 *     except the EXACT bare specifiers `@prisma/client` (type-only imports
 *     unrestricted; value imports limited to `PrismaClient`, `Prisma`, and
 *     enum names read from `prisma/schema.prisma`) and `@prisma/adapter-pg`
 *     (only in the files that construct a client with it today). In
 *     expression position, `Prisma.<member>` is allowed only for
 *     `PrismaClientKnownRequestError` / `PrismaClientInitializationError`;
 *     every other member access, element access, or bare reference denies —
 *     including one reached through an `import x = Prisma.…` entity name
 *     (IMPORT_EQUALS_ENTITY denies that form outright too). Fails closed,
 *     unconditionally, if a `prisma/schema.prisma` enum name collides with a
 *     known non-enum top-level `@prisma/client` export.
 *   - PRISMA_EXTENDS: `$extends` — identifier, property name, or decoded
 *     literal — denies in expression position; there is no allowed form.
 *   - NON_LITERAL_IMPORT (D-5 refinement): a non-literal `import()`/`require()`
 *     argument denies everywhere except a measured allowlist of the files that
 *     load a module by a computed specifier on purpose (a tsx loader over an
 *     absolute path, the i18n namespace loader, the crypto WASM loader); a
 *     count mismatch in one of those files denies too, as does an
 *     allowlisted path that no longer exists among the scanned files
 *     (checked once, after the per-file loop) — so the audited set cannot
 *     drift silently in either direction: neither a quiet increase nor a
 *     stale entry left behind by a deletion or rename.
 *   - SYMLINK_SCAN_TARGET: a symlink under a Layer 2 scan root denies — the
 *     gate judges syntax on disk and cannot verify what a symlink resolves to.
 *   - Fails closed on 0 files analysed and on a file that fails to parse.
 *
 * Scope (Layer 2, independent of Layer 1): every non-test `.ts .tsx .mts .cts
 * .js .jsx .mjs .cjs` under `src/`, `scripts/`, `prisma/`, and the repository
 * root. `src/lib/prisma/raw-sql.ts` is exempt from RAW_SQL_NAMES only (it is
 * where these names are declared); every other rule still applies to it.
 *
 * Residual (declared, enforced by review, not this gate): `sqlIdentifier`'s
 * precondition that its argument is a code constant / closed literal set; a
 * computed element access with a non-literal key; reflective enumeration that
 * never spells a name; Prisma internals reached through `any`; a loader under
 * another name invoked with a NON-literal specifier (a literal specifier
 * SHAPED as a relative or `@/` path — `./`, `../`, `.`, `..`, `@/` — is
 * resolved and judged by UNSCANNED_IMPORT regardless of call shape; a
 * literal that is NOT shaped that way is itself a residual here: a
 * non-prefixed URL-relative specifier, e.g. `new URL("h.test.ts",
 * import.meta.url)` with no leading `./`; a specifier built by
 * `path.join(…)` or string concatenation; an absolute path or `file:` URL);
 * what a package.json "main"/"exports" points at (a directory
 * carrying one is denied, never followed); a target that comes into
 * existence only at runtime (the resolver sees the checkout as it is); a
 * third-party dependency
 * re-exporting a raw-SQL producer; `eval`/`Function`; replacing a built-in
 * before this module (or this gate's own ts-morph dependency) loads. The
 * canonical-import requirement (F4-a) does not itself follow a re-export
 * chain — it only checks for a direct, unaliased import of a name FROM
 * raw-sql.ts — but this is not a gap: a barrel file re-exporting one of the
 * four names is denied outright by RAW_SQL_NAMES's re-export clause, so
 * there is no file through which such a chain could be built in the first
 * place. Threat model: this gate catches accidental and casual misuse in
 * code that goes through review; deliberately obfuscated code can defeat any
 * static gate — for that, review is the control.
 *
 * See docs/archive/review/ for the "unforgeable SQL text for raw-SQL calls"
 * plan (C3) for the full contract, and its review log for why each clause
 * exists.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Project, Node, SyntaxKind } from "ts-morph";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

// ROOT and ALLOWLIST_FILE are env-overridable so the checker can run against
// an isolated fixture tree in tests. Defaults resolve to the real repo.
const ROOT = process.env.RAW_SQL_CHECK_ROOT ?? REPO_ROOT;
const PATTERNS_FILE = join(REPO_ROOT, "scripts/checks/route-class-patterns.json");
const ALLOWLIST_FILE =
  process.env.RAW_SQL_CHECK_ALLOWLIST ?? join(ROOT, "scripts/checks/raw-sql-usage.txt");
const SCHEMA_FILE = join(ROOT, "prisma/schema.prisma");

const MIN_PURPOSE_LENGTH = 10;

let failed = false;

// ---------------------------------------------------------------------------
// Layer 1 — file allowlist (unchanged behaviour, FR5). The former optional
// per-file marker-count suffix is removed: a line is `path # purpose` only;
// any further `#` segment is a leftover-suffix parse error.
// ---------------------------------------------------------------------------
const patterns = JSON.parse(readFileSync(PATTERNS_FILE, "utf8"));
if (typeof patterns.rawSql !== "string" || patterns.rawSql.length === 0) {
  console.error(
    `PATTERNS_FILE_INVALID: "rawSql" in ${PATTERNS_FILE} is missing or not a non-empty string.`,
  );
  process.exit(1);
}
const RAW_SQL_RE = new RegExp(patterns.rawSql);

const LAYER1_SCAN_ROOTS = ["src", "scripts"];
const LAYER1_EXCLUDE_RE = /\.test\.|__tests__|manual-tests|\/e2e\//;

function getLayer1SourceFiles() {
  const files = [];
  for (const root of LAYER1_SCAN_ROOTS) {
    const rootPath = join(ROOT, root);
    let dirEntries;
    try {
      dirEntries = readdirSync(rootPath, { recursive: true, withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    for (const entry of dirEntries) {
      if (!entry.isFile()) continue;
      const ext = extname(entry.name);
      if (ext !== ".ts" && ext !== ".tsx") continue;
      const abs = join(entry.parentPath ?? entry.path, entry.name);
      const rel = abs.slice(ROOT.length).replace(/^\/+/, "");
      if (LAYER1_EXCLUDE_RE.test(rel)) continue;
      files.push(rel);
    }
  }
  return files.sort();
}

function parseAllowlist(text) {
  const entries = new Map(); // path -> { purpose, lineNo }
  const parseFailures = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue; // full-line comment

    const parts = raw.split("#").map((p) => p.trim());
    // parts[0] = path; parts[1] = purpose. A third segment is the former
    // per-file marker-count suffix — removed, so it is now a parse error.
    const path = parts[0];
    if (!path) continue;

    const purpose = parts[1] ?? "";
    if (purpose.length < MIN_PURPOSE_LENGTH) {
      parseFailures.push(
        `NO_PURPOSE: ${path} has no (or too short, <${MIN_PURPOSE_LENGTH} chars) purpose in raw-sql-usage.txt (line ${i + 1}).`,
      );
    }

    if (parts.length >= 3 && parts[2].length > 0) {
      parseFailures.push(
        `LEFTOVER_SUFFIX: ${path} has a leftover "# ${parts[2]}" suffix in raw-sql-usage.txt (line ${i + 1}); the former per-file marker-count suffix was removed — lines are "path # purpose" only.`,
      );
    }

    entries.set(path, { purpose, lineNo: i + 1 });
  }

  return { entries, parseFailures };
}

const allowlistText = readFileSync(ALLOWLIST_FILE, "utf8");
const { entries: layer1Entries, parseFailures: layer1ParseFailures } = parseAllowlist(allowlistText);

if (layer1ParseFailures.length > 0) {
  failed = true;
  console.error("raw-sql-usage.txt parse errors:");
  for (const f of layer1ParseFailures) console.error(`  ${f}`);
  console.error("");
}

const layer1SourceFiles = getLayer1SourceFiles();
const layer1MatchingFiles = layer1SourceFiles.filter((f) =>
  RAW_SQL_RE.test(readFileSync(join(ROOT, f), "utf8")),
);

const missingFromAllowlist = layer1MatchingFiles.filter((f) => !layer1Entries.has(f));
if (missingFromAllowlist.length > 0) {
  failed = true;
  console.error(
    "MISSING_FROM_ALLOWLIST: files call a raw-SQL primitive but are not listed in scripts/checks/raw-sql-usage.txt:",
  );
  for (const f of missingFromAllowlist) console.error(`  ${f}`);
  console.error(
    "\nAdd a line: `<path> # <purpose, >=10 chars>` to scripts/checks/raw-sql-usage.txt.",
  );
  console.error("");
}

const layer1MatchingSet = new Set(layer1MatchingFiles);
const staleEntries = [...layer1Entries.keys()].filter((f) => !layer1MatchingSet.has(f));
if (staleEntries.length > 0) {
  failed = true;
  console.error(
    "STALE_EXEMPT: files are listed in raw-sql-usage.txt but no longer match a raw-SQL primitive — remove the entry:",
  );
  for (const f of staleEntries) console.error(`  ${f}`);
  console.error("");
}

// ---------------------------------------------------------------------------
// Layer 2 — AST gate (C3), independent of Layer 1.
// ---------------------------------------------------------------------------
const RAW_SQL_NAMES = ["renderSql", "trustedSql", "sqlIdentifier", "joinSql"];
const RAW_SQL_MODULE_REL = "src/lib/prisma/raw-sql.ts";
const GATE_SELF_REL = "scripts/checks/check-raw-sql-usage.mjs";
const RAW_METHOD_RE = /^\$(query|execute)Raw\w*$/;
const SCRIPTS_CHECKS_PREFIX = "scripts/checks/";

// F2: matched by PATH SEGMENT (split on `/` and `\`), not by a start-anchored
// prefix — a start-anchored `^@prisma` regex misses a Prisma package reached
// through a relative path (`../../node_modules/@prisma/client/...`) or a
// node_modules path handed to a loader as a plain string. "prisma/config" (no
// `@`, no leading dot) is a real, unrelated package specifier and must NOT match.
const PRISMA_PATH_SEGMENT_RE = /^(@prisma|\.prisma)$/i;
function hasPrismaPathSegment(value) {
  return value.split(/[\\/]/).some((seg) => PRISMA_PATH_SEGMENT_RE.test(seg));
}

// F2: a `node_modules` segment in a MODULE-SPECIFIER position (not just any
// string anywhere) denies regardless of what package it reaches — reaching
// into node_modules by relative path is itself a laundering vector.
const NODE_MODULES_SEGMENT_RE = /^node_modules$/i;
function hasNodeModulesSegment(value) {
  return value.split(/[\\/]/).some((seg) => NODE_MODULES_SEGMENT_RE.test(seg));
}

function isModuleSpecifierPositionLiteral(lit) {
  const parent = lit.getParent();
  if (parent === undefined) return false;
  if (Node.isImportDeclaration(parent) || Node.isExportDeclaration(parent)) return true;
  if (Node.isExternalModuleReference(parent)) return true; // import x = require("...")
  if (Node.isCallExpression(parent) && parent.getArguments()[0] === lit) {
    const callee = parent.getExpression();
    const isRequire = Node.isIdentifier(callee) && callee.getText() === "require";
    const isDynamicImport = callee.getKind() === SyntaxKind.ImportKeyword;
    return isRequire || isDynamicImport;
  }
  return false;
}

// Derived at implementation time (grep -rln '@prisma/adapter-pg' src scripts
// prisma <root files> | grep -vE '\.test\.|__tests__|manual-tests|/e2e/'):
// the only files that import @prisma/adapter-pg today.
const ADAPTER_PG_ALLOWED_FILES = new Set([
  "prisma/seed.ts",
  "scripts/audit-chain-verify-worker.ts",
  "scripts/migrate-account-tokens-to-encrypted.ts",
  "scripts/migrate-webhook-secrets-v1-to-v2.ts",
  "scripts/tenant-domain.ts",
  "src/lib/prisma.ts",
  "src/workers/audit-anchor-publisher.ts",
  "src/workers/audit-outbox-worker.ts",
  "src/workers/retention-gc-worker/index.ts",
]);

// Allowed `Prisma.<member>` expression-position members (measured in use,
// round 4 Func F2 / Sec S14).
const PRISMA_ALLOWED_EXPRESSION_MEMBERS = new Set([
  "PrismaClientKnownRequestError",
  "PrismaClientInitializationError",
]);

// Known non-enum top-level `@prisma/client` exports (measured via
// node_modules/.prisma/client/index.d.ts, plus the Prisma-namespace / raw-SQL
// producer names that a sibling package such as @prisma/client-runtime-utils
// exports at ITS top level, round 4 Sec S8). An enum declared in
// prisma/schema.prisma under one of these names would let a future top-level
// re-export collide silently with a raw-SQL producer or the client/namespace
// itself — the disjointness check below fails closed on any such collision.
const PRISMA_CLIENT_NON_ENUM_EXPORT_NAMES = new Set([
  "PrismaClient",
  "Prisma",
  "raw",
  "sql",
  "join",
  "empty",
  "sqltag",
  "skip",
  "Sql",
  "Decimal",
  "validator",
  "getExtensionContext",
  "dmmf",
  "DbNull",
  "JsonNull",
  "AnyNull",
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
  "PrismaClientRustPanicError",
  "PrismaClientInitializationError",
  "PrismaClientValidationError",
  "NotFoundError",
]);

// Identifier parent kinds that mean "this name token is a type-position name,
// not an expression-position reference" — a PropertySignature/MethodSignature
// member name, a type/interface declaration's own name, a type parameter. A
// qualified-name parent (`Prisma.TransactionClient` as a TYPE) is handled
// separately since TypeScript parses that as a QualifiedName node, never a
// PropertyAccessExpression — so it never reaches the expression-position
// scans below in the first place.
const TYPE_POSITION_PARENT_KINDS = new Set([
  SyntaxKind.PropertySignature,
  SyntaxKind.MethodSignature,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeParameter,
  SyntaxKind.IndexSignature,
  SyntaxKind.CallSignature,
  SyntaxKind.ConstructSignature,
]);

// F1: a QualifiedName (`A.B`) is TypeScript's AST shape both for a dotted name
// used as a TYPE (`Prisma.TransactionClient`) and for the ENTITY NAME of an
// `import x = A.B` declaration (`import r = Prisma.raw`) — the latter is NOT a
// type position: it creates a runtime alias to whatever `A.B` denotes, which
// is exactly how `Prisma.raw` (or a raw-sql.ts export) could be laundered past
// every expression-position check below. Walk to the outermost QualifiedName
// and classify by ITS parent, not by "is this a QualifiedName at all".
function isQualifiedNameInTypePosition(qn) {
  let node = qn;
  let parent = node.getParent();
  while (parent !== undefined && Node.isQualifiedName(parent)) {
    node = parent;
    parent = node.getParent();
  }
  return parent !== undefined && !Node.isImportEqualsDeclaration(parent);
}

function isTypePositionIdentifier(id) {
  const parent = id.getParent();
  if (parent === undefined) return false;
  if (TYPE_POSITION_PARENT_KINDS.has(parent.getKind())) return true;
  if (Node.isQualifiedName(parent)) return isQualifiedNameInTypePosition(parent);
  if (Node.isTypeQuery(parent)) return true; // `typeof renderSql` as a TYPE
  return false;
}

// F1: `import x = <entity name>` (optionally `export import x = …` inside a
// namespace) denies unconditionally — it aliases whatever the entity name
// denotes (`Prisma.raw`, a raw-sql.ts export reached some other way, …)
// through a binding form none of the other positional checks inspect.
// `import x = require(...)` is a DIFFERENT moduleReference shape
// (ExternalModuleReference) and is handled by the existing RAW_SQL_NAMES /
// UNSCANNED_IMPORT checks on its string-literal argument.
function checkImportEqualsEntityName(sf, rel) {
  for (const ieq of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const ref = ieq.getModuleReference();
    if (Node.isExternalModuleReference(ref)) continue;
    violate(
      "IMPORT_EQUALS_ENTITY",
      rel,
      lineOf(ieq),
      "import x = <entity name> aliases a value through a binding form no other rule inspects",
    );
  }
}

// A string/no-substitution-template literal inside a `LiteralType` (e.g.
// `Pick<X, "$executeRaw">`) is a type position — the only way a literal can
// appear in type position at all.
function isLiteralTypePosition(lit) {
  const parent = lit.getParent();
  return parent !== undefined && Node.isLiteralTypeNode(parent);
}

function literalValue(lit) {
  if (Node.isStringLiteral(lit)) return lit.getLiteralValue();
  if (Node.isNoSubstitutionTemplateLiteral(lit)) return lit.getLiteralText();
  return undefined;
}

// ---------------------------------------------------------------------------
// Layer 2 file discovery — src/, scripts/, prisma/ (recursive) + repo-root
// files (non-recursive), non-test .ts/.tsx/.mts/.cts/.js/.mjs/.cjs. Narrower,
// path-SEGMENT-based test-path matching than Layer 1's (a file literally
// named "manual-tests-helper.ts" is a real production script, not something
// under a manual-tests/ directory — it must stay in scope).
// ---------------------------------------------------------------------------
const LAYER2_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const TEST_PATH_RE = /(^|\/)(__tests__|manual-tests|e2e)(\/|$)|\.test(\.[^/]+)?$/;

// F6: a symlink entry under a scan root has `Dirent.isFile()` === false (its
// own lstat-based type is "symlink", regardless of what it points at), so the
// original `if (!entry.isFile()) continue;` guard silently DROPPED it from
// the scan — a symlink pointing at a forged file would never be analysed.
// Collected here and reported as a fail-closed reason in Main, rather than
// skipped.
let layer2SymlinksFound = [];

function listFilesRecursive(root, pathRoot) {
  const out = [];
  let dirEntries;
  try {
    dirEntries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of dirEntries) {
    if (entry.isSymbolicLink()) {
      const abs = join(entry.parentPath ?? entry.path, entry.name);
      layer2SymlinksFound.push(abs.slice(pathRoot.length).replace(/^\/+/, ""));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!LAYER2_EXTS.has(extname(entry.name))) continue;
    const abs = join(entry.parentPath ?? entry.path, entry.name);
    const rel = abs.slice(pathRoot.length).replace(/^\/+/, "");
    if (TEST_PATH_RE.test(rel)) continue;
    out.push(rel);
  }
  return out;
}

function listRootFiles(root) {
  const out = [];
  let dirEntries;
  try {
    dirEntries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of dirEntries) {
    if (entry.isSymbolicLink()) {
      layer2SymlinksFound.push(entry.name);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!LAYER2_EXTS.has(extname(entry.name))) continue;
    if (TEST_PATH_RE.test(entry.name)) continue;
    out.push(entry.name);
  }
  return out;
}

function getLayer2ScanFiles() {
  const files = [
    ...listFilesRecursive(join(ROOT, "src"), ROOT),
    ...listFilesRecursive(join(ROOT, "scripts"), ROOT),
    ...listFilesRecursive(join(ROOT, "prisma"), ROOT),
    ...listRootFiles(ROOT),
  ];
  return [...new Set(files)].sort();
}

// ---------------------------------------------------------------------------
// Specifier resolution (round 4) — ONE resolver, modelled on the filesystem,
// for every question this gate asks about a relative (`./`, `../`, `.`, `..`)
// or `@/` specifier. Rounds 1-3 resolved by pure path math and patched each
// divergence from the real loader as it was found (directory shapes, case
// variants, `?raw` suffixes); round 4 found four more (an unscanned target
// outside the test-path pattern, case-folded credit, percent-decoding, `..`
// clamped at the root). The mechanism is now: walk the candidates a Node/TS
// resolver would try, IN ITS ORDER, against the real directory listing, with
// EXACT-CASE name matching (readdir names, never existsSync — so the answer
// is the same on a case-sensitive Linux CI host and a case-insensitive
// macOS/Windows dev host), and return the first candidate that exists. A
// candidate that exists only under a different case is reported as such
// rather than silently accepted or skipped, since the two filesystem kinds
// would load different files for it.
// ---------------------------------------------------------------------------
const RESOLVE_KIND = Object.freeze({
  FILE: "file", // an existing file; `rel` is its exact on-disk spelling
  PACKAGE_DIR: "package-dir", // a directory carrying package.json ("main" is unfollowable here)
  CASE_MISMATCH: "case-mismatch", // the first existing candidate matches only case-insensitively
  NOT_FOUND: "not-found", // nothing exists; `base` is the normalized path
  ESCAPES_ROOT: "escapes-root", // `..` walks above the repository root
  SUSPICIOUS: "suspicious", // contains `%` — Node ESM percent-decodes, this resolver does not
});

// Appended in resolver order when the specifier names no existing file
// exactly (TS's .ts/.tsx first, then the JS family Node/bundlers try, then the
// CJS data/native extensions — `.json` and `.node` are real `require()`
// targets, and the predicate below must SEE them to judge them).
const RESOLVE_APPEND_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".node"];

// TS/Node ESM "rewrite relative import extensions" convention: a specifier may
// spell the COMPILED extension while resolving to the TS SOURCE file of the
// same stem. Tried only AFTER the exact path, so a real `raw-sql.js` sibling
// wins over the rewrite exactly as it does for the real resolver.
const TS_REWRITE_EXTS = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

function stripSpecifierSuffix(spec) {
  return spec.replace(/[?#].*$/, "");
}

function isRepoShapedSpecifier(spec) {
  return (
    spec.startsWith("@/") ||
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec === "." ||
    spec === ".."
  );
}

function specifierParts(fromRel, spec) {
  if (spec.startsWith("@/")) return ["src", ...spec.slice(2).split("/")];
  return [...fromRel.split("/").slice(0, -1), ...spec.split("/")];
}

const dirEntryCache = new Map();
function readDirEntries(relDir) {
  if (dirEntryCache.has(relDir)) return dirEntryCache.get(relDir);
  let entries = null;
  try {
    entries = readdirSync(join(ROOT, relDir), { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
  }
  dirEntryCache.set(relDir, entries);
  return entries;
}

// Segment-by-segment lookup of a ROOT-relative path against readdir names.
// Returns { exact, rel, isDirectory } (rel = the on-disk spelling) or
// undefined. Anything existing that is not a directory (a symlink included)
// counts as a file — it exists, and the predicate below judges it.
function lookupPath(relPath) {
  let dir = "";
  let exact = true;
  let entry;
  for (const seg of relPath.split("/")) {
    const entries = readDirEntries(dir);
    if (entries === null) return undefined;
    entry = entries.find((e) => e.name === seg);
    if (entry === undefined) {
      const lower = seg.toLowerCase();
      entry = entries.find((e) => e.name.toLowerCase() === lower);
      if (entry === undefined) return undefined;
      exact = false;
    }
    dir = dir === "" ? entry.name : `${dir}/${entry.name}`;
  }
  return { exact, rel: dir, isDirectory: entry.isDirectory() };
}

function resolveOnDisk(fromRel, spec) {
  if (!isRepoShapedSpecifier(spec)) return undefined;
  if (spec.includes("%")) return { kind: RESOLVE_KIND.SUSPICIOUS };
  const stripped = stripSpecifierSuffix(spec);
  const rawParts = specifierParts(fromRel, stripped);
  const stack = [];
  for (const part of rawParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return { kind: RESOLVE_KIND.ESCAPES_ROOT };
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  const base = stack.join("/");
  // A last raw segment of "", "." or ".." forces directory resolution — the
  // file candidates are never tried for that shape (S-R3-1a).
  const lastRaw = stripped.split("/").pop();
  const directoryOnly = lastRaw === "" || lastRaw === "." || lastRaw === "..";

  if (!directoryOnly && base !== "") {
    const ext = extname(base);
    const stem = base.slice(0, base.length - ext.length);
    const fileCandidates = [
      base,
      ...(TS_REWRITE_EXTS[ext] ?? []).map((e) => `${stem}${e}`),
      ...RESOLVE_APPEND_EXTS.map((e) => `${base}${e}`),
    ];
    for (const candidate of fileCandidates) {
      const hit = lookupPath(candidate);
      if (hit === undefined || hit.isDirectory) continue;
      return hit.exact
        ? { kind: RESOLVE_KIND.FILE, rel: hit.rel }
        : { kind: RESOLVE_KIND.CASE_MISMATCH, rel: hit.rel };
    }
  }

  const dirHit = base === "" ? { exact: true, rel: "", isDirectory: true } : lookupPath(base);
  if (dirHit !== undefined && dirHit.isDirectory) {
    if (!dirHit.exact) return { kind: RESOLVE_KIND.CASE_MISMATCH, rel: dirHit.rel };
    const prefix = dirHit.rel === "" ? "" : `${dirHit.rel}/`;
    if (lookupPath(`${prefix}package.json`) !== undefined) {
      return { kind: RESOLVE_KIND.PACKAGE_DIR, rel: dirHit.rel };
    }
    for (const e of RESOLVE_APPEND_EXTS) {
      const hit = lookupPath(`${prefix}index${e}`);
      if (hit === undefined || hit.isDirectory) continue;
      return hit.exact
        ? { kind: RESOLVE_KIND.FILE, rel: hit.rel }
        : { kind: RESOLVE_KIND.CASE_MISMATCH, rel: hit.rel };
    }
  }
  return { kind: RESOLVE_KIND.NOT_FOUND, base };
}

// GRANT side (case-sensitive, on-disk): a specifier is a canonical raw-sql.ts
// import iff the resolver lands EXACTLY on RAW_SQL_MODULE_REL. Nothing else —
// a case variant, a directory, a clamped `..`, a missing file — earns credit.
function resolvesToRawSqlModule(fromRel, spec) {
  const r = resolveOnDisk(fromRel, spec);
  return r !== undefined && r.kind === RESOLVE_KIND.FILE && r.rel === RAW_SQL_MODULE_REL;
}

// DENY side (deliberately over-broad, case-insensitive path math): does this
// specifier NAME raw-sql.ts in any spelling — any case, a code extension, an
// `/index` suffix, `..` clamped at the root? Used only where a match DENIES
// (module-loading forms of raw-sql.ts, a raw-sql specifier literal outside an
// import declaration), so over-matching can only fail closed.
const RAW_SQL_BASE_REL_LOWER = RAW_SQL_MODULE_REL.replace(/\.ts$/, "").toLowerCase();
function namesRawSqlModule(fromRel, spec) {
  if (resolvesToRawSqlModule(fromRel, spec)) return true;
  if (!isRepoShapedSpecifier(spec)) return false;
  const stack = [];
  for (const part of specifierParts(fromRel, stripSpecifierSuffix(spec))) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const lower = stack
    .join("/")
    .toLowerCase()
    .replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "")
    .replace(/\/index$/, "");
  return lower === RAW_SQL_BASE_REL_LOWER;
}

// Populated from the real Layer 2 scan list before any file is checked (see
// Main below): the exact-case set of files this gate actually analyses.
let scannedFiles = new Set();

// Files the UNSCANNED_IMPORT predicate lets a specifier reach although the
// gate never parses them: data, never code. Exact case — Node's CJS loader
// picks a loader by exact extension, so `x.JSON` is loaded as JavaScript.
// Measured on the real tree: `.json` is the only extension needed.
const UNSCANNED_DATA_EXTS = new Set([".json"]);

function unscannedFileReason(rel) {
  if (scannedFiles.has(rel)) return undefined;
  if (UNSCANNED_DATA_EXTS.has(extname(rel))) return undefined;
  return `resolves to "${rel}", a file outside the Layer 2 scan`;
}

/**
 * UNSCANNED_IMPORT predicate: the reason `spec` (seen in `fromRel`) reaches
 * code this gate does not analyse, or undefined when it does not.
 */
function unscannedTargetReason(fromRel, spec) {
  const r = resolveOnDisk(fromRel, spec);
  if (r === undefined) return undefined;
  switch (r.kind) {
    case RESOLVE_KIND.ESCAPES_ROOT:
      return "walks above the repository root";
    case RESOLVE_KIND.SUSPICIOUS:
      return "contains '%' (Node ESM percent-decodes a specifier; this gate does not)";
    case RESOLVE_KIND.CASE_MISMATCH:
      return `matches "${r.rel}" only case-insensitively (case-sensitive and case-insensitive filesystems would load different files)`;
    case RESOLVE_KIND.PACKAGE_DIR:
      return `resolves to "${r.rel}/", a directory carrying package.json whose "main" this gate cannot follow`;
    case RESOLVE_KIND.FILE:
      return unscannedFileReason(r.rel);
    case RESOLVE_KIND.NOT_FOUND:
      // Nothing on disk yet: fall back to the test-path shape, matched
      // case-insensitively, so a not-yet-existing test path still denies.
      return TEST_PATH_RE.test(r.base.toLowerCase()) ? "resolves into an excluded test path" : undefined;
    default:
      return `unrecognized resolution "${r.kind}"`;
  }
}

// A literal made only of `.`/`..` segments, outside a module-specifier
// position, is a directory path — `new URL("../..", import.meta.url)` /
// `resolve(dir, "..")`, the repo-root idiom across scripts/. Handed to a
// loader under another name it reaches only an ancestor directory of the
// file: above the repo root nothing a PR can place (allowed); inside the repo
// that directory's package.json "main"/"exports" (denied when either is
// present) or else its index file, judged like any other target. Judged by
// this rule rather than by per-file exemptions, which every new script using
// the idiom would otherwise need. Module-specifier positions stay on
// unscannedTargetReason, where every one of these results denies.
const ANCESTOR_DIR_LITERAL_RE = /^\.{1,2}(\/\.{1,2})*\/?$/;
function ancestorDirLiteralReason(fromRel, spec) {
  const r = resolveOnDisk(fromRel, spec);
  if (r === undefined || r.kind === RESOLVE_KIND.ESCAPES_ROOT) return undefined;
  if (r.kind !== RESOLVE_KIND.PACKAGE_DIR) return unscannedTargetReason(fromRel, spec);
  const prefix = r.rel === "" ? "" : `${r.rel}/`;
  const pkg = JSON.parse(readFileSync(join(ROOT, `${prefix}package.json`), "utf8"));
  if (pkg.main !== undefined || pkg.exports !== undefined) {
    return `resolves to "${r.rel}/", a directory whose package.json "main"/"exports" this gate cannot follow`;
  }
  for (const e of RESOLVE_APPEND_EXTS) {
    const hit = lookupPath(`${prefix}index${e}`);
    if (hit === undefined || hit.isDirectory) continue;
    return hit.exact ? unscannedFileReason(hit.rel) : `matches "${hit.rel}" only case-insensitively`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Violations — collected per-reason, printed in the existing REASON: style.
// ---------------------------------------------------------------------------
const violationsByReason = new Map();
function violate(reason, file, line, detail) {
  if (!violationsByReason.has(reason)) violationsByReason.set(reason, []);
  violationsByReason.get(reason).push({ file, line, detail });
}

function lineOf(node) {
  return node.getStartLineNumber();
}

// ---------------------------------------------------------------------------
// UNSAFE_ARG — an Unsafe call's first argument must be a string literal, a
// no-substitution template, or a direct `renderSql(...)` call.
// ---------------------------------------------------------------------------
function checkUnsafeArg(sf, rel) {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (!/^\$(query|execute)RawUnsafe$/.test(callee.getName())) continue;

    const args = call.getArguments();
    const arg0 = args[0];
    const isAllowed =
      arg0 !== undefined &&
      (Node.isStringLiteral(arg0) ||
        Node.isNoSubstitutionTemplateLiteral(arg0) ||
        (Node.isCallExpression(arg0) &&
          Node.isIdentifier(arg0.getExpression()) &&
          arg0.getExpression().getText() === "renderSql"));

    if (!isAllowed) {
      violate(
        "UNSAFE_ARG",
        rel,
        lineOf(call),
        `${callee.getName()}(...) first argument is not a string literal, a no-substitution template, or a direct renderSql(...) call`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// RAW_SQL_NAMES — positional allowlist over every occurrence of the four
// raw-sql.ts exports, plus the module-loading-form and non-literal
// import()/require() checks that need no name occurrence at all.
// ---------------------------------------------------------------------------
function isAllowedRawSqlNameOccurrence(id, name, canonicallyImported) {
  const parent = id.getParent();
  if (parent === undefined) return false;

  if (TYPE_POSITION_PARENT_KINDS.has(parent.getKind())) return true; // type position
  if (Node.isQualifiedName(parent)) return isQualifiedNameInTypePosition(parent);

  if (Node.isCallExpression(parent) && parent.getExpression() === id) {
    // Ordinary-call callee: allowed for renderSql / sqlIdentifier / joinSql,
    // NOT for trustedSql (tag-only) — AND (F4-a) only when THIS file also
    // holds a canonical import of that name from raw-sql.ts. Without this, a
    // call positionally shaped like `renderSql(f)` passes even when `renderSql`
    // is a global injected by `globalThis.renderSql = …` or a same-named
    // local forged some other way — the position alone proves nothing about
    // what the name is bound to.
    if (name === "trustedSql") return false;
    return canonicallyImported.has(name);
  }

  if (Node.isTaggedTemplateExpression(parent) && parent.getTag() === id) {
    // Tagged-template tag: allowed ONLY for trustedSql, and only with a
    // canonical import present (F4-a, same reasoning as the call case above).
    return name === "trustedSql" && canonicallyImported.has(name);
  }

  if (Node.isImportSpecifier(parent) && parent.getNameNode() === id) {
    if (parent.getNameNode().getKind() === SyntaxKind.StringLiteral) return false; // string-named import
    if (parent.getAliasNode() !== undefined) return false; // aliased
    if (parent.isTypeOnly()) return false;
    const importDecl = parent.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (importDecl === undefined || importDecl.isTypeOnly()) return false;
    return resolvesToRawSqlModule(currentRel, importDecl.getModuleSpecifierValue());
  }

  return false; // default deny: declarations of any kind, re-export, argument, .call/.apply/.bind, etc.
}

// currentRel is threaded via a module-level variable set by the caller, since
// isAllowedRawSqlNameOccurrence needs to resolve the enclosing file's path to
// judge an import specifier — kept simple rather than passing rel through
// every ts-morph callback signature.
let currentRel = "";

// F4-a: the set of RAW_SQL_NAMES this file canonically imports from
// raw-sql.ts (unaliased, not type-only, not string-named) — a call/tag
// occurrence is allowed only when its name is a member of this set, so a
// same-named global or local can never satisfy the positional check alone.
function collectCanonicallyImportedRawSqlNames(sf, rel) {
  const names = new Set();
  for (const imp of sf.getImportDeclarations()) {
    if (imp.isTypeOnly()) continue;
    if (!resolvesToRawSqlModule(rel, imp.getModuleSpecifierValue())) continue;
    for (const ni of imp.getNamedImports()) {
      if (ni.isTypeOnly()) continue;
      if (ni.getAliasNode() !== undefined) continue;
      if (ni.getNameNode().getKind() === SyntaxKind.StringLiteral) continue;
      const name = ni.getName();
      if (RAW_SQL_NAMES.includes(name)) names.add(name);
    }
  }
  return names;
}

// F4-b: a decoded string / no-substitution-template literal equal to one of
// the four raw-sql.ts export names, in expression position, denies — this is
// how a literal-keyed forge (`globalThis["renderSql"] = …`,
// `Object.assign(globalThis, {"renderSql": …})`,
// `Object.defineProperty(globalThis, 'trustedSql', …)`) spells the name
// without ever producing an Identifier occurrence the scan above would see.
// raw-sql.ts itself and this gate's own source (which spells the four names
// as RAW_SQL_NAMES array data) are exempt.
function checkRawSqlNameLiterals(sf, rel) {
  if (rel === RAW_SQL_MODULE_REL || rel === GATE_SELF_REL) return;
  const literals = [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ];
  for (const lit of literals) {
    if (isLiteralTypePosition(lit)) continue;
    const value = literalValue(lit);
    if (value !== undefined && RAW_SQL_NAMES.includes(value)) {
      violate("RAW_SQL_NAMES", rel, lineOf(lit), `literal value "${value}"`);
    }
  }
}

// F4-c (part 1): a scanned file other than raw-sql.ts itself that sits at a
// `raw-sql.<ext>` SIBLING of raw-sql.ts, for any OTHER scanned extension — N2:
// including `.tsx`, since Next/esbuild resolve `.tsx` before `.ts` — is a
// SHADOW FILE: a resolver would load it instead of the TS source for a
// specifier that reaches that path (the grant side never credits it — it is
// not RAW_SQL_MODULE_REL — but its existence alone denies, matched
// case-insensitively). The `raw-sql/index.<ext>`
// DIRECTORY-module form (any extension, `.ts` included) is handled
// separately by checkRawSqlDirectoryShadow (S-R3-1b) below, which denies on
// the directory's mere EXISTENCE on disk — a package.json "main" inside it
// could point anywhere, including a file outside LAYER2_EXTS entirely, so no
// per-extension candidate list here could ever be complete.
const RAW_SQL_BASE_REL = RAW_SQL_MODULE_REL.replace(/\.ts$/, "");
const LAYER2_EXT_NAMES = [...LAYER2_EXTS].map((ext) => ext.slice(1)); // ".ts" -> "ts"
const RAW_SQL_SHADOW_PATHS = new Set(
  LAYER2_EXT_NAMES.filter((ext) => ext !== "ts")
    .map((ext) => `${RAW_SQL_BASE_REL}.${ext}`)
    .map((p) => p.toLowerCase()),
);
function checkRawSqlShadowFile(rel) {
  if (rel === RAW_SQL_MODULE_REL) return;
  if (RAW_SQL_SHADOW_PATHS.has(rel.toLowerCase())) {
    violate(
      "RAW_SQL_NAMES",
      rel,
      1,
      "shadows src/lib/prisma/raw-sql.ts's module resolution — a specifier resolving here would load THIS file at runtime, not raw-sql.ts",
    );
  }
}

// S-R3-1(b): a `src/lib/prisma/raw-sql/` DIRECTORY denies unconditionally,
// regardless of what sits inside it — including a package.json "main" field
// pointing at a file this gate never scans (e.g. an unscanned *.test.ts
// forging renderSql), since package.json is not in LAYER2_EXTS and never
// reaches checkRawSqlShadowFile above. The resolver above never credits a
// directory as raw-sql.ts (a `…/raw-sql/` specifier resolves to the
// directory, never to the file), so this is defense in depth: a second
// module under raw-sql.ts's own name has no legitimate reason to exist —
// checked directly against the on-disk entries of its parent directory
// (case-insensitive), never against the Layer 2 scan list, since a
// package.json inside it would never appear there.
function checkRawSqlDirectoryShadow() {
  const parentDir = join(ROOT, dirname(RAW_SQL_MODULE_REL)); // src/lib/prisma
  const targetName = RAW_SQL_BASE_REL.split("/").pop().toLowerCase(); // "raw-sql"
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.toLowerCase() !== targetName) continue;
    if (!entry.isDirectory()) continue; // a same-named FILE is RAW_SQL_MODULE_REL itself or a sibling, handled elsewhere
    violate(
      "RAW_SQL_NAMES",
      `${RAW_SQL_BASE_REL}/`,
      1,
      `src/lib/prisma/raw-sql/ exists as a directory — Node's resolver would load it (including an unscanned package.json "main") instead of raw-sql.ts for any specifier reaching "…/raw-sql" without an explicit extension`,
    );
  }
}

function checkRawSqlNames(sf, rel) {
  checkRawSqlShadowFile(rel);
  if (rel === RAW_SQL_MODULE_REL) return; // exempt: this is where the names are declared

  currentRel = rel;
  checkRawSqlNameLiterals(sf, rel);
  const canonicallyImported = collectCanonicallyImportedRawSqlNames(sf, rel);
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const name = id.getText();
    if (!RAW_SQL_NAMES.includes(name)) continue;
    if (isTypePositionIdentifier(id)) continue;
    if (!isAllowedRawSqlNameOccurrence(id, name, canonicallyImported)) {
      violate("RAW_SQL_NAMES", rel, lineOf(id), `"${name}" occurs outside an allowed position`);
    }
  }

  // String-named import (`import { "sqlIdentifier" as si }`) / export, on
  // either side of `as` (`export { x as "trustedSql" }` puts the restricted
  // name on the ALIAS side) — a StringLiteral name never surfaces as an
  // Identifier occurrence above.
  for (const imp of sf.getDescendantsOfKind(SyntaxKind.ImportSpecifier)) {
    const nameNode = imp.getNameNode();
    if (nameNode.getKind() === SyntaxKind.StringLiteral) {
      const value = nameNode.getLiteralValue();
      if (RAW_SQL_NAMES.includes(value)) {
        violate("RAW_SQL_NAMES", rel, lineOf(imp), `string-named import "${value}"`);
      }
    }
  }
  for (const exp of sf.getDescendantsOfKind(SyntaxKind.ExportSpecifier)) {
    const nameNode = exp.getNameNode();
    if (nameNode.getKind() === SyntaxKind.StringLiteral) {
      const value = nameNode.getLiteralValue();
      if (RAW_SQL_NAMES.includes(value)) {
        violate("RAW_SQL_NAMES", rel, lineOf(exp), `string-named export source "${value}"`);
      }
    }
    const aliasNode = exp.getAliasNode();
    if (aliasNode !== undefined && aliasNode.getKind() === SyntaxKind.StringLiteral) {
      const value = aliasNode.getLiteralValue();
      if (RAW_SQL_NAMES.includes(value)) {
        violate("RAW_SQL_NAMES", rel, lineOf(exp), `string-named export alias "${value}"`);
      }
    }
  }

  // Module-loading forms that never spell a raw-sql name as text at all:
  // namespace/default import, `export * from` / `export * as ns from`,
  // `require()`, `import()`, `import x = require()`.
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!namesRawSqlModule(rel, spec)) continue;
    if (imp.getNamespaceImport() !== undefined || imp.getDefaultImport() !== undefined) {
      violate("RAW_SQL_NAMES", rel, lineOf(imp), "namespace or default import of raw-sql.ts");
    } else if (imp.getNamedImports().length === 0) {
      violate("RAW_SQL_NAMES", rel, lineOf(imp), "side-effect import of raw-sql.ts");
    }
  }
  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (spec !== undefined && namesRawSqlModule(rel, spec)) {
      violate("RAW_SQL_NAMES", rel, lineOf(exp), "export ... from raw-sql.ts");
    }
  }
  for (const ieq of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const ref = ieq.getModuleReference();
    if (Node.isExternalModuleReference(ref)) {
      const expr = ref.getExpression();
      if (Node.isStringLiteral(expr) && namesRawSqlModule(rel, expr.getLiteralValue())) {
        violate("RAW_SQL_NAMES", rel, lineOf(ieq), "import x = require(raw-sql.ts)");
      }
    }
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const isRequire = Node.isIdentifier(expr) && expr.getText() === "require";
    const isDynamicImport = expr.getKind() === SyntaxKind.ImportKeyword;
    if (!isRequire && !isDynamicImport) continue;
    const arg0 = call.getArguments()[0];
    const isLiteralArg =
      arg0 !== undefined &&
      (Node.isStringLiteral(arg0) || Node.isNoSubstitutionTemplateLiteral(arg0));
    // A computed specifier is the declared residual: the gate cannot tell what
    // it loads, and refusing every one would deny legitimate loaders.
    if (!isLiteralArg) continue;
    const value = literalValue(arg0);
    if (value !== undefined && namesRawSqlModule(rel, value)) {
      violate("RAW_SQL_NAMES", rel, lineOf(call), `${isRequire ? "require()" : "import()"} of raw-sql.ts`);
    }
  }
}

// ---------------------------------------------------------------------------
// SPECIFIER_LITERAL — a string/no-substitution-template literal, in
// expression position, matching the Prisma pattern or resolving to
// raw-sql.ts, denies unless it IS the specifier of a static import/export
// declaration.
// ---------------------------------------------------------------------------
function checkSpecifierLiteral(sf, rel) {
  if (rel === GATE_SELF_REL) return; // exempt: spells the allowed specifiers as data

  const literals = [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ];
  for (const lit of literals) {
    if (isLiteralTypePosition(lit)) continue;
    const value = literalValue(lit);
    if (value === undefined) continue;

    const matchesPrisma = hasPrismaPathSegment(value);
    const matchesRawSql = namesRawSqlModule(rel, value);
    if (!matchesPrisma && !matchesRawSql) continue;

    const parent = lit.getParent();
    const isDeclarationSpecifier =
      parent !== undefined &&
      (Node.isImportDeclaration(parent) || Node.isExportDeclaration(parent));
    if (!isDeclarationSpecifier) {
      violate(
        "SPECIFIER_LITERAL",
        rel,
        lineOf(lit),
        `literal "${value}" matches a restricted specifier pattern outside an import/export declaration`,
      );
    }
  }
}

// F2: a `node_modules` path segment in a MODULE-SPECIFIER position denies —
// independent of the Prisma/raw-sql checks above, which only fire for a
// specifier that names one of THOSE targets. Scoped to specifier positions
// only (not any string anywhere) so an unrelated log message or error string
// mentioning "node_modules" is not denied.
function checkNodeModulesSpecifier(sf, rel) {
  if (rel === GATE_SELF_REL) return; // exempt: spells example specifiers as data

  const literals = [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ];
  for (const lit of literals) {
    if (isLiteralTypePosition(lit)) continue;
    if (!isModuleSpecifierPositionLiteral(lit)) continue;
    const value = literalValue(lit);
    if (value !== undefined && hasNodeModulesSegment(value)) {
      violate(
        "SPECIFIER_LITERAL",
        rel,
        lineOf(lit),
        `module specifier "${value}" reaches into node_modules by path`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// UNSCANNED_IMPORT — one predicate (unscannedTargetReason above), two scans:
// checkUnscannedImport inspects the module-specifier positions (import/export
// declaration, `import x = require()`, a `require()`/`import()` call's literal
// first argument — F3), and checkUnscannedLiteralAnywhere (N1) inspects every
// OTHER expression-position literal, since a loader reached under another
// name (`createRequire(...)(...)`, `module.require(...)`, `require.call(...)`,
// `new Worker(new URL(...))`, …) still spells its target as a plain literal.
// The second scan skips the positions the first already inspected
// (isModuleSpecifierPositionLiteral), so a literal is reported once.
//
// The measured exemption is PER (file, literal value) with an exact count,
// shared by both scans: any OTHER unscanned-target literal in an exempted
// file (a different value, or the same value past its count) still denies,
// the count must match exactly (a removal is drift too), and a file not
// listed here gets no exemption at all.
// ---------------------------------------------------------------------------
//
// Measured on the real tree (round 4). Counts are of OCCURRENCES of the
// value in the two scans, whether or not it currently resolves to an
// unscanned target — so the count does not depend on what happens to exist
// on disk (`.next/` is generated and absent on a fresh CI checkout).
const UNSCANNED_LITERAL_EXEMPTIONS = new Map([
  [
    "scripts/checks/classify-fail-closed-test.mjs",
    // names the shared fail-closed test helper it classifies OTHER files
    // against — never itself loads it.
    new Map([["@/__tests__/helpers/fail-closed", 1]]),
  ],
  [
    "scripts/generate-team-key-fixture.ts",
    // imports the extension's crypto code on purpose, to capture a
    // cross-codebase golden fixture; extension/ is outside the Layer 2 scan.
    new Map([
      ["../extension/src/lib/crypto-team.ts", 1],
      ["../extension/src/lib/crypto.ts", 1],
    ]),
  ],
  [
    "next-env.d.ts",
    // Next-generated: references its own generated route types.
    new Map([
      ["./.next/types/routes.d.ts", 1],
      ["./.next/types/root-params.d.ts", 1],
    ]),
  ],
  ["src/app/layout.tsx", new Map([["./globals.css", 1]])], // bundler CSS import
]);

function newUnscannedTally(rel) {
  return { exemptions: UNSCANNED_LITERAL_EXEMPTIONS.get(rel), seen: new Map() };
}

function judgeUnscanned(tally, rel, line, value, what, reasonFor = unscannedTargetReason) {
  if (tally.exemptions !== undefined && tally.exemptions.has(value)) {
    tally.seen.set(value, (tally.seen.get(value) ?? 0) + 1);
    return;
  }
  const reason = reasonFor(rel, value);
  if (reason === undefined) return;
  violate("UNSCANNED_IMPORT", rel, line, `${what} "${value}" ${reason}`);
}

function checkUnscannedImport(sf, rel, tally) {
  for (const imp of sf.getImportDeclarations()) {
    judgeUnscanned(tally, rel, lineOf(imp), imp.getModuleSpecifierValue(), "import specifier");
  }
  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (spec !== undefined) judgeUnscanned(tally, rel, lineOf(exp), spec, "export specifier");
  }
  for (const ieq of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const ref = ieq.getModuleReference();
    if (!Node.isExternalModuleReference(ref)) continue;
    const expr = ref.getExpression();
    const value = Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)
      ? literalValue(expr)
      : undefined;
    if (value !== undefined) judgeUnscanned(tally, rel, lineOf(ieq), value, "import x = require()");
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const isRequire = Node.isIdentifier(expr) && expr.getText() === "require";
    const isDynamicImport = expr.getKind() === SyntaxKind.ImportKeyword;
    if (!isRequire && !isDynamicImport) continue;
    const arg0 = call.getArguments()[0];
    if (arg0 === undefined) continue;
    const value = literalValue(arg0);
    if (value !== undefined) {
      judgeUnscanned(tally, rel, lineOf(call), value, isRequire ? "require() of" : "import() of");
    }
  }
}

function checkUnscannedLiteralAnywhere(sf, rel, tally) {
  if (rel === GATE_SELF_REL) return; // exempt: spells example specifiers as data

  const literals = [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ];
  for (const lit of literals) {
    if (isLiteralTypePosition(lit)) continue;
    if (isModuleSpecifierPositionLiteral(lit)) continue; // already inspected by checkUnscannedImport
    const value = literalValue(lit);
    if (value === undefined) continue;
    const reasonFor = ANCESTOR_DIR_LITERAL_RE.test(value) ? ancestorDirLiteralReason : unscannedTargetReason;
    judgeUnscanned(tally, rel, lineOf(lit), value, "literal", reasonFor);
  }
}

function checkUnscannedExemptionCounts(rel, tally) {
  if (tally.exemptions === undefined) return;
  for (const [value, expectedCount] of tally.exemptions) {
    const actualCount = tally.seen.get(value) ?? 0;
    if (actualCount !== expectedCount) {
      violate(
        "UNSCANNED_IMPORT",
        rel,
        1,
        `"${value}" appears ${actualCount} time(s) in ${rel}; the measured exemption expects ${expectedCount} — the exempted set drifted; update UNSCANNED_LITERAL_EXEMPTIONS in scripts/checks/check-raw-sql-usage.mjs if intentional`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// RAW_METHOD — /^\$(query|execute)Raw\w*$/ in expression position.
// ---------------------------------------------------------------------------
function isAllowedRawMethodPropertyAccess(pae) {
  const name = pae.getName();
  const parent = pae.getParent();
  if (parent === undefined) return false;

  if (/^\$(query|execute)Raw$/.test(name)) {
    return Node.isTaggedTemplateExpression(parent) && parent.getTag() === pae;
  }
  if (/^\$(query|execute)RawUnsafe$/.test(name)) {
    return Node.isCallExpression(parent) && parent.getExpression() === pae;
  }
  return false; // …Internal / …Typed / any other suffix: never allowed
}

function checkRawMethod(sf, rel) {
  // Identifier occurrences, classified by role via the parent node.
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const name = id.getText();
    if (!RAW_METHOD_RE.test(name)) continue;
    if (isTypePositionIdentifier(id)) continue;

    const parent = id.getParent();
    if (parent !== undefined && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) {
      if (!isAllowedRawMethodPropertyAccess(parent)) {
        violate("RAW_METHOD", rel, lineOf(id), `"${name}" property access outside an allowed form`);
      }
      continue;
    }
    if (parent !== undefined && Node.isImportSpecifier(parent)) continue; // not a real Prisma spelling; ignore
    if (parent !== undefined && Node.isExportSpecifier(parent)) continue;
    // Bare identifier reference (variable, shorthand property, argument, …) — never allowed.
    violate("RAW_METHOD", rel, lineOf(id), `bare identifier "${name}"`);
  }

  // Literal-VALUE clause — scripts/checks/** is exempt from this clause only.
  if (rel.startsWith(SCRIPTS_CHECKS_PREFIX)) return;
  const literals = [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ];
  for (const lit of literals) {
    if (isLiteralTypePosition(lit)) continue;
    const value = literalValue(lit);
    if (value !== undefined && RAW_METHOD_RE.test(value)) {
      violate("RAW_METHOD", rel, lineOf(lit), `literal value "${value}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// PRISMA_IMPORT — @prisma/* / .prisma/* specifier allowlist + Prisma.<member>
// expression-position allowlist + enum/export-name disjointness.
// ---------------------------------------------------------------------------
function checkPrismaImportDeclarations(sf, rel) {
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!hasPrismaPathSegment(spec)) continue;

    const isClient = /^@prisma\/client$/i.test(spec);
    const isAdapterPg = /^@prisma\/adapter-pg$/i.test(spec);

    if (isAdapterPg) {
      if (!ADAPTER_PG_ALLOWED_FILES.has(rel)) {
        violate("PRISMA_IMPORT", rel, lineOf(imp), `new @prisma/adapter-pg importer "${rel}"`);
      }
      continue;
    }

    if (!isClient) {
      violate("PRISMA_IMPORT", rel, lineOf(imp), `disallowed specifier "${spec}"`);
      continue;
    }

    if (imp.isTypeOnly()) continue; // type-only @prisma/client import: unrestricted

    if (imp.getNamespaceImport() !== undefined) {
      violate("PRISMA_IMPORT", rel, lineOf(imp), "namespace import of @prisma/client");
      continue;
    }
    if (imp.getDefaultImport() !== undefined) {
      violate("PRISMA_IMPORT", rel, lineOf(imp), "default import of @prisma/client");
      continue;
    }

    const enumNames = getSchemaEnumNames();
    const allowedValueNames = new Set(["PrismaClient", "Prisma", ...enumNames]);
    for (const ni of imp.getNamedImports()) {
      if (ni.isTypeOnly()) continue; // per-specifier type-only: unrestricted
      const name = ni.getName();
      const isStringNamed = ni.getNameNode().getKind() === SyntaxKind.StringLiteral;
      const isAliased = ni.getAliasNode() !== undefined;
      if (isStringNamed || isAliased || !allowedValueNames.has(name)) {
        violate(
          "PRISMA_IMPORT",
          rel,
          lineOf(ni),
          `value import "${name}" from @prisma/client is not PrismaClient, Prisma, or a declared enum (unaliased)`,
        );
      }
    }
  }

  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (spec !== undefined && hasPrismaPathSegment(spec)) {
      violate("PRISMA_IMPORT", rel, lineOf(exp), `export ... from "${spec}"`);
    }
  }
}

function checkPrismaExpressionMembers(sf, rel) {
  for (const pae of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const obj = pae.getExpression();
    if (!Node.isIdentifier(obj) || obj.getText() !== "Prisma") continue;
    const member = pae.getName();
    if (!PRISMA_ALLOWED_EXPRESSION_MEMBERS.has(member)) {
      violate("PRISMA_IMPORT", rel, lineOf(pae), `Prisma.${member} is not an allowed expression-position member`);
    }
  }
  for (const eae of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const obj = eae.getExpression();
    if (Node.isIdentifier(obj) && obj.getText() === "Prisma") {
      violate("PRISMA_IMPORT", rel, lineOf(eae), "Prisma[...] computed access");
    }
  }
  // Any other bare `Prisma` reference in expression position (destructuring,
  // aliasing to a new local, passed as an argument) that is not the object of
  // one of the two forms above.
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== "Prisma") continue;
    if (isTypePositionIdentifier(id)) continue; // filters genuine `Prisma.<Type>` QualifiedNames (F1)
    const parent = id.getParent();
    if (parent === undefined) continue;
    // No separate `Node.isQualifiedName(parent)` shortcut here (F1): a
    // QualifiedName that reaches this point is an `import x = Prisma.…`
    // entity name, which isTypePositionIdentifier above has already
    // classified as NOT a type position — it must fall through to the
    // violate() below, not be waved through as "type position".
    if (Node.isImportSpecifier(parent) && parent.getNameNode() === id) continue; // the import itself
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === id) continue; // handled above
    if (Node.isElementAccessExpression(parent) && parent.getExpression() === id) continue; // handled above
    violate("PRISMA_IMPORT", rel, lineOf(id), "bare Prisma reference outside Prisma.<allowed member>");
  }
}

let schemaEnumNamesCache;
function getSchemaEnumNames() {
  if (schemaEnumNamesCache !== undefined) return schemaEnumNamesCache;
  let text = "";
  if (existsSync(SCHEMA_FILE)) text = readFileSync(SCHEMA_FILE, "utf8");
  const names = [];
  const re = /^enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;
  let m;
  while ((m = re.exec(text)) !== null) names.push(m[1]);
  schemaEnumNamesCache = names;
  return names;
}

function checkPrismaEnumDisjointness() {
  const enumNames = getSchemaEnumNames();
  const collisions = enumNames.filter((n) => PRISMA_CLIENT_NON_ENUM_EXPORT_NAMES.has(n));
  if (collisions.length > 0) {
    failed = true;
    console.error(
      "PRISMA_ENUM_NAME_COLLISION: prisma/schema.prisma declares an enum whose name collides with a known non-enum top-level @prisma/client export — the PRISMA_IMPORT value-import allowlist cannot safely admit it:",
    );
    for (const c of collisions) console.error(`  ${c}`);
    console.error("");
  }
}

// ---------------------------------------------------------------------------
// PRISMA_EXTENDS — `$extends` denies unconditionally in expression position.
//
// Matched via a RegExp literal (EXTENDS_RE), never a plain string literal
// equal to "$extends" — a plain string literal with that exact value would
// make this gate's OWN source self-deny when it scans itself (scripts/checks
// has no PRISMA_EXTENDS exemption, unlike RAW_METHOD's literal-content
// clause).
// ---------------------------------------------------------------------------
const EXTENDS_RE = /^\$extends$/;

function checkPrismaExtends(sf, rel) {
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (!EXTENDS_RE.test(id.getText())) continue;
    if (isTypePositionIdentifier(id)) continue;
    const parent = id.getParent();
    if (parent !== undefined && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) {
      violate("PRISMA_EXTENDS", rel, lineOf(id), "$extends property access");
      continue;
    }
    if (parent !== undefined && (Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent))) continue;
    violate("PRISMA_EXTENDS", rel, lineOf(id), "$extends identifier");
  }
  const literals = [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ];
  for (const lit of literals) {
    if (isLiteralTypePosition(lit)) continue;
    const value = literalValue(lit);
    if (value !== undefined && EXTENDS_RE.test(value)) {
      violate("PRISMA_EXTENDS", rel, lineOf(lit), `literal value "${value}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// NON_LITERAL_IMPORT (D-5 refinement) — a non-literal `import()`/`require()`
// argument is a tripwire everywhere EXCEPT a measured allowlist of the three
// files that load a module by a computed specifier on purpose today (a tsx
// loader over an absolute path, the i18n namespace loader, the crypto WASM
// loader). Re-measure with `grep -c "await import("` on a count change; a
// MISMATCH in an allowlisted file's count denies too, so the audited set
// cannot drift silently in either direction.
// ---------------------------------------------------------------------------
const NON_LITERAL_IMPORT_ALLOWLIST = new Map([
  ["scripts/check-env-docs.ts", 4],
  ["src/i18n/messages.ts", 2],
  ["src/lib/crypto/crypto-client.ts", 1],
]);

function checkNonLiteralImportSpecifiers(sf, rel) {
  let count = 0;
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const isRequire = Node.isIdentifier(expr) && expr.getText() === "require";
    const isDynamicImport = expr.getKind() === SyntaxKind.ImportKeyword;
    if (!isRequire && !isDynamicImport) continue;
    const arg0 = call.getArguments()[0];
    if (arg0 === undefined) continue;
    const isLiteralArg = Node.isStringLiteral(arg0) || Node.isNoSubstitutionTemplateLiteral(arg0);
    if (isLiteralArg) continue;
    count++;
    if (!NON_LITERAL_IMPORT_ALLOWLIST.has(rel)) {
      violate(
        "NON_LITERAL_IMPORT",
        rel,
        lineOf(call),
        `${isRequire ? "require()" : "import()"} with a non-literal argument outside the measured allowlist`,
      );
    }
  }
  if (NON_LITERAL_IMPORT_ALLOWLIST.has(rel) && count !== NON_LITERAL_IMPORT_ALLOWLIST.get(rel)) {
    violate(
      "NON_LITERAL_IMPORT",
      rel,
      1,
      `${rel} has ${count} non-literal import()/require() call(s); the allowlist expects ${NON_LITERAL_IMPORT_ALLOWLIST.get(rel)} — the measured set drifted; update NON_LITERAL_IMPORT_ALLOWLIST in scripts/checks/check-raw-sql-usage.mjs if intentional`,
    );
  }
}

// F-R2-1: a count mismatch (above) only fires for a file that IS still
// scanned. A deleted or renamed allowlisted file never reaches
// checkNonLiteralImportSpecifiers at all — its key just silently stops
// matching anything — so the drift it represents (an allowlist entry for a
// file that no longer exists) was never detected. Checked once, after the
// per-file loop, against the full scanned-file set.
function checkNonLiteralImportAllowlistCoverage(scannedFiles) {
  const scannedSet = new Set(scannedFiles);
  for (const rel of NON_LITERAL_IMPORT_ALLOWLIST.keys()) {
    if (!scannedSet.has(rel)) {
      violate(
        "NON_LITERAL_IMPORT",
        rel,
        1,
        "allowlisted path no longer exists in the Layer 2 scan — remove or update this NON_LITERAL_IMPORT_ALLOWLIST entry",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main — parse every scanned file once (fail closed on parse error), run
// every rule, fail closed on 0 files scanned.
// ---------------------------------------------------------------------------
checkPrismaEnumDisjointness();
checkRawSqlDirectoryShadow();

const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
const layer2Files = getLayer2ScanFiles();
scannedFiles = new Set(layer2Files);

if (layer2SymlinksFound.length > 0) {
  failed = true;
  console.error(
    "SYMLINK_SCAN_TARGET: a symlink exists under a Layer 2 scan root (src/, scripts/, prisma/, repo root); the gate judges syntax on disk and cannot verify what a symlink resolves to — remove it or replace it with a real file:",
  );
  for (const s of [...new Set(layer2SymlinksFound)].sort()) console.error(`  ${s}`);
  console.error("");
}

if (layer2Files.length === 0) {
  failed = true;
  console.error("ZERO_FILES_SCANNED: Layer 2 found no source files under src/, scripts/, prisma/, or the repo root.");
} else {
  for (const rel of layer2Files) {
    const abs = join(ROOT, rel);
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch (err) {
      failed = true;
      console.error(`PARSE_ERROR: ${rel} could not be read (${err.message}).`);
      continue;
    }

    let sf;
    try {
      sf = project.createSourceFile(rel, content, { overwrite: true });
    } catch (err) {
      failed = true;
      console.error(`PARSE_ERROR: ${rel} failed to parse (${err.message}).`);
      continue;
    }
    const diagnostics = sf.compilerNode.parseDiagnostics;
    if (!Array.isArray(diagnostics) || diagnostics.length > 0) {
      failed = true;
      console.error(`PARSE_ERROR: ${rel} has parse diagnostics.`);
      continue;
    }

    checkUnsafeArg(sf, rel);
    checkRawSqlNames(sf, rel);
    checkImportEqualsEntityName(sf, rel);
    checkSpecifierLiteral(sf, rel);
    checkNodeModulesSpecifier(sf, rel);
    const unscannedTally = newUnscannedTally(rel);
    checkUnscannedImport(sf, rel, unscannedTally);
    checkUnscannedLiteralAnywhere(sf, rel, unscannedTally);
    checkUnscannedExemptionCounts(rel, unscannedTally);
    checkRawMethod(sf, rel);
    checkPrismaImportDeclarations(sf, rel);
    checkPrismaExpressionMembers(sf, rel);
    checkPrismaExtends(sf, rel);
    checkNonLiteralImportSpecifiers(sf, rel);
  }
}

checkNonLiteralImportAllowlistCoverage(layer2Files);

if (violationsByReason.size > 0) {
  failed = true;
  for (const [reason, items] of violationsByReason) {
    console.error(`${reason}:`);
    for (const v of items) console.error(`  ${v.file}:${v.line}  ${v.detail}`);
    console.error("");
  }
}

if (failed) {
  process.exit(1);
}

console.log("check-raw-sql-usage: OK");
