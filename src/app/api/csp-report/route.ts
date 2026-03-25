import { NextResponse } from "next/server";
import { withRequestLog } from "@/lib/with-request-log";
import { getLogger } from "@/lib/logger";
import { createRateLimiter } from "@/lib/rate-limit";
import { CSP_REPORT_RATE_MAX, RATE_WINDOW_MS } from "@/lib/validations/common.server";

export const runtime = "nodejs";
const cspLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: CSP_REPORT_RATE_MAX });

/**
 * Strip query string and fragment from a URI to prevent token leakage.
 * Returns origin + pathname only.
 */
function stripUriQuery(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri) return undefined;
  try {
    const u = new URL(uri);
    return u.origin + u.pathname;
  } catch {
    // Relative URI or invalid — return as-is after stripping ?/# manually
    return uri.split(/[?#]/)[0] || undefined;
  }
}

/** Allowlist fields from a CSP violation report, sanitizing URIs. */
function sanitizeCspReport(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined;

  // application/csp-report format: { "csp-report": { ... } }
  const report = (body as Record<string, unknown>)["csp-report"];
  if (report && typeof report === "object") {
    const r = report as Record<string, unknown>;
    return {
      "document-uri": stripUriQuery(r["document-uri"]),
      "blocked-uri": stripUriQuery(r["blocked-uri"]),
      "violated-directive": typeof r["violated-directive"] === "string" ? r["violated-directive"] : undefined,
      "effective-directive": typeof r["effective-directive"] === "string" ? r["effective-directive"] : undefined,
      disposition: typeof r["disposition"] === "string" ? r["disposition"] : undefined,
      "status-code": typeof r["status-code"] === "number" ? r["status-code"] : undefined,
    };
  }

  // application/reports+json format: [{ type, body: { ... } }]
  if (Array.isArray(body)) {
    const first = body[0];
    if (first && typeof first === "object" && "type" in first) {
      const b = (first as Record<string, unknown>).body as Record<string, unknown> | undefined;
      return {
        type: (first as Record<string, unknown>).type,
        documentURL: b ? stripUriQuery(b["documentURL"]) : undefined,
        blockedURL: b ? stripUriQuery(b["blockedURL"]) : undefined,
        effectiveDirective: typeof b?.["effectiveDirective"] === "string" ? b["effectiveDirective"] : undefined,
        disposition: typeof b?.["disposition"] === "string" ? b["disposition"] : undefined,
      };
    }
  }

  // Unknown format — log nothing
  return undefined;
}

// POST /api/csp-report
// Receives CSP violation reports.
async function handlePOST(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    "unknown";
  const rl = await cspLimiter.check(`rl:csp_report:${ip}`);
  if (!rl.allowed) return new NextResponse(null, { status: 204 });

  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/csp-report") ||
    contentType.includes("application/reports+json")
  ) {
    const body = await request.json().catch(() => null);
    if (body) {
      const sanitized = sanitizeCspReport(body);
      if (sanitized) {
        getLogger().warn({ cspReport: sanitized }, "csp.violation");
      }
    }
  }

  return new NextResponse(null, { status: 204 });
}

export const POST = withRequestLog(handlePOST);
