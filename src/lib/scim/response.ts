import { NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/url-helpers";

const SCIM_CONTENT_TYPE = "application/scim+json";

/**
 * Build the SCIM base URL from the environment.
 * Uses getAppOrigin() (APP_URL > AUTH_URL) for the origin,
 * and NEXT_PUBLIC_BASE_PATH for the sub-path prefix.
 *
 * Throws if no origin is configured — SCIM requires absolute URLs
 * (RFC 7644 §3.1 meta.location). AUTH_URL is required in production
 * (env.ts superRefine), so this only throws on misconfigured dev setups.
 */
export function getScimBaseUrl(): string {
  const base = getAppOrigin();
  if (!base) {
    throw new Error("getScimBaseUrl: APP_URL or AUTH_URL must be set for SCIM");
  }
  let basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  if (basePath && !basePath.startsWith("/")) basePath = `/${basePath}`;
  return `${base.replace(/\/$/, "")}${basePath}/api/scim/v2`;
}

/**
 * Create a SCIM-compliant JSON response with `application/scim+json`.
 */
export function scimResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Content-Type": SCIM_CONTENT_TYPE },
  });
}

/**
 * SCIM error response per RFC 7644 §3.12.
 *
 * ```json
 * {
 *   "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
 *   "status": "409",
 *   "scimType": "uniqueness",
 *   "detail": "User already exists"
 * }
 * ```
 */
export function scimError(
  status: number,
  detail: string,
  scimType?: string,
): NextResponse {
  const body: Record<string, unknown> = {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail,
  };
  if (scimType) body.scimType = scimType;

  return NextResponse.json(body, {
    status,
    headers: { "Content-Type": SCIM_CONTENT_TYPE },
  });
}

/**
 * SCIM ListResponse per RFC 7644 §3.4.2.
 */
export function scimListResponse(
  resources: unknown[],
  totalResults: number,
  startIndex = 1,
): NextResponse {
  return NextResponse.json(
    {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    },
    {
      status: 200,
      headers: { "Content-Type": SCIM_CONTENT_TYPE },
    },
  );
}
