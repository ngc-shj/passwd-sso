// Client-side Sentry initialization.
// This file is loaded by Next.js as the client instrumentation entry point.
// See: https://docs.sentry.io/platforms/javascript/guides/nextjs/
import * as Sentry from "@sentry/nextjs";
import "./sentry.client.config";

// Client-side navigations in the App Router are not page loads, so without this
// hook they produce no transaction at all and the trace for anything a user does
// after the first render is simply missing. The SDK cannot hook the router
// itself and asks for this export by name at build time.
//
// Safe to export unconditionally: sentry.client.config.ts only calls init() when
// NEXT_PUBLIC_SENTRY_DSN is set, and with no client the capture is a no-op.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
