import { type NextRequest } from "next/server";
import { handlers } from "@/auth";
import { withRequestLog } from "@/lib/with-request-log";
import { extractRequestMeta } from "@/lib/audit";
import { sessionMetaStorage } from "@/lib/session-meta";

export const runtime = "nodejs";

type RouteHandler = (
  request: NextRequest,
  ...rest: unknown[]
) => Promise<Response>;

function withSessionMeta<H extends RouteHandler>(handler: H): H {
  const wrapped = async (request: NextRequest, ...rest: unknown[]) => {
    const meta = extractRequestMeta(request);
    return sessionMetaStorage.run(meta, () => handler(request, ...rest));
  };
  return wrapped as unknown as H;
}

export const GET = withRequestLog(withSessionMeta(handlers.GET));
export const POST = withRequestLog(withSessionMeta(handlers.POST));
