import { handlers } from "@/auth";
import { withRequestLog } from "@/lib/with-request-log";

export const runtime = "nodejs";

export const GET = withRequestLog(handlers.GET);
export const POST = withRequestLog(handlers.POST);
