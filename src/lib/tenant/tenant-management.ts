import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { slugifyTenant } from "@/lib/tenant/tenant-claim";
import { randomBytes } from "node:crypto";
import { SLUG_MAX_LENGTH } from "@/lib/validations/common";

/**
 * Find or create an SSO tenant by externalId (tenant claim value).
 * Handles P2002 (unique constraint) race conditions on concurrent creation.
 *
 * Caller must ensure this function runs inside a `withBypassRls` context.
 * This function does NOT call `withBypassRls` internally.
 */
export async function findOrCreateSsoTenant(
  tenantClaim: string,
): Promise<{ id: string } | null> {
  const tenantSlug = slugifyTenant(tenantClaim);
  if (!tenantSlug) return null;

  let found = await prisma.tenant.findUnique({
    where: { externalId: tenantClaim },
    select: { id: true },
  });

  if (!found) {
    try {
      found = await prisma.tenant.create({
        data: {
          externalId: tenantClaim,
          name: tenantClaim,
          slug: tenantSlug,
        },
        select: { id: true },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        found = await prisma.tenant.findUnique({
          where: { externalId: tenantClaim },
          select: { id: true },
        });
        // P2002 on slug (not externalId) — retry with unique suffix
        if (!found) {
          try {
            const suffix = randomBytes(4).toString("hex");
            found = await prisma.tenant.create({
              data: {
                externalId: tenantClaim,
                name: tenantClaim,
                slug: `${tenantSlug.slice(0, SLUG_MAX_LENGTH - suffix.length - 1)}-${suffix}`,
              },
              select: { id: true },
            });
          } catch {
            // Extremely unlikely double collision
            found = null;
          }
        }
      } else {
        throw e;
      }
    }
  }

  return found;
}
