import type { Prisma } from "@prisma/client";

/**
 * Whether a share link may still be served — a team-entry share only while its
 * creator holds the membership of the entry's team they held when they created
 * it, and the entry is not trashed or gone (#990). The rule lives in the SQL
 * function `public.share_creator_admitted(uuid)` (migration 20261102000000);
 * this module only calls it. Serve paths call `isShareCreatorAdmitted` beside
 * their revoked check and repeat the function call inside their view-count
 * UPDATEs (docs/archive/review/departed-member-share-links-plan.md C1, C3).
 */

type RawQueryClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/** False unless the database answered true: a missing or NULL row refuses. */
export async function isShareCreatorAdmitted(tx: RawQueryClient, shareId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ admitted: boolean | null }[]>`
    SELECT share_creator_admitted(${shareId}::uuid) AS admitted`;
  return rows[0]?.admitted === true;
}

/** Per share id; an id the database did not answer for is false. No query for no ids. */
export async function creatorAdmittedByShareId(
  tx: RawQueryClient,
  shareIds: readonly string[],
): Promise<Map<string, boolean>> {
  const admitted = new Map<string, boolean>(shareIds.map((id) => [id, false]));
  if (shareIds.length === 0) return admitted;
  const rows = await tx.$queryRaw<{ id: string; admitted: boolean | null }[]>`
    SELECT u.id::text AS id, share_creator_admitted(u.id) AS admitted
      FROM unnest(${[...shareIds]}::uuid[]) AS u(id)`;
  for (const row of rows) {
    if (admitted.has(row.id)) admitted.set(row.id, row.admitted === true);
  }
  return admitted;
}
