/**
 * Apply CSP, Referrer-Policy, X-Content-Type-Options, X-Frame-Options,
 * HSTS (in HTTPS), Permissions-Policy, and the per-request CSP nonce
 * cookie to a NextResponse.
 *
 * Extracted from `src/proxy.ts` so the orchestrator stays thin.
 */

import { NextResponse } from "next/server";
import { API_PATH } from "@/lib/constants";
import { PERMISSIONS_POLICY } from "@/lib/security/security-headers";
import { isHttps } from "@/lib/url-helpers";

export type SecurityHeadersOptions = {
  cspHeader: string;
  nonce: string;
};

export function applySecurityHeaders(
  response: NextResponse,
  { cspHeader, nonce }: SecurityHeadersOptions,
  basePath: string = "",
): NextResponse {
  response.headers.set("Content-Security-Policy", cspHeader);
  const cspReportUrl = `${basePath}${API_PATH.CSP_REPORT}`;
  response.headers.set(
    "Report-To",
    JSON.stringify({
      group: "csp-endpoint",
      max_age: 10886400,
      endpoints: [{ url: cspReportUrl }],
    }),
  );
  response.headers.set(
    "Reporting-Endpoints",
    `csp-endpoint="${cspReportUrl}"`,
  );

  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  if (isHttps) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }
  response.headers.set("Permissions-Policy", PERMISSIONS_POLICY);

  response.cookies.set("csp-nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps,
    path: `${basePath}/`,
  });

  return response;
}
