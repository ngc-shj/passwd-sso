/**
 * GET /api/mobile/authorize/redirect — Universal-Link claim target.
 *
 * The iOS host app's apple-app-site-association (AASA) file claims this path,
 * so once `/api/mobile/authorize` redirects here the OS hands the URL to the
 * iOS app instead of letting the browser render the response. The query
 * parameters (`code`, `state`) flow through to the iOS app via the URL.
 *
 * On the SERVER side this is a thin handler — it only renders a static fallback
 * page in case the OS Universal-Link claim does not engage (e.g. the user
 * pasted the link into a desktop browser). No DB access, no auth, no audit.
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLog } from "@/lib/http/with-request-log";

export const runtime = "nodejs";

const FALLBACK_HTML = "<!doctype html><html><body>Sign-in complete. Return to passwd-sso.</body></html>";

async function handleGET(_req: NextRequest): Promise<Response> {
  return new NextResponse(FALLBACK_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Defence-in-depth: the page is a static no-op string, so no need to
      // ever cache it. Keeps the URL safe to share without leaking state.
      "Cache-Control": "no-store",
    },
  });
}

export const GET = withRequestLog(handleGET);
