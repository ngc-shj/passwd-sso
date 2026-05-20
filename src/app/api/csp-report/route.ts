import { type NextRequest, NextResponse } from "next/server";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getLogger } from "@/lib/logger";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { extractClientIpFromHeaders } from "@/lib/auth/policy/ip-access";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import { CSP_REPORT_RATE_MAX, MAX_JSON_BODY_BYTES, RATE_WINDOW_MS } from "@/lib/validations/common.server";
import { readJsonWithCap } from "@/lib/http/parse-body";

export const runtime = "nodejs";
const cspLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: CSP_REPORT_RATE_MAX });

/**
 * Hard length cap for any string field emitted into the log line.
 * L1: without this, a 50 KB document-uri in a single CSP violation
 * payload (already inside the global MAX_JSON_BODY_BYTES envelope)
 * would still expand every downstream log row. Cap individually so
 * one chatty page can't bloat log shipping or storage. 2 KB is
 * comfortably above any legitimate URL length.
 */
const CSP_FIELD_MAX_LENGTH = 2_048;

function capString(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.length > CSP_FIELD_MAX_LENGTH ? s.slice(0, CSP_FIELD_MAX_LENGTH) : s;
}

/**
 * Strip query string and fragment from a URI to prevent token leakage.
 * Returns origin + pathname only, length-capped.
 */
function stripUriQuery(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri) return undefined;
  try {
    const u = new URL(uri);
    return capString(u.origin + u.pathname);
  } catch {
    // Relative URI or invalid — return as-is after stripping ?/# manually
    return capString(uri.split(/[?#]/)[0] || undefined);
  }
}

function capDirective(s: unknown): string | undefined {
  return typeof s === "string" ? capString(s) : undefined;
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
      "violated-directive": capDirective(r["violated-directive"]),
      "effective-directive": capDirective(r["effective-directive"]),
      disposition: capDirective(r["disposition"]),
      "status-code": typeof r["status-code"] === "number" ? r["status-code"] : undefined,
    };
  }

  // application/reports+json format: [{ type, body: { ... } }]
  if (Array.isArray(body)) {
    const first = body[0];
    if (first && typeof first === "object" && "type" in first) {
      const b = (first as Record<string, unknown>).body as Record<string, unknown> | undefined;
      return {
        type: capDirective((first as Record<string, unknown>).type),
        documentURL: b ? stripUriQuery(b["documentURL"]) : undefined,
        blockedURL: b ? stripUriQuery(b["blockedURL"]) : undefined,
        effectiveDirective: capDirective(b?.["effectiveDirective"]),
        disposition: capDirective(b?.["disposition"]),
      };
    }
  }

  // Unknown format — log nothing
  return undefined;
}

// POST /api/csp-report
// Receives CSP violation reports.
async function handlePOST(request: NextRequest) {
  const rl = await checkIpRateLimit({
    ip: extractClientIpFromHeaders(request.headers),
    pathname: "/api/csp-report",
    scope: "csp_report",
    limiter: cspLimiter,
  });
  if (!rl.allowed) return new NextResponse(null, { status: 204 });

  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/csp-report") ||
    contentType.includes("application/reports+json")
  ) {
    const read = await readJsonWithCap(request, MAX_JSON_BODY_BYTES);
    const body = read.ok ? read.body : null;
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
