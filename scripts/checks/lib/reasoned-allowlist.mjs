/**
 * Parser for the `<name>  # reason` allowlist / baseline files of the migration
 * gates (check-destructive-migration, check-migration-transaction,
 * check-migration-rls-dml). The reason delimiter is the FIRST `#` on the line,
 * so a name cannot contain one; check-destructive-wrapper-derivation's exempt
 * file keys do (`path#function`) and keep their own parser.
 */
export const MIN_REASON_LENGTH = 10;

export function parseReasonedAllowlist(text) {
  const entries = new Map();
  const errors = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const hashIndex = line.indexOf("#");
    if (hashIndex === -1) {
      errors.push(`ALLOWLIST_ENTRY_WITHOUT_REASON: ${line}`);
      continue;
    }
    const name = line.slice(0, hashIndex).trim();
    const reason = line.slice(hashIndex + 1).trim();
    if (name.length === 0) continue;
    if (reason.length < MIN_REASON_LENGTH) {
      errors.push(`ALLOWLIST_ENTRY_WITHOUT_REASON: ${line}`);
      continue;
    }
    entries.set(name, reason);
  }
  return { entries, errors };
}
