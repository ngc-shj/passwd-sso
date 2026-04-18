import type { NextRequest } from "next/server";
import { scimResponse, scimError } from "@/lib/scim/response";
import { withTenantRls } from "@/lib/tenant-rls";
import { prisma } from "@/lib/prisma";
import { withRequestLog } from "@/lib/with-request-log";
import { authorizeScim } from "@/lib/scim/with-scim-auth";

// GET /api/scim/v2/Schemas
async function handleGET(req: NextRequest) {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.data;

  return withTenantRls(prisma, tenantId, async () =>
    scimResponse([
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
        id: "urn:ietf:params:scim:schemas:core:2.0:User",
        name: "User",
        description: "User Account",
        attributes: [
          {
            name: "userName",
            type: "string",
            multiValued: false,
            required: true,
            uniqueness: "server",
            description: "Unique identifier for the User (email address)",
          },
          {
            name: "name",
            type: "complex",
            multiValued: false,
            required: false,
            subAttributes: [
              {
                name: "formatted",
                type: "string",
                multiValued: false,
                required: false,
                description: "Display name",
              },
            ],
          },
          {
            name: "active",
            type: "boolean",
            multiValued: false,
            required: false,
            description: "User active status in the team",
          },
          {
            name: "externalId",
            type: "string",
            multiValued: false,
            required: false,
            description: "External identifier from the IdP",
          },
        ],
        meta: {
          resourceType: "Schema",
          location: "/api/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User",
        },
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
        id: "urn:ietf:params:scim:schemas:core:2.0:Group",
        name: "Group",
        description: "Group (role-based)",
        attributes: [
          {
            name: "displayName",
            type: "string",
            multiValued: false,
            required: true,
            description: "Team role name (ADMIN, MEMBER, VIEWER)",
          },
          {
            name: "members",
            type: "complex",
            multiValued: true,
            required: false,
            subAttributes: [
              {
                name: "value",
                type: "string",
                multiValued: false,
                required: true,
                description: "User ID",
              },
              {
                name: "display",
                type: "string",
                multiValued: false,
                required: false,
                description: "User email",
              },
            ],
          },
        ],
        meta: {
          resourceType: "Schema",
          location: "/api/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group",
        },
      },
    ]),
  );
}

export const GET = withRequestLog(handleGET);
