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
 *     positions (the single canonical unaliased import from raw-sql.ts;
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
 *     (a `raw-sql.<ext>` sibling for every scanned extension OTHER than
 *     `.ts` — including `.tsx`, since Next/esbuild resolve `.tsx` before
 *     `.ts` — or a `raw-sql/index.<ext>` directory module for every scanned
 *     extension, `.ts` included); a `.js` specifier's TS/ESM
 *     extension-rewrite resolution never claims such a shadow file as
 *     raw-sql.ts.
 *   - IMPORT_EQUALS_ENTITY: `import x = <entity name>` (`import r =
 *     Prisma.raw`, including `export import` inside a namespace) denies
 *     unconditionally — a QualifiedName entity name is not a type position,
 *     and this binding form aliases whatever it denotes past every other
 *     expression-position check. `import x = require(...)` is unaffected
 *     (different AST shape; handled by RAW_SQL_NAMES / UNSCANNED_IMPORT).
 *   - SPECIFIER_LITERAL: a string/no-substitution-template literal, in
 *     expression position, whose decoded value HAS A PATH SEGMENT (split on
 *     `/` and `\`) equal to `@prisma`/`.prisma` (not merely start-anchored —
 *     a relative or `node_modules`-reaching path counts too) or resolves to
 *     raw-sql.ts, denies unless it IS the specifier of a static import/export
 *     declaration (every other sighting — a computed `require()`/`import()`
 *     argument, a reassigned loader — is unaccounted for by construction and
 *     must fail closed). A `node_modules` path segment in any MODULE-SPECIFIER
 *     position (import/export declaration, `import x = require()`, a literal
 *     `require()`/`import()` argument) denies independently of the Prisma/
 *     raw-sql match. This gate's own source is exempt (it spells the allowed
 *     specifiers as data).
 *   - UNSCANNED_IMPORT: a scanned file's import/export declaration, `import x
 *     = require()`, a `require()`/`import()` call's literal argument, OR any
 *     OTHER string/no-substitution-template literal in expression position —
 *     whatever its parent — resolving into an excluded test path (`*.test.*`,
 *     `__tests__/`, `manual-tests/`, `e2e/`) denies. The last clause mirrors
 *     SPECIFIER_LITERAL: it closes the laundering-through-an-unscanned-file
 *     gap for a loader reached under another name (`createRequire(...)(...)`,
 *     `module.require(...)`, `require.call(...)`, `new Worker(new
 *     URL(...))`, …), not just the require()/import() call shape or a static
 *     declaration. Exempt: this gate's own source, and a measured set of
 *     `scripts/checks/**` files that hold such a literal as DATA, not as a
 *     load target (`scripts/checks/classify-fail-closed-test.mjs`, which
 *     names the test-helper module it classifies against).
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
 * another name invoked with a NON-literal specifier (with a literal
 * specifier, under ANY name or call shape, it is caught by SPECIFIER_LITERAL
 * / UNSCANNED_IMPORT / NON_LITERAL_IMPORT); a third-party dependency
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
// Specifier resolution — pure path math, no filesystem existence check (the
// gate judges syntax, not bindings). `@/` -> `src/`; relative resolved
// against the importing file's directory. Returns the normalized base path
// (pre-extension) for a repo-shaped specifier, or undefined otherwise.
// ---------------------------------------------------------------------------
function resolveRepoSpecifierBase(fromRel, spec) {
  let baseParts;
  if (spec.startsWith("@/")) {
    baseParts = ["src", ...spec.slice(2).split("/")];
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    baseParts = [...fromRel.split("/").slice(0, -1), ...spec.split("/")];
  } else {
    return undefined;
  }
  const stack = [];
  for (const part of baseParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

const RAW_SQL_MODULE_TARGET = RAW_SQL_MODULE_REL.toLowerCase();

// TS/Node ESM "rewrite relative import extensions" convention: a relative
// specifier may spell the COMPILED extension (`.js`/`.mjs`/`.cjs`) while
// resolving to the TS SOURCE file of the same base name (`.ts`/`.mts`/`.cts`)
// — so a candidate ending in `.js` must also try its `.ts` sibling, etc.
const TS_SIBLING_EXT = { js: "ts", mjs: "mts", cjs: "cts" };

function candidatesForBase(base) {
  const m = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/i.exec(base);
  if (m) {
    const ext = m[1].toLowerCase();
    const sibling = TS_SIBLING_EXT[ext];
    if (sibling === undefined) return [base];
    const stem = base.slice(0, base.length - m[0].length);
    return [base, `${stem}.${sibling}`];
  }
  return [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
}

// F4-c (part 2): populated from the real Layer 2 scan list before any file is
// checked (see Main below). A `.js`/`.mjs`/`.cjs` specifier resolves to its TS
// source sibling under the TS/Node ESM extension-rewrite convention ONLY when
// no real file sits at the literal path — if a real sibling exists (a shadow
// `raw-sql.js`, caught separately by checkRawSqlShadowFile), Node's resolver
// loads THAT file, never raw-sql.ts, so the convention must not override it.
let scannedFilesLower = new Set();

/** Case-insensitive: does `spec` (imported from `fromRel`) resolve to raw-sql.ts? */
function resolvesToRawSqlModule(fromRel, spec) {
  const base = resolveRepoSpecifierBase(fromRel, spec);
  if (base === undefined) return false;
  const m = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/i.exec(base);
  if (m) {
    const ext = m[1].toLowerCase();
    const sibling = TS_SIBLING_EXT[ext];
    if (sibling === undefined) return base.toLowerCase() === RAW_SQL_MODULE_TARGET;
    if (scannedFilesLower.has(base.toLowerCase())) {
      return base.toLowerCase() === RAW_SQL_MODULE_TARGET;
    }
    const stem = base.slice(0, base.length - m[0].length);
    return `${stem}.${sibling}`.toLowerCase() === RAW_SQL_MODULE_TARGET;
  }
  return candidatesForBase(base).some((c) => c.toLowerCase() === RAW_SQL_MODULE_TARGET);
}

/** Does `spec` (imported from `fromRel`) resolve into an excluded test path? */
function resolvesToUnscannedPath(fromRel, spec) {
  const base = resolveRepoSpecifierBase(fromRel, spec);
  if (base === undefined) return false;
  return TEST_PATH_RE.test(base);
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

// F4-c (part 1): a scanned file other than raw-sql.ts itself that sits at one
// of raw-sql.ts's own module-resolution candidate paths (a `raw-sql.<ext>`
// sibling for any OTHER scanned extension — N2: including `.tsx`, since
// Next/esbuild resolve `.tsx` before `.ts` — or a `raw-sql/index.<ext>`
// directory module for any scanned extension, `.ts` included) is a SHADOW
// FILE — Node's real resolver would load it instead of the TS source for any
// specifier that reaches that path, regardless of what this gate's
// positional checks decide about raw-sql.ts proper.
const RAW_SQL_BASE_REL = RAW_SQL_MODULE_REL.replace(/\.ts$/, "");
const LAYER2_EXT_NAMES = [...LAYER2_EXTS].map((ext) => ext.slice(1)); // ".ts" -> "ts"
const RAW_SQL_SHADOW_PATHS = new Set(
  LAYER2_EXT_NAMES.filter((ext) => ext !== "ts")
    .map((ext) => `${RAW_SQL_BASE_REL}.${ext}`)
    .concat(LAYER2_EXT_NAMES.map((ext) => `${RAW_SQL_BASE_REL}/index.${ext}`))
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
    if (!resolvesToRawSqlModule(rel, spec)) continue;
    if (imp.getNamespaceImport() !== undefined || imp.getDefaultImport() !== undefined) {
      violate("RAW_SQL_NAMES", rel, lineOf(imp), "namespace or default import of raw-sql.ts");
    } else if (imp.getNamedImports().length === 0) {
      violate("RAW_SQL_NAMES", rel, lineOf(imp), "side-effect import of raw-sql.ts");
    }
  }
  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (spec !== undefined && resolvesToRawSqlModule(rel, spec)) {
      violate("RAW_SQL_NAMES", rel, lineOf(exp), "export ... from raw-sql.ts");
    }
  }
  for (const ieq of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const ref = ieq.getModuleReference();
    if (Node.isExternalModuleReference(ref)) {
      const expr = ref.getExpression();
      if (Node.isStringLiteral(expr) && resolvesToRawSqlModule(rel, expr.getLiteralValue())) {
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
    if (value !== undefined && resolvesToRawSqlModule(rel, value)) {
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
    const matchesRawSql = resolvesToRawSqlModule(rel, value);
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

// N1: a loader reached under another name (`createRequire(...)(...)`,
// `module.require(...)`, `require.call(...)`, `new Worker(new URL(...))`,
// …) still spells its load target as an ordinary string/no-substitution-
// template literal — the require()/import() call scan above only inspects
// that one callee shape. Mirrors SPECIFIER_LITERAL: scan every such literal
// in expression position, WHATEVER its parent, and deny the ones that
// resolve into an excluded test path. `resolvesToUnscannedPath` already
// requires the value to look like a specifier (`@/`, `./`, `../`), so this
// cannot fire on incidental text that doesn't start with one of those.
// Measured exemption, same shape as GATE_SELF_REL: files that hold such a
// literal as DATA, not as a load target.
const UNSCANNED_TEST_PATH_LITERAL_DATA_FILES = new Set([
  // names the shared fail-closed test helper it classifies OTHER files
  // against — never itself loads it.
  "scripts/checks/classify-fail-closed-test.mjs",
]);

function checkUnscannedLiteralAnywhere(sf, rel) {
  if (rel === GATE_SELF_REL) return; // exempt: spells example specifiers as data
  if (UNSCANNED_TEST_PATH_LITERAL_DATA_FILES.has(rel)) return;

  const literals = [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ];
  for (const lit of literals) {
    if (isLiteralTypePosition(lit)) continue;
    const value = literalValue(lit);
    if (value !== undefined && resolvesToUnscannedPath(rel, value)) {
      violate(
        "UNSCANNED_IMPORT",
        rel,
        lineOf(lit),
        `literal "${value}" resolves into an excluded test path`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// UNSCANNED_IMPORT — a scanned file's import/export specifier resolving into
// an excluded test path; also (F3) a `require()`/`import()` call's literal
// first argument and the `ExternalModuleReference` of `import x = require()`
// — the original scan covered only static import/export declarations, so a
// `*.test.ts` helper could be laundered through either of those two call-ish
// forms without ever tripping this rule; also (N1) any OTHER expression-
// position literal resolving the same way, closing the gap for a loader
// reached under another name (see checkUnscannedLiteralAnywhere above).
// ---------------------------------------------------------------------------
function checkUnscannedImport(sf, rel) {
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (resolvesToUnscannedPath(rel, spec)) {
      violate("UNSCANNED_IMPORT", rel, lineOf(imp), `import specifier "${spec}" resolves into an excluded test path`);
    }
  }
  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (spec !== undefined && resolvesToUnscannedPath(rel, spec)) {
      violate("UNSCANNED_IMPORT", rel, lineOf(exp), `export specifier "${spec}" resolves into an excluded test path`);
    }
  }
  for (const ieq of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const ref = ieq.getModuleReference();
    if (!Node.isExternalModuleReference(ref)) continue;
    const expr = ref.getExpression();
    const value = Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)
      ? literalValue(expr)
      : undefined;
    if (value !== undefined && resolvesToUnscannedPath(rel, value)) {
      violate("UNSCANNED_IMPORT", rel, lineOf(ieq), `import x = require("${value}") resolves into an excluded test path`);
    }
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const isRequire = Node.isIdentifier(expr) && expr.getText() === "require";
    const isDynamicImport = expr.getKind() === SyntaxKind.ImportKeyword;
    if (!isRequire && !isDynamicImport) continue;
    const arg0 = call.getArguments()[0];
    if (arg0 === undefined) continue;
    const value = literalValue(arg0);
    if (value !== undefined && resolvesToUnscannedPath(rel, value)) {
      violate(
        "UNSCANNED_IMPORT",
        rel,
        lineOf(call),
        `${isRequire ? "require()" : "import()"} of "${value}" resolves into an excluded test path`,
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

const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
const layer2Files = getLayer2ScanFiles();
scannedFilesLower = new Set(layer2Files.map((f) => f.toLowerCase()));

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
    checkUnscannedImport(sf, rel);
    checkUnscannedLiteralAnywhere(sf, rel);
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
