/**
 * Request logging wrapper for API route handlers.
 *
 * Wraps a Next.js route handler to automatically log:
 * - request.start  (method, path, requestId)
 * - request.end    (status, durationMs)
 * - request.error  (err, durationMs) on unhandled exceptions
 *
 * Sets X-Request-Id response header for client-side correlation.
 * Inside the handler, call `getLogger()` to get a child logger
 * that includes the requestId context.
 */

import { type NextRequest } from "next/server";
import logger, { requestContext } from "@/lib/logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (...args: any[]) => Promise<Response>;

export function withRequestLog<H extends RouteHandler>(handler: H): H {
  const loggedHandler = async function loggedHandler(...args: Parameters<H>) {
    const request = args[0] as NextRequest;
    const requestId = crypto.randomUUID();
    const start = performance.now();
    const url = new URL(request.url);

    const reqLogger = logger.child({
      requestId,
      method: request.method,
      path: url.pathname,
    });

    return requestContext.run(reqLogger, async () => {
      reqLogger.info("request.start");

      try {
        const response = await handler(...args);
        const durationMs = Math.round(performance.now() - start);

        reqLogger.info({ status: response.status, durationMs }, "request.end");
        response.headers.set("X-Request-Id", requestId);

        return response;
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        reqLogger.error({ err, durationMs }, "request.error");
        throw err;
      }
    });
  } as unknown as H;
  return loggedHandler;
}
