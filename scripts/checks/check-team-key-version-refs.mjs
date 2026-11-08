#!/usr/bin/env node
/**
 * C2 gate (#1009): every Int column whose field name or `@map` column matches
 * /version/i, on every model, is classified, and the team key prune names
 * every column that can reference a team key version.
 *
 * The team key prune (team_member_key_prune, a SECURITY DEFINER function
 * created by migration) deletes a team's TeamMemberKey version once no row of
 * the team references it. A new column that names a team key version, missed
 * by the function, would let the prune delete a key that column still needs —
 * irreversibly. So:
 *
 *   1. Member set, derived from prisma/schema.prisma (the shared parser in
 *      lib/prisma-relation-reach.mjs): every (model, field) of type Int / Int?
 *      whose field name or column matches /version/i. Each must be in
 *      CLASSIFICATION as `reference`, `current`, `self` or `excluded`, with a
 *      reason; an unclassified pair fails, and so does a classified pair the
 *      schema no longer has (a stale table hides nothing but misleads).
 *   2. The body read from the LATEST migration that
 *      `CREATE [OR REPLACE] FUNCTION … team_member_key_prune` has the shape
 *      the concurrency argument needs (lib/team-key-prune-shape.mjs): the
 *      RLS-bypass check first, a READ COMMITTED guard, exactly one unlocked
 *      candidate statement capped by a literal LIMIT, then exactly one
 *      statement locking only those `teams` rows FOR NO KEY UPDATE … SKIP
 *      LOCKED, then exactly one RETURN QUERY restricted to the locked teams,
 *      and nothing else.
 *   3. That RETURN QUERY — the statement that decides and deletes — names
 *      every `reference`, `current` and `self` pair as `<alias>.<column>`, the
 *      alias bound (FROM / JOIN / USING) to that pair's table. A mention only
 *      in the candidate statement does not count: that statement reads
 *      before the locks are held and only chooses what to lock.
 *   4. The body never names `item_key_team_key_version` (the re-key marker is
 *      not a reference; keying the decision on it would keep or drop keys by
 *      the wrong rule).
 *
 * What it proves: the classification covers the schema, the body's statement
 * order is lock-then-decide, and the deciding statement mentions each
 * reference column through a correctly bound alias. What it does NOT prove:
 * that the predicate around the mention is right (the integration cells in
 * team-member-key-prune.integration.test.ts do, per reference, and a live cell
 * runs the same shape check over pg_get_functiondef). It reads text; a
 * function rebuilt by dynamic SQL (EXECUTE) would defeat it, and the shape
 * check refuses one.
 *
 * Env: TEAM_KEY_VERSION_REFS_CHECK_ROOT — repository root (self-test fixtures).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SchemaReadError, loadPrismaSchema } from "./lib/prisma-relation-reach.mjs";
import { PRUNE_FUNCTION, pruneBodyShape, pruneFunctionBody } from "./lib/team-key-prune-shape.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.TEAM_KEY_VERSION_REFS_CHECK_ROOT ?? REPO_ROOT;
const SCHEMA_PATH = "prisma/schema.prisma";
const MIGRATIONS_DIR = "prisma/migrations";
const FUNCTION_NAME = PRUNE_FUNCTION;

const CLASS = {
  REFERENCE: "reference",
  CURRENT: "current",
  SELF: "self",
  EXCLUDED: "excluded",
};

/** `Model.field` -> { class, reason }. */
const CLASSIFICATION = {
  "TeamPasswordEntry.teamKeyVersion": {
    class: CLASS.REFERENCE,
    reason: "The team key version the entry's ItemKey (or v0 blob) is wrapped under.",
  },
  "TeamPasswordEntryHistory.teamKeyVersion": {
    class: CLASS.REFERENCE,
    reason: "The team key version a history snapshot's ItemKey (or v0 blob) is wrapped under.",
  },
  "Attachment.keyVersion": {
    class: CLASS.REFERENCE,
    reason: "For a team mode-0 attachment, the team key version its body is encrypted under (personal: the vault key version).",
  },
  "Team.teamKeyVersion": {
    class: CLASS.CURRENT,
    reason: "The team's current key version; the prune never deletes it.",
  },
  "TeamMemberKey.keyVersion": {
    class: CLASS.SELF,
    reason: "The version of the wrapped team key the prune deletes.",
  },
  "TeamMemberKey.wrapVersion": { class: CLASS.EXCLUDED, reason: "ECDH wrap format of the member's copy, not a team key version." },
  "TeamPasswordEntry.aadVersion": { class: CLASS.EXCLUDED, reason: "AAD format version." },
  "TeamPasswordEntry.itemKeyVersion": { class: CLASS.EXCLUDED, reason: "ItemKey version (the per-entry key), not a team key version." },
  "TeamPasswordEntry.itemKeyTeamKeyVersion": {
    class: CLASS.EXCLUDED,
    reason: "Re-key marker (team key version the ItemKey was created at); never a reference (policy §1).",
  },
  "TeamPasswordEntry.itemKeyVersionHighWater": { class: CLASS.EXCLUDED, reason: "ItemKey version high-water mark." },
  "TeamPasswordEntryHistory.aadVersion": { class: CLASS.EXCLUDED, reason: "AAD format version." },
  "TeamPasswordEntryHistory.itemKeyVersion": { class: CLASS.EXCLUDED, reason: "ItemKey version of the snapshot." },
  "Attachment.aadVersion": { class: CLASS.EXCLUDED, reason: "AAD format version." },
  "Attachment.cekKeyVersion": { class: CLASS.EXCLUDED, reason: "Team: the ItemKey version the CEK is wrapped under; personal: the vault key version." },
  "Attachment.cekWrapAadVersion": { class: CLASS.EXCLUDED, reason: "CEK wrap AAD format version." },
  "User.keyVersion": { class: CLASS.EXCLUDED, reason: "Personal vault key version." },
  "User.passphraseVerifierVersion": { class: CLASS.EXCLUDED, reason: "Passphrase verifier format." },
  "User.recoveryVerifierVersion": { class: CLASS.EXCLUDED, reason: "Recovery verifier format." },
  "VaultKey.version": { class: CLASS.EXCLUDED, reason: "Personal vault key version." },
  "PasswordEntry.keyVersion": { class: CLASS.EXCLUDED, reason: "Personal vault key version." },
  "PasswordEntry.aadVersion": { class: CLASS.EXCLUDED, reason: "AAD format version." },
  "PasswordEntryHistory.keyVersion": { class: CLASS.EXCLUDED, reason: "Personal vault key version." },
  "PasswordEntryHistory.aadVersion": { class: CLASS.EXCLUDED, reason: "AAD format version." },
  "PasswordShare.masterKeyVersion": { class: CLASS.EXCLUDED, reason: "Server master key version (share links are sealed server-side)." },
  "PasswordShare.accessPasswordHashVersion": { class: CLASS.EXCLUDED, reason: "Access-password hash format." },
  "AuditDeliveryTarget.masterKeyVersion": { class: CLASS.EXCLUDED, reason: "Server master key version." },
  "EmergencyAccessGrant.wrapVersion": { class: CLASS.EXCLUDED, reason: "Emergency-access wrap format." },
  "EmergencyAccessGrant.keyVersion": { class: CLASS.EXCLUDED, reason: "Grantor's personal vault key version." },
  "TeamWebhook.masterKeyVersion": { class: CLASS.EXCLUDED, reason: "Server master key version." },
  "TeamWebhook.secretAadVersion": { class: CLASS.EXCLUDED, reason: "Webhook secret AAD format." },
  "TenantWebhook.masterKeyVersion": { class: CLASS.EXCLUDED, reason: "Server master key version." },
  "TenantWebhook.secretAadVersion": { class: CLASS.EXCLUDED, reason: "Webhook secret AAD format." },
  "MasterKeyRotation.targetVersion": { class: CLASS.EXCLUDED, reason: "Server master key version a rotation targets." },
};

const VERSION_RE = /version/i;
const FORBIDDEN_COLUMN = "item_key_team_key_version";
const NOT_AN_ALIAS = new Set([
  "where", "on", "join", "inner", "left", "right", "full", "cross", "using", "group", "order", "limit",
  "returning", "set", "and", "or", "as", "union", "having", "window", "natural", "lateral",
]);

const problems = [];

function loadSchema() {
  try {
    return loadPrismaSchema(join(ROOT, SCHEMA_PATH));
  } catch (e) {
    if (e instanceof SchemaReadError) fail(e.message);
    throw e;
  }
}

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

/** Every (model, field) Int pair whose name or column matches /version/i. */
function versionPairs(schema) {
  const pairs = [];
  for (const [model, fields] of schema.models) {
    for (const [field, info] of fields) {
      if (info.type !== "Int" || info.list) continue;
      if (!VERSION_RE.test(field) && !VERSION_RE.test(info.column)) continue;
      pairs.push({ key: `${model}.${field}`, model, field, column: info.column, table: schema.tables.get(model) });
    }
  }
  return pairs;
}

/** The body of the latest migration's definition of the prune function. */
function latestFunctionBody() {
  const dir = join(ROOT, MIGRATIONS_DIR);
  if (!existsSync(dir)) fail(`${dir} not found.`);
  const migrations = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of migrations.reverse()) {
    const file = join(dir, name, "migration.sql");
    if (!existsSync(file)) continue;
    const found = pruneFunctionBody(readFileSync(file, "utf8"));
    if (found.missing) continue;
    if (found.error) fail(`${name}: ${found.error}`);
    return { migration: name, body: found.body };
  }
  fail(`no migration under ${MIGRATIONS_DIR} defines ${FUNCTION_NAME}.`);
}

/** table -> the aliases bound to it (FROM / JOIN / USING / DELETE FROM `<table> [AS] <alias>`). */
function aliasesByTable(body) {
  const out = new Map();
  const re = /\b(?:FROM|JOIN|USING)\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)/gi;
  for (const m of body.matchAll(re)) {
    const table = m[1].toLowerCase();
    const alias = m[2].toLowerCase();
    if (NOT_AN_ALIAS.has(alias)) continue;
    if (!out.has(table)) out.set(table, new Set());
    out.get(table).add(alias);
  }
  return out;
}

function namesColumn(body, aliases, column) {
  for (const alias of aliases ?? []) {
    if (new RegExp(String.raw`\b${alias}\s*\.\s*${column}\b`, "i").test(body)) return true;
  }
  return false;
}

const schema = loadSchema();
const pairs = versionPairs(schema);
if (pairs.length === 0) fail(`derived zero version columns from ${SCHEMA_PATH} — the parser broke.`);

const seen = new Set();
for (const pair of pairs) {
  seen.add(pair.key);
  const entry = CLASSIFICATION[pair.key];
  if (!entry) {
    problems.push(
      `UNCLASSIFIED ${pair.key} (column ${pair.table}.${pair.column}): classify it in CLASSIFICATION as reference, current, self or excluded. ` +
        `If it can hold a team key version a row still needs, it is a reference and ${FUNCTION_NAME} must check it.`,
    );
    continue;
  }
  if (!Object.values(CLASS).includes(entry.class) || typeof entry.reason !== "string" || entry.reason.length < 10) {
    problems.push(`MALFORMED classification for ${pair.key}: needs a class and a reason.`);
  }
}
for (const key of Object.keys(CLASSIFICATION)) {
  if (!seen.has(key)) problems.push(`STALE classification ${key}: the schema has no such Int version column.`);
}

const { migration, body } = latestFunctionBody();
const shape = pruneBodyShape(body);
for (const p of shape.problems) problems.push(`SHAPE ${p} (latest definition: ${MIGRATIONS_DIR}/${migration}/migration.sql)`);
if (shape.returnQuery) {
  const aliases = aliasesByTable(shape.returnQuery);
  for (const pair of pairs) {
    const entry = CLASSIFICATION[pair.key];
    if (!entry || entry.class === CLASS.EXCLUDED) continue;
    if (!namesColumn(shape.returnQuery, aliases.get(pair.table), pair.column)) {
      problems.push(
        `${entry.class.toUpperCase()} ${pair.key} is not named as <alias>.${pair.column} with the alias bound to ${pair.table} ` +
          `in ${FUNCTION_NAME}'s RETURN QUERY (latest definition: ${MIGRATIONS_DIR}/${migration}/migration.sql).`,
      );
    }
  }
}
if (new RegExp(String.raw`\b${FORBIDDEN_COLUMN}\b`, "i").test(body.replace(/--[^\n]*/g, ""))) {
  problems.push(`${FUNCTION_NAME} (${migration}) names ${FORBIDDEN_COLUMN}: the re-key marker is not a reference.`);
}

if (problems.length > 0) {
  console.error(`check-team-key-version-refs: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `OK (${pairs.length} version columns classified; ${FUNCTION_NAME} in ${migration} has the lock-then-decide shape and its RETURN QUERY names every reference, current and self column)`,
);
