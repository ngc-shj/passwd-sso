import type { NextRequest } from "next/server";
import { validateScimToken } from "@/lib/scim-token";
import { scimResponse, scimError } from "@/lib/scim/response";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";

// GET /api/scim/v2/Schemas
export async function GET(req: NextRequest) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }

  if (!(await checkScimRateLimit(result.data.tenantId))) {
    return scimError(429, "Too many requests");
  }

  return scimResponse([
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
  ]);
}
