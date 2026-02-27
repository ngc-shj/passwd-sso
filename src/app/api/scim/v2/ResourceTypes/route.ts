import type { NextRequest } from "next/server";
import { validateScimToken } from "@/lib/scim-token";
import { scimResponse, scimError } from "@/lib/scim/response";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withTenantRls } from "@/lib/tenant-rls";
import { prisma } from "@/lib/prisma";

// GET /api/scim/v2/ResourceTypes
export async function GET(req: NextRequest) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }

  const { tenantId } = result.data;
  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  return withTenantRls(prisma, tenantId, async () =>
    scimResponse([
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        schema: "urn:ietf:params:scim:schemas:core:2.0:User",
        meta: {
          resourceType: "ResourceType",
          location: "/api/scim/v2/ResourceTypes/User",
        },
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "Group",
        name: "Group",
        endpoint: "/Groups",
        schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
        meta: {
          resourceType: "ResourceType",
          location: "/api/scim/v2/ResourceTypes/Group",
        },
      },
    ]),
  );
}
