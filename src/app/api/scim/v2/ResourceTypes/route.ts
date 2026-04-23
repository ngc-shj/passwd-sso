import type { NextRequest } from "next/server";
import { scimResponse } from "@/lib/scim/response";
import { withTenantRls } from "@/lib/tenant-rls";
import { prisma } from "@/lib/prisma";
import { withRequestLog } from "@/lib/http/with-request-log";
import { authorizeScim } from "@/lib/scim/with-scim-auth";

// GET /api/scim/v2/ResourceTypes
async function handleGET(req: NextRequest) {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.data;

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

export const GET = withRequestLog(handleGET);
