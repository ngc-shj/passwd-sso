import { type NextRequest, NextResponse } from "next/server";
import { withRequestLog } from "@/lib/http/with-request-log";
import { runReadinessChecks } from "@/lib/health";

export const runtime = "nodejs";

async function handleGET(_request: NextRequest) {
  void _request;
  // C20 (OWASP A05-1): /ready body is minimized to `{ status }` only.
  // Previously included `checks.auditOutbox` which leaked pending-row
  // counts + DB/Redis latency to unauthenticated callers. Detailed
  // metrics remain available at /api/maintenance/audit-outbox-metrics
  // (auth-gated via operator token).
  //
  // The auditOutbox health check is also REMOVED from readiness — worker
  // backlog is not app liveness. With it in /ready, K8s ready=false on
  // worker outage would cycle the app pod, masking the real problem.
  const result = await runReadinessChecks();
  const httpStatus = result.status === "unhealthy" ? 503 : 200;
  return NextResponse.json(
    { status: result.status },
    { status: httpStatus, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = withRequestLog(handleGET);
