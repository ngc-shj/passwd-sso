"use client";

import { EXT_JKT_REQUEST_MSG_TYPE, EXT_JKT_READY_MSG_TYPE } from "@/lib/constants";

// RFC 7638 P-256 thumbprint: 43 base64url characters (256-bit SHA-256, base64url-no-pad).
const JKT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Ask the extension content script for its DPoP key thumbprint (jkt).
 *
 * Posts PASSWD_SSO_EXT_JKT_REQUEST to the same origin, then waits up to
 * `timeoutMs` for a matching PASSWD_SSO_EXT_JKT_READY reply.
 *
 * Returns the jkt string on success, or null if the timeout expires (e.g.,
 * extension not installed / old extension that does not handle the request).
 */
export async function requestExtensionJkt(opts: { timeoutMs: number }): Promise<string | null> {
  const reqId = crypto.randomUUID();

  let handler: ((event: MessageEvent) => void) | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  try {
    const jkt = await new Promise<string | null>((resolve) => {
      let settled = false;

      handler = (event: MessageEvent) => {
        if (settled) return;
        // Strict origin + source filters prevent injected READY messages from
        // iframes or other windows from being honoured (C9a contract).
        if (event.source !== window) return;
        if (event.origin !== window.location.origin) return;
        if (event.data?.type !== EXT_JKT_READY_MSG_TYPE) return;
        if (event.data?.reqId !== reqId) return;
        if (typeof event.data?.jkt !== "string") return;
        if (!JKT_PATTERN.test(event.data.jkt)) return;

        // Honour only the first matching reply.
        settled = true;
        resolve(event.data.jkt as string);
      };

      // Register listener before posting the request to avoid a race.
      window.addEventListener("message", handler);

      // Post the JKT request to own origin only (never "*").
      window.postMessage({ type: EXT_JKT_REQUEST_MSG_TYPE, reqId }, window.location.origin);

      timerId = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, opts.timeoutMs);
    });

    return jkt;
  } finally {
    // Always remove the listener regardless of success or timeout.
    if (handler !== null) {
      window.removeEventListener("message", handler);
    }
    if (timerId !== null) {
      clearTimeout(timerId);
    }
  }
}
