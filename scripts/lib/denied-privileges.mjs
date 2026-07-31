/**
 * The prescriptive must-never-be-granted policy: one loader, one validator.
 *
 * `scripts/bootstrap-rds-roles.mjs` re-applies these revokes after its blanket
 * grant; `scripts/audit-db-grants.mjs` fails when a database holds one or the
 * descriptive manifest sanctions one. Both used to parse and validate the file
 * themselves, and the two validations had already drifted — bootstrap checked
 * every entry, the audit checked only that a `denied` array existed, so
 * `privileges: []` or an unrecognised privilege stopped a bootstrap run and
 * passed a deploy-time audit.
 *
 * That is the same defect this policy exists to prevent, one level up: a
 * security rule with two implementations converges on the weaker one. Hence a
 * single module. Both consumers are already copied into the runtime image, and
 * `scripts/checks/check-runtime-image-assets.mjs` derives this file as a required
 * asset by following their imports — adding a shared module must not become a new
 * way for the production image to be missing part of the control.
 */
import { existsSync, readFileSync } from "node:fs";

const DEFAULT_POLICY_PATH = new URL(
  "../checks/app-role-denied-privileges.json",
  import.meta.url,
).pathname;

/**
 * Resolved per CALL, never memoised at import — a module-level constant is read
 * before any test or wrapper can set the override, so the override is silently
 * ignored and the REAL policy file is used. For a function whose job is to
 * REVOKE privileges, that means a test aimed at a throwaway probe role executes
 * against the production roles instead. That is not hypothetical; it happened.
 */
export function deniedFile() {
  return process.env.DB_DENIED_PRIVILEGES ?? DEFAULT_POLICY_PATH;
}

/** Privilege types a TABLE entry may name. Column-scopable ones are a subset. */
const SQL_PRIV_RE = /^(SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)$/;

/**
 * Privilege types a SEQUENCE entry may name. A disjoint set from the table one —
 * `USAGE` exists only here, and `DELETE`/`TRUNCATE`/`TRIGGER` only there — which
 * is why the two are validated separately rather than against one union that
 * would accept `GRANT TRUNCATE ON SEQUENCE` and fail at the database.
 */
const SQL_SEQUENCE_PRIV_RE = /^(USAGE|SELECT|UPDATE)$/;

/**
 * The privilege types PostgreSQL can scope to a column. `GRANT DELETE (col)`
 * does not exist, so a `columnGrants` key outside this set could never be
 * applied.
 */
const COLUMN_SCOPABLE_PRIV_RE = /^(SELECT|INSERT|UPDATE|REFERENCES)$/;

/**
 * DDL takes neither bound parameters nor quoted identifiers, so table and role
 * names are interpolated by the bootstrap — and therefore validated here. This
 * is committed policy rather than input, so the guard exists to fail loudly on a
 * malformed edit, not to be an injection boundary.
 */
const SQL_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Subjects, which must be SCHEMA-QUALIFIED. The dot is not style: the audit's
 * live keys are always schema-qualified, so an unqualified subject is a third
 * way for an entry to be silently inert — `to_regclass('t')` resolves through
 * `search_path` so the kind check passes, `REVOKE … ON t` succeeds so the
 * bootstrap enforces, and `violatesDenied` then looks for `TABLE:role\tt\tPRIV`
 * among keys that all read `public.t` and matches nothing, forever.
 */
const SQL_QUALIFIED_IDENT_RE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/** Column names are never schema-qualified, so they take the un-dotted form. */
const SQL_COLUMN_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Read and fully validate the policy.
 *
 * A MISSING file throws. It is a different condition from "the table does not
 * exist yet" — that one is normal on a pre-migration run and is handled per
 * entry by the caller's `to_regclass` guard. A missing POLICY means the process
 * cannot know what must be revoked, and treating that as "nothing is forbidden"
 * is exactly how the production image ran the blanket grant with no revoke
 * behind it while every local check stayed green.
 *
 * Throws rather than calling `process.exit`: the bootstrap runs this inside a
 * transaction, and exiting there would skip its ROLLBACK.
 */
export function loadDeniedPolicy() {
  const file = deniedFile();
  if (!existsSync(file)) {
    throw new Error(
      `DENIED_POLICY_MISSING: ${file}\n` +
        "This file declares the privileges that must never be granted. Without it " +
        "the prescriptive half of this control is inert: the bootstrap would " +
        "converge to its blanket GRANT, and `audit-db-grants.mjs --write` would " +
        "record an over-privileged database as the expected state. Ship it with " +
        "the runtime image (see the Dockerfile COPY for scripts/checks/) or set " +
        "DB_DENIED_PRIVILEGES.",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`DENIED_POLICY_INVALID: ${file} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed.denied)) {
    throw new Error(`DENIED_POLICY_INVALID: ${file} has no "denied" array.`);
  }
  // A repeated (role, subject) pair used to be merely redundant. `columnGrants`
  // makes it destructive and ORDER-dependent: `applyDeniedPrivileges` walks the
  // file in order, so an entry carrying a column re-grant followed by a second
  // entry for the same pair WITHOUT one ends on `REVOKE <priv> ON TABLE`, which
  // erases the first entry's re-grant. The convergence run that exists to
  // restore the control would leave the fail-closed writer with no INSERT at
  // all. Refused here rather than left to be detected downstream.
  const seenPairs = new Set();

  for (const d of parsed.denied) {
    const subject = subjectOf(d);
    if (subject === null) {
      throw new Error(
        `DENIED_POLICY_INVALID: ${file} entry names ${
          d?.table !== undefined && d?.sequence !== undefined ? "both" : "neither"
        } "table" and "sequence"; every entry takes exactly one.`,
      );
    }
    if (!SQL_QUALIFIED_IDENT_RE.test(subject) || !SQL_IDENT_RE.test(d?.role ?? "")) {
      throw new Error(
        `DENIED_POLICY_INVALID: malformed subject/role in ${file}: ${d?.role} / ${subject}. ` +
          "The subject must be schema-qualified (schema.object); the role must not be.",
      );
    }
    const pair = `${d.role}\t${subject}`;
    if (seenPairs.has(pair)) {
      throw new Error(
        `DENIED_POLICY_INVALID: ${file} names ${d.role} / ${subject} more than once. ` +
          "Entries are applied in file order, so a later one without columnGrants " +
          "would erase an earlier one's column re-grant. Merge them.",
      );
    }
    seenPairs.add(pair);
    if (!Array.isArray(d.privileges) || d.privileges.length === 0) {
      throw new Error(
        `DENIED_POLICY_INVALID: ${file} entry for ${subject} lists no privileges`,
      );
    }
    const privRe = isSequenceEntry(d) ? SQL_SEQUENCE_PRIV_RE : SQL_PRIV_RE;
    if (!d.privileges.every((x) => privRe.test(x))) {
      throw new Error(
        `DENIED_POLICY_INVALID: malformed privilege in ${file} for ${subject}`,
      );
    }
    validateColumnGrants(file, d, subject);
  }
  return parsed.denied;
}

/**
 * The object an entry is about, or null when it names both or neither.
 *
 * Exported so the bootstrap and the audit read the subject the same way. They
 * used to be able to write `d.table` unconditionally; once a second subject kind
 * existed, two consumers each deriving it inline is how one of them would keep
 * silently skipping every sequence entry.
 */
export function subjectOf(d) {
  const hasTable = typeof d?.table === "string";
  const hasSequence = typeof d?.sequence === "string";
  if (hasTable === hasSequence) return null;
  return hasTable ? d.table : d.sequence;
}

/** True for an entry whose subject is a sequence rather than a table. */
export function isSequenceEntry(d) {
  return typeof d?.sequence === "string";
}

/**
 * `pg_class.relkind` values a TABLE entry may name: ordinary and partitioned
 * tables, plus views and materialised views — the same set
 * `audit-db-grants.mjs` emits `TABLE:`/`COLUMN:` keys for.
 */
const TABLE_RELKINDS = new Set(["r", "p", "v", "m"]);

/**
 * Reject an entry whose declared subject kind disagrees with the live object.
 *
 * The second way an entry can be inert. The first — naming a role the audit
 * does not read — is already a hard error, on the reasoning that an entry
 * enforcing nothing while looking enforced is the exact shape this policy
 * exists to prevent. Subject kind is the same failure on a different axis, and
 * it does NOT fail closed on its own: `"table": "public.foo_seq"` passes the
 * identifier validation, passes the bootstrap's existence guard, and its
 * `REVOKE … ON public.foo_seq` even succeeds, because the implicit-TABLE form
 * of REVOKE accepts a sequence. What it cannot do is match anything: the audit
 * emits `SEQUENCE:` keys for that object and the entry looks for `TABLE:` ones.
 *
 * The mirror mistake already fails loudly — `REVOKE … ON SEQUENCE <table>`
 * errors — so this closes the direction that stays silent.
 *
 * Takes the relkind rather than a client so the RULE has one implementation
 * while each consumer keeps its own query; both already hold a connection.
 *
 * @param {object} d policy entry
 * @param {string|null} relkind `pg_class.relkind`, or null when absent
 */
export function assertSubjectKind(d, relkind) {
  if (relkind === null || relkind === undefined) return;
  const subject = subjectOf(d);
  const wantSequence = isSequenceEntry(d);
  const ok = wantSequence ? relkind === "S" : TABLE_RELKINDS.has(relkind);
  if (ok) return;
  throw new Error(
    `DENIED_POLICY_SUBJECT_KIND: ${deniedFile()} declares ${subject} as a ` +
      `${wantSequence ? "sequence" : "table"}, but pg_class.relkind is '${relkind}'. ` +
      "An entry whose subject kind is wrong enforces nothing: the audit keys it " +
      "would have to match are emitted under the other kind. Fix the entry.",
  );
}

/**
 * Validate the optional `columnGrants` map: `{ "<PRIVILEGE>": ["<column>", …] }`.
 *
 * It declares the one shape a blanket "never granted" cannot express — a
 * privilege denied at TABLE level while held on an enumerated set of columns.
 * `tenant_claim_events.INSERT` is the case it exists for: the sign-in writer
 * must be able to append a row, but a table-level INSERT also lets it write
 * `seq` with `OVERRIDING SYSTEM VALUE` (measured — a table-level grant alone
 * does NOT stop that) and forge the trigger-assigned attribution columns.
 *
 * A key MUST also appear in `privileges`. Without that rule the map would read
 * as "grant these columns" against a table-level privilege that is still
 * granted, which grants nothing and denies nothing — a declaration that looks
 * like a control and is inert.
 */
function validateColumnGrants(file, d, subject) {
  if (d.columnGrants === undefined) return;
  if (isSequenceEntry(d)) {
    throw new Error(
      `DENIED_POLICY_INVALID: ${file} entry for ${subject} has columnGrants, ` +
        "which only a table entry may carry — sequences have no columns.",
    );
  }
  if (
    typeof d.columnGrants !== "object" ||
    d.columnGrants === null ||
    Array.isArray(d.columnGrants)
  ) {
    throw new Error(
      `DENIED_POLICY_INVALID: ${file} entry for ${subject} has a non-object columnGrants`,
    );
  }
  for (const [priv, columns] of Object.entries(d.columnGrants)) {
    if (!COLUMN_SCOPABLE_PRIV_RE.test(priv)) {
      throw new Error(
        `DENIED_POLICY_INVALID: ${file} columnGrants for ${subject} names ${priv}, ` +
          "which PostgreSQL cannot scope to a column",
      );
    }
    if (!d.privileges.includes(priv)) {
      throw new Error(
        `DENIED_POLICY_INVALID: ${file} columnGrants for ${subject} names ${priv}, ` +
          "which the entry does not deny at table level. A column grant under a " +
          "table-level privilege that is still granted enforces nothing.",
      );
    }
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new Error(
        `DENIED_POLICY_INVALID: ${file} columnGrants for ${subject}.${priv} lists no columns`,
      );
    }
    if (!columns.every((c) => typeof c === "string" && SQL_COLUMN_RE.test(c))) {
      throw new Error(
        `DENIED_POLICY_INVALID: ${file} columnGrants for ${subject}.${priv} has a malformed column`,
      );
    }
    if (new Set(columns).size !== columns.length) {
      throw new Error(
        `DENIED_POLICY_INVALID: ${file} columnGrants for ${subject}.${priv} repeats a column`,
      );
    }
  }
}
