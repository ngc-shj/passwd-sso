// Client-side entry point. Next.js `require`s this module synchronously,
// unconditionally and without a try/catch before `appBootstrap(...)` — in both
// the webpack (`next/dist/client/app-next.js`) and Turbopack
// (`app-next-turbopack.js`) bootstraps — so it is the one placement whose
// evaluation is ordered ahead of every application chunk. Two CSP remedies
// depend on that ordering; see docs/archive/review/prod-csp-violation-zero-plan.md
// (contracts C2 and C4).
import * as Sentry from "@sentry/nextjs";
import { setNonce } from "get-nonce";
import { z } from "zod";
import { readCspNonce } from "@/lib/ui/csp-nonce";
import "./sentry.client.config";

// C2 — `react-style-singleton` (reached by every Radix overlay through
// `react-remove-scroll`) injects a <style> on first mount and takes its nonce
// from this module global. Nothing else in the app sets it, so without this
// line the scroll-lock stylesheet is CSP-blocked in production. Priming it
// here rather than from a React component removes the chunk-order gamble: the
// style is injected from an effect, which runs long after this module.
//
// No carrier is a real state, not an impossible one — the root error boundary
// renders its own <html><body> with no <head> and no nonced script. Say so
// once rather than leaving three consumers each to interpret a silent miss;
// get-nonce then falls through to its own `__webpack_nonce__` lookup, which
// is the behaviour that predates this line.
const clientNonce = readCspNonce();
if (clientNonce) {
  setNonce(clientNonce);
} else {
  console.warn(
    "CSP_NONCE_CARRIER_UNAVAILABLE: no script[nonce] and no <meta name=\"csp-nonce\"> " +
      "on this document; runtime-injected styles will not be nonced.",
  );
}

// C4 — Zod's `allowsEval` probe calls `Function("")` to decide whether it may
// JIT-compile object parsers. The throw is caught, so the fallback path works,
// but the attempt is reported as a `script-src` violation on every page load
// and lands in the CSP report endpoint. `jitless` is read *before* the probe
// (zod/v4/core/util.js), so setting it here skips the call entirely. This is
// the client entry, so the server keeps its JIT path.
z.config({ jitless: true });

// Client-side navigations in the App Router are not page loads, so without this
// hook they produce no transaction at all and the trace for anything a user does
// after the first render is simply missing. The SDK cannot hook the router
// itself and asks for this export by name at build time.
//
// Safe to export unconditionally: sentry.client.config.ts only calls init() when
// NEXT_PUBLIC_SENTRY_DSN is set, and with no client the capture is a no-op.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
