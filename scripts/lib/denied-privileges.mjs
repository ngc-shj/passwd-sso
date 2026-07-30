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
 * `scripts/__tests__/dockerfile-runtime-assets.test.ts` derives this file as a
 * required asset from their import statements — adding a shared module must not
 * become a new way for the production image to be missing part of the control.
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

/** Privilege types this policy may name. Column-scopable ones are a subset. */
const SQL_PRIV_RE = /^(SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)$/;

/**
 * DDL takes neither bound parameters nor quoted identifiers, so table and role
 * names are interpolated by the bootstrap — and therefore validated here. This
 * is committed policy rather than input, so the guard exists to fail loudly on a
 * malformed edit, not to be an injection boundary.
 */
const SQL_IDENT_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

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
  for (const d of parsed.denied) {
    if (!SQL_IDENT_RE.test(d?.table ?? "") || !SQL_IDENT_RE.test(d?.role ?? "")) {
      throw new Error(
        `DENIED_POLICY_INVALID: malformed table/role in ${file}: ${d?.role} / ${d?.table}`,
      );
    }
    if (!Array.isArray(d.privileges) || d.privileges.length === 0) {
      throw new Error(
        `DENIED_POLICY_INVALID: ${file} entry for ${d.table} lists no privileges`,
      );
    }
    if (!d.privileges.every((x) => SQL_PRIV_RE.test(x))) {
      throw new Error(
        `DENIED_POLICY_INVALID: malformed privilege in ${file} for ${d.table}`,
      );
    }
  }
  return parsed.denied;
}
