import { NextRequest, NextResponse } from "next/server";
import { buildOpenApiSpec } from "@/lib/openapi-spec";
import { authOrToken } from "@/lib/auth-or-token";
import { withRequestLog } from "@/lib/with-request-log";
import { unauthorized } from "@/lib/api-response";

// GET /api/v1/openapi.json — OpenAPI 3.1 specification
async function handleGET(req: NextRequest) {
  const isPublic = process.env.OPENAPI_PUBLIC !== "false";

  if (!isPublic) {
    // Require any valid auth (session, extension token, or API key)
    const result = await authOrToken(req);
    if (!result) {
      return unauthorized();
    }
  }

  const url = new URL(req.url);
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  const baseUrl = `${url.protocol}//${url.host}${basePath}`;
  const spec = buildOpenApiSpec(baseUrl);

  return NextResponse.json(spec, {
    headers: {
      "Cache-Control": isPublic
        ? "public, max-age=3600"
        : "private, no-store",
    },
  });
}

export const GET = withRequestLog(handleGET);
