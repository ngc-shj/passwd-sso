import { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { extractRequestMeta } from "@/lib/audit/audit";
import { sessionMetaStorage } from "@/lib/auth/session/session-meta";
import { tenantClaimStorage } from "@/lib/tenant/tenant-claim-storage";

export const runtime = "nodejs";

type RouteHandler = (
  request: NextRequest,
  ...rest: unknown[]
) => Promise<Response>;

/**
 * Next.js strips basePath from the URL before delivering it to route handlers,
 * but Auth.js needs the full URL (including basePath) to:
 *   1. Parse actions correctly (basePath = `${NEXT_PUBLIC_BASE_PATH}/api/auth`)
 *   2. Build OAuth callback URLs with the correct prefix
 *
 * This wrapper restores the basePath prefix that Next.js removed.
 */
function withAuthBasePath<H extends RouteHandler>(handler: H): H {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  if (!basePath) return handler;

  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(basePath)) {
      url.pathname = `${basePath}${url.pathname}`;
    }
    const patched = new NextRequest(url.toString(), {
      headers: request.headers,
      method: request.method,
      body: request.body,
      duplex: "half",
    });
    return handler(patched, ...rest);
  };
  return wrapped as unknown as H;
}

function withSessionMeta<H extends RouteHandler>(handler: H): H {
  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    const meta = extractRequestMeta(request);
    return sessionMetaStorage.run(meta, () =>
      tenantClaimStorage.run({ tenantClaim: null }, () =>
        handler(request, ...rest),
      ),
    );
  };
  return wrapped as unknown as H;
}

// Exported for testing
export { withAuthBasePath as _withAuthBasePath };

export const GET = withRequestLog(withSessionMeta(withAuthBasePath(handlers.GET)));
export const POST = withRequestLog(withSessionMeta(withAuthBasePath(handlers.POST)));
