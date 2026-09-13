import type { Prisma } from "@prisma/client";

/**
 * Point `User.tenantId` at `tenantId`, and report the tenant it named before —
 * or null when it already named this one and nothing was written.
 *
 * In its own module, re-exported by `tenant-context.ts`, because it is the only
 * writer that moves the column WITHOUT moving the rows the column scopes, and the
 * offline operator CLI calls it on `MIGRATION_DATABASE_URL` alone — a module that
 * imports the application's Prisma singleton cannot run there (round-7 F-R7-2).
 * Reading the raw column is exactly what `check-owning-tenant-adjudicator`
 * refuses elsewhere, and its manifest names this file `column-intended`: every
 * other place the question is "which tenant owns this user", which the
 * adjudicator answers. Here it is "what does the denormalized copy currently
 * say", which only the copy answers.
 *
 * WHAT IT DELIBERATELY LEAVES BEHIND. The caller (`src/auth.ts`'s tenant-claim
 * handler, no-membership branch) has just joined the user to a tenant they hold
 * no data in. Realigning the column makes their `users` row visible to their own
 * requests again — under RLS it was not, which is what left vault unlock and
 * vault setup taking their not-found arms. Their `passwordEntry` / `tag` /
 * `folder` rows stay in the tenant that released them, so the vault reads as
 * EMPTY rather than as missing, and the caller reports how many rows that is.
 *
 * Moving those rows instead was considered and refused: the sibling
 * bootstrap-migration path moves three tables (`passwordEntryHistory`,
 * `emergencyAccessKeyPair`, `shareAccessLog`) by tenant id alone, which is sound
 * only because a bootstrap tenant has one member. The tenant releasing a user
 * here is a real multi-member one, so that path would move other members' rows.
 */
export async function realignOwningTenantColumn(
  db: Pick<Prisma.TransactionClient, "user">,
  userId: string,
  tenantId: string,
): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { tenantId: true },
  });
  if (!user || user.tenantId === tenantId) return null;
  await db.user.update({ where: { id: userId }, data: { tenantId } });
  return user.tenantId;
}
