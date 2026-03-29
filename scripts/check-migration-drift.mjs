#!/usr/bin/env node
/**
 * CI guard: detect schema-migration drift by pure file analysis.
 *
 * Checks three invariants:
 *   A. Every table with a tenant_id column must have ENABLE RLS, FORCE RLS,
 *      and a tenant_isolation policy in migrations.
 *   B. Every enum value defined in schema.prisma must appear in migrations
 *      (either in CREATE TYPE AS ENUM or ALTER TYPE ADD VALUE [IF NOT EXISTS]).
 *   C. Every non-relation column in schema.prisma must appear in migrations
 *      (either in CREATE TABLE or ALTER TABLE ADD COLUMN [IF NOT EXISTS]).
 *
 * Rename-aware: tracks ALTER TABLE ... RENAME TO, ALTER TYPE ... RENAME TO,
 * ALTER TABLE ... RENAME COLUMN ... TO, and ALTER TYPE ... RENAME VALUE ... TO
 * so that objects created under old names are still found.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Tables that are structurally exempt from the RLS coverage check.
const RLS_EXEMPT_TABLES = new Set(["tenants"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSnakeCase(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Parse schema.prisma
// ---------------------------------------------------------------------------

const schemaPath = join("prisma", "schema.prisma");
const schemaText = readFileSync(schemaPath, "utf8");
const schemaLines = schemaText.split("\n");

// First pass: collect all model names (for relation-field detection).
const modelNames = new Set();
const enumNames = new Set();

for (const line of schemaLines) {
  const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
  if (modelMatch) modelNames.add(modelMatch[1]);
  const enumMatch = line.match(/^enum\s+(\w+)\s*\{/);
  if (enumMatch) enumNames.add(enumMatch[1]);
}

// Second pass: full state-machine parse.
// tables: Map<sqlTableName, { hasTenantId: boolean, columns: Set<string> }>
// enums:  Map<enumName, Set<valueName>>
const tables = new Map();
const enums = new Map();

let inModel = false;
let inEnum = false;
let currentModelName = "";
let currentSqlTable = "";
let currentEnumName = "";

for (const rawLine of schemaLines) {
  const line = rawLine.trim();

  // --- Model block start ---
  const modelOpen = rawLine.match(/^model\s+(\w+)\s*\{/);
  if (modelOpen) {
    inModel = true;
    currentModelName = modelOpen[1];
    // Default SQL table name: PascalCase → snake_case
    currentSqlTable = toSnakeCase(currentModelName);
    tables.set(currentSqlTable, { hasTenantId: false, columns: new Set() });
    continue;
  }

  // --- Enum block start ---
  const enumOpen = rawLine.match(/^enum\s+(\w+)\s*\{/);
  if (enumOpen) {
    inEnum = true;
    currentEnumName = enumOpen[1];
    enums.set(currentEnumName, new Set());
    continue;
  }

  // --- Block end ---
  if (line === "}") {
    inModel = false;
    inEnum = false;
    currentModelName = "";
    currentSqlTable = "";
    currentEnumName = "";
    continue;
  }

  // --- Inside model ---
  if (inModel) {
    // @@map override
    const mapMatch = line.match(/^\s*@@map\("([^"]+)"\)/);
    if (mapMatch) {
      const oldName = currentSqlTable;
      currentSqlTable = mapMatch[1];
      // Rename entry in tables map
      const existing = tables.get(oldName);
      if (existing) {
        tables.delete(oldName);
        tables.set(currentSqlTable, existing);
      }
      continue;
    }

    // Skip block-level directives (@@index, @@unique, @@id)
    if (line.startsWith("@@")) continue;
    // Skip empty lines and comments
    if (line === "" || line.startsWith("//")) continue;

    // Field line: parse name and type
    // Format: fieldName  FieldType  modifiers...
    const fieldMatch = line.match(/^(\w+)\s+([\w\[\]?]+)/);
    if (!fieldMatch) continue;

    const fieldName = fieldMatch[1];
    const rawType = fieldMatch[2];
    const baseType = rawType.replace(/[?\[\]]/g, "");

    // Relation-only field: type is a known model name → no SQL column
    if (modelNames.has(baseType)) continue;

    // Determine SQL column name
    let colName;
    const colMapMatch = line.match(/@map\("([^"]+)"\)/);
    if (colMapMatch) {
      colName = colMapMatch[1];
    } else {
      colName = toSnakeCase(fieldName);
    }

    const tableEntry = tables.get(currentSqlTable);
    if (tableEntry) {
      tableEntry.columns.add(colName);
      if (colName === "tenant_id") {
        tableEntry.hasTenantId = true;
      }
    }
    continue;
  }

  // --- Inside enum ---
  if (inEnum) {
    // Skip comments and empty lines
    if (line === "" || line.startsWith("//")) continue;
    // Enum values are bare UPPER_SNAKE identifiers (no spaces, no special chars)
    if (/^[A-Z][A-Z0-9_]*$/.test(line)) {
      const enumEntry = enums.get(currentEnumName);
      if (enumEntry) enumEntry.add(line);
    }
  }
}

// ---------------------------------------------------------------------------
// Read all migration SQL files
// ---------------------------------------------------------------------------

const migrationsDir = join("prisma", "migrations");
let migrationDirs;
try {
  migrationDirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(); // chronological order by convention (timestamp prefix)
} catch {
  console.error("✗ check-migration-drift: could not read prisma/migrations/");
  process.exit(1);
}

let allSql = "";
for (const dir of migrationDirs) {
  const sqlPath = join(migrationsDir, dir, "migration.sql");
  try {
    allSql += readFileSync(sqlPath, "utf8") + "\n";
  } catch {
    // Some migration dirs might not have a migration.sql (e.g. manual squash dirs)
  }
}

// ---------------------------------------------------------------------------
// Build rename alias maps
//
// Table renames:  ALTER TABLE "old" RENAME TO "new"
// Type renames:   ALTER TYPE "old" RENAME TO "new"
// Column renames: ALTER TABLE "tbl" RENAME COLUMN "old" TO "new"
// Enum val renames: ALTER TYPE "T" RENAME VALUE 'old' TO 'new'
//
// We resolve transitive chains so that objects created under any historical
// name are still found when checking the current (final) name.
// ---------------------------------------------------------------------------

function buildAliasMap(sql, tableNamesIterable, enumNamesIterable) {
  const tableAliases = new Map(); // currentName → Set<historicalNames>
  const enumAliases = new Map(); // currentName → Set<historicalNames>
  // columnAliases: Map<tableName, Map<currentColName, Set<historicalColNames>>>
  const columnAliases = new Map();
  // enumValueAliases: Map<enumName, Map<currentValue, Set<historicalValues>>>
  const enumValueAliases = new Map();

  // Initialise with the current names as their own aliases.
  for (const t of tableNamesIterable) {
    tableAliases.set(t, new Set([t]));
    columnAliases.set(t, new Map());
  }
  for (const e of enumNamesIterable) {
    enumAliases.set(e, new Set([e]));
    enumValueAliases.set(e, new Map());
  }

  // ----- Table renames -----
  const tableForward = new Map(); // oldName → newName
  const tableRenameRe = /alter\s+table\s+"([^"]+)"\s+rename\s+to\s+"([^"]+)"/gi;
  let m;
  while ((m = tableRenameRe.exec(sql)) !== null) {
    tableForward.set(m[1], m[2]);
  }

  // ----- Type renames -----
  const enumForward = new Map(); // oldName → newName
  const typeRenameRe = /alter\s+type\s+"([^"]+)"\s+rename\s+to\s+"([^"]+)"/gi;
  while ((m = typeRenameRe.exec(sql)) !== null) {
    enumForward.set(m[1], m[2]);
  }

  // ----- Column renames (inside DO $$ blocks or plain SQL) -----
  // ALTER TABLE "tbl" RENAME COLUMN "old" TO "new"
  const colRenameRe =
    /alter\s+table\s+"([^"]+)"\s+rename\s+column\s+"([^"]+)"\s+to\s+"([^"]+)"/gi;
  while ((m = colRenameRe.exec(sql)) !== null) {
    const tableName = m[1];
    const oldCol = m[2];
    const newCol = m[3];
    // Store under the (potentially old) table name; we'll re-map later.
    if (!columnAliases.has(tableName)) columnAliases.set(tableName, new Map());
    const colMap = columnAliases.get(tableName);
    if (!colMap.has(newCol)) colMap.set(newCol, new Set([newCol]));
    colMap.get(newCol).add(oldCol);
  }

  // ----- Enum value renames -----
  // ALTER TYPE "T" RENAME VALUE 'old' TO 'new'
  const enumValRenameRe =
    /alter\s+type\s+"([^"]+)"\s+rename\s+value\s+'([^']+)'\s+to\s+'([^']+)'/gi;
  while ((m = enumValRenameRe.exec(sql)) !== null) {
    const typeName = m[1];
    const oldVal = m[2];
    const newVal = m[3];
    if (!enumValueAliases.has(typeName)) enumValueAliases.set(typeName, new Map());
    const valMap = enumValueAliases.get(typeName);
    if (!valMap.has(newVal)) valMap.set(newVal, new Set([newVal]));
    valMap.get(newVal).add(oldVal);
  }

  // ----- Resolve transitive chains -----
  function resolveChain(forwardMap, startName) {
    let cur = startName;
    const visited = new Set([cur]);
    while (forwardMap.has(cur)) {
      const next = forwardMap.get(cur);
      if (visited.has(next)) break; // cycle guard
      visited.add(next);
      cur = next;
    }
    return cur;
  }

  // Populate tableAliases with old names
  for (const [oldName] of tableForward) {
    const finalName = resolveChain(tableForward, oldName);
    if (tableAliases.has(finalName)) {
      tableAliases.get(finalName).add(oldName);
    }
  }

  // Populate enumAliases with old names
  for (const [oldName] of enumForward) {
    const finalName = resolveChain(enumForward, oldName);
    if (enumAliases.has(finalName)) {
      enumAliases.get(finalName).add(oldName);
    }
  }

  // For column aliases recorded under old table names, re-key them to the
  // final table name (so lookups work correctly).
  for (const [tblName, colMap] of columnAliases) {
    const finalTbl = resolveChain(tableForward, tblName);
    if (finalTbl === tblName) continue; // no rename, already correct
    if (!columnAliases.has(finalTbl)) columnAliases.set(finalTbl, new Map());
    const target = columnAliases.get(finalTbl);
    for (const [newCol, oldCols] of colMap) {
      if (!target.has(newCol)) target.set(newCol, new Set([newCol]));
      for (const c of oldCols) target.get(newCol).add(c);
    }
  }

  // Same for enum value aliases under old type names.
  for (const [typeName, valMap] of enumValueAliases) {
    const finalType = resolveChain(enumForward, typeName);
    if (finalType === typeName) continue;
    if (!enumValueAliases.has(finalType)) enumValueAliases.set(finalType, new Map());
    const target = enumValueAliases.get(finalType);
    for (const [newVal, oldVals] of valMap) {
      if (!target.has(newVal)) target.set(newVal, new Set([newVal]));
      for (const v of oldVals) target.get(newVal).add(v);
    }
  }

  return { tableAliases, enumAliases, columnAliases, enumValueAliases };
}

const { tableAliases, enumAliases, columnAliases, enumValueAliases } =
  buildAliasMap(allSql, tables.keys(), enums.keys());

// ---------------------------------------------------------------------------
// Check A: RLS Coverage
// ---------------------------------------------------------------------------

const rlsIssues = [];

for (const [tableName, info] of tables) {
  if (!info.hasTenantId) continue;
  if (RLS_EXEMPT_TABLES.has(tableName)) continue;

  // Collect all historical names for this table (including current).
  const allNames = tableAliases.get(tableName) ?? new Set([tableName]);
  // Build pattern alternatives for both quoted ("name") and unquoted (name) forms.
  const quotedAlts = [...allNames].map((n) => `"${escapeRe(n)}"`).join("|");
  const unquotedAlts = [...allNames].map(escapeRe).join("|");
  const tablePattern = `(?:${quotedAlts}|${unquotedAlts})`;

  // ENABLE ROW LEVEL SECURITY — table name may be quoted or unquoted
  const enablePattern = new RegExp(
    `alter\\s+table\\s+${tablePattern}\\s+enable\\s+row\\s+level\\s+security`,
    "i",
  );
  if (!enablePattern.test(allSql)) {
    rlsIssues.push(`Table "${tableName}": missing ENABLE ROW LEVEL SECURITY`);
  }

  // FORCE ROW LEVEL SECURITY — must not be a comment line; table may be quoted or unquoted
  const forcePattern = new RegExp(
    `alter\\s+table\\s+${tablePattern}\\s+force\\s+row\\s+level\\s+security`,
    "i",
  );
  const forceLines = allSql.split("\n").filter((ln) => {
    const trimmed = ln.trim();
    return !trimmed.startsWith("--") && forcePattern.test(trimmed);
  });
  if (forceLines.length === 0) {
    rlsIssues.push(`Table "${tableName}": missing FORCE ROW LEVEL SECURITY`);
  }

  // CREATE POLICY <name> ON <table> — table name may be quoted or unquoted;
  // policy name may be just "tenant_isolation" or "<table>_tenant_isolation".
  const policyPattern = new RegExp(
    `create\\s+policy\\s+"?\\S*tenant_isolation"?\\s+on\\s+${tablePattern}(?:\\s|$)`,
    "i",
  );
  if (!policyPattern.test(allSql)) {
    rlsIssues.push(
      `Table "${tableName}": missing CREATE POLICY <table>_tenant_isolation`,
    );
  }
}

// ---------------------------------------------------------------------------
// Check B: Enum Value Completeness
// ---------------------------------------------------------------------------

const enumIssues = [];

for (const [enumName, values] of enums) {
  const allEnumNames = enumAliases.get(enumName) ?? new Set([enumName]);
  const enumNameAlts = [...allEnumNames].map(escapeRe).join("|");
  const valAliasMap = enumValueAliases.get(enumName) ?? new Map();

  for (const value of values) {
    // Collect all historical names for this value.
    const allValues = valAliasMap.get(value) ?? new Set([value]);
    // Also check any aliases from old type names that may have been merged.
    for (const oldTypeName of allEnumNames) {
      const oldValMap = enumValueAliases.get(oldTypeName);
      if (oldValMap && oldValMap.has(value)) {
        for (const v of oldValMap.get(value)) allValues.add(v);
      }
    }

    let found = false;

    for (const searchValue of allValues) {
      if (found) break;

      // Option 1: value appears in a CREATE TYPE "EnumName" AS ENUM (...) block
      // The block may span multiple lines, so use the 's' (dotAll) flag.
      const inCreate = new RegExp(
        `create\\s+type\\s+"(?:${enumNameAlts})"\\s+as\\s+enum\\s*\\([^)]*'${escapeRe(searchValue)}'[^)]*\\)`,
        "is",
      );

      // Option 2: ALTER TYPE "EnumName" ADD VALUE ['IF NOT EXISTS'] 'value'
      const inAlter = new RegExp(
        `alter\\s+type\\s+"(?:${enumNameAlts})"\\s+add\\s+value\\s+(?:if\\s+not\\s+exists\\s+)?'${escapeRe(searchValue)}'`,
        "i",
      );

      if (inCreate.test(allSql) || inAlter.test(allSql)) {
        found = true;
      }
    }

    if (!found) {
      enumIssues.push(
        `Enum "${enumName}" value "${value}" not found in any migration`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check C: Column Completeness
// ---------------------------------------------------------------------------

// Build a map from table → set of SQL column names found in migrations.
// Handles CREATE TABLE blocks and ALTER TABLE ADD COLUMN [IF NOT EXISTS] statements.

function extractColumnsFromMigrations(sql) {
  const result = new Map(); // tableName → Set<colName>

  // --- CREATE TABLE "table_name" ( ... ) blocks ---
  const createTableRe =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?"([^"]+)"\s*\(([^;]*?)\)\s*;/gis;
  let ctMatch;
  while ((ctMatch = createTableRe.exec(sql)) !== null) {
    const tableName = ctMatch[1];
    const body = ctMatch[2];
    if (!result.has(tableName)) result.set(tableName, new Set());
    const cols = result.get(tableName);

    for (const bodyLine of body.split("\n")) {
      const trimmed = bodyLine.trim();
      if (!trimmed) continue;
      // Skip CONSTRAINT lines
      if (/^CONSTRAINT\b/i.test(trimmed)) continue;
      // Column lines start with a quoted identifier
      const colMatch = trimmed.match(/^"([^"]+)"\s+/);
      if (colMatch) {
        cols.add(colMatch[1]);
      }
    }
  }

  // --- ALTER TABLE "table" ADD COLUMN [IF NOT EXISTS] "col" ... ---
  // Handles both single and chained: ADD COLUMN "a" TYPE, ADD COLUMN "b" TYPE
  const alterAddRe =
    /alter\s+table\s+"([^"]+)"((?:\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"[^"]+"\s+[^,;]+[,;])+)/gis;
  let aaMatch;
  while ((aaMatch = alterAddRe.exec(sql)) !== null) {
    const tableName = aaMatch[1];
    if (!result.has(tableName)) result.set(tableName, new Set());
    const cols = result.get(tableName);

    const addColRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?"([^"]+)"/gi;
    let acMatch;
    while ((acMatch = addColRe.exec(aaMatch[2])) !== null) {
      cols.add(acMatch[1]);
    }
  }

  return result;
}

const rawMigrationColumns = extractColumnsFromMigrations(allSql);

// Merge columns from all historical table names into a unified map keyed by
// the current (final) table name. Also expand column aliases (renamed columns).
const migrationColumns = new Map(); // currentTableName → Set<colName>
for (const [currentName] of tables) {
  const allTableNames = tableAliases.get(currentName) ?? new Set([currentName]);
  const merged = new Set();

  for (const tblName of allTableNames) {
    const cols = rawMigrationColumns.get(tblName);
    if (cols) {
      for (const c of cols) merged.add(c);
    }
  }

  // Expand column renames: if a column was renamed from "old" to "new" in a
  // migration, and "old" appears in the migrations corpus, treat "new" as found.
  const colMap = columnAliases.get(currentName) ?? new Map();
  for (const [newCol, oldColSet] of colMap) {
    for (const oldCol of oldColSet) {
      if (merged.has(oldCol)) {
        merged.add(newCol);
        break;
      }
    }
  }

  migrationColumns.set(currentName, merged);
}

const colIssues = [];

for (const [tableName, info] of tables) {
  const migCols = migrationColumns.get(tableName);
  for (const col of info.columns) {
    if (!migCols || !migCols.has(col)) {
      colIssues.push(
        `Table "${tableName}" column "${col}" not found in any migration`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const totalIssues = rlsIssues.length + enumIssues.length + colIssues.length;

if (totalIssues === 0) {
  const tableCount = tables.size;
  const enumCount = enums.size;
  const colCount = [...tables.values()].reduce(
    (sum, t) => sum + t.columns.size,
    0,
  );
  console.log(
    `✓ check-migration-drift: ${tableCount} tables, ${enumCount} enums, ${colCount} columns — all consistent`,
  );
  process.exit(0);
}

console.error(`✗ check-migration-drift: ${totalIssues} issue(s) found`);
console.error("");

if (rlsIssues.length > 0) {
  console.error("  RLS:");
  for (const msg of rlsIssues) {
    console.error(`    - ${msg}`);
  }
}

if (enumIssues.length > 0) {
  if (rlsIssues.length > 0) console.error("");
  console.error("  Enum values:");
  for (const msg of enumIssues) {
    console.error(`    - ${msg}`);
  }
}

if (colIssues.length > 0) {
  if (rlsIssues.length > 0 || enumIssues.length > 0) console.error("");
  console.error("  Columns:");
  for (const msg of colIssues) {
    console.error(`    - ${msg}`);
  }
}

process.exit(1);
