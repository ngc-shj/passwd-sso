import type { NextRequest } from "next/server";
import { validateScimToken } from "@/lib/scim-token";
import { scimResponse, scimError } from "@/lib/scim/response";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withTenantRls } from "@/lib/tenant-rls";
import { prisma } from "@/lib/prisma";

// GET /api/scim/v2/ServiceProviderConfig
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
    scimResponse({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://tools.ietf.org/html/rfc7644",
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "OAuth Bearer Token",
          description: "Authentication scheme using the OAuth Bearer Token Standard",
          specUri: "https://tools.ietf.org/html/rfc6750",
        },
      ],
    }),
  );
}
