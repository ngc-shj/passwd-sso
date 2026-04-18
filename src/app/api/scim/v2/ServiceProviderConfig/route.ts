import type { NextRequest } from "next/server";
import { scimResponse } from "@/lib/scim/response";
import { withTenantRls } from "@/lib/tenant-rls";
import { prisma } from "@/lib/prisma";
import { withRequestLog } from "@/lib/with-request-log";
import { authorizeScim } from "@/lib/scim/with-scim-auth";

// GET /api/scim/v2/ServiceProviderConfig
async function handleGET(req: NextRequest) {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.data;

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

export const GET = withRequestLog(handleGET);
