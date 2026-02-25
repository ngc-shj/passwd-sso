import { NextResponse } from "next/server";

const SCIM_CONTENT_TYPE = "application/scim+json";

/**
 * Build the SCIM base URL from the environment.
 * Uses `NEXTAUTH_URL` to avoid trusting client-supplied Host/X-Forwarded-Proto headers.
 */
export function getScimBaseUrl(): string {
  const base = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/scim/v2`;
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
