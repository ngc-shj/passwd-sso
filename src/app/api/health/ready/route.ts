import { NextResponse } from "next/server";
import { withRequestLog } from "@/lib/with-request-log";
import { runHealthChecks } from "@/lib/health";

export const runtime = "nodejs";

async function handleGET() {
  const result = await runHealthChecks();
  const httpStatus = result.status === "unhealthy" ? 503 : 200;
  return NextResponse.json(result, {
    status: httpStatus,
    headers: { "Cache-Control": "no-store" },
  });
}

export const GET = withRequestLog(handleGET);
