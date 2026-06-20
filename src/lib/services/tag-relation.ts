/**
 * Tag relation-write helpers for password entries.
 *
 * Callers pass the raw `tagIds` from validated request input. Ownership is
 * checked separately (against the deduped set); these helpers only shape the
 * Prisma relation write. Deduping here is mandatory — a duplicate connect/set
 * is malformed input to Prisma — and centralizing it keeps every write site
 * (personal/team, create/update, session/v1) from re-deriving the dedup.
 */

export function dedupeTagIds(tagIds: readonly string[]): string[] {
  return [...new Set(tagIds)];
}

/** Relation write for create paths: `{ connect: [...] }` over the deduped ids. */
export function tagConnect(tagIds: readonly string[]) {
  return { connect: dedupeTagIds(tagIds).map((id) => ({ id })) };
}

/** Relation write for update paths: `{ set: [...] }` over the deduped ids. */
export function tagSet(tagIds: readonly string[]) {
  return { set: dedupeTagIds(tagIds).map((id) => ({ id })) };
}
