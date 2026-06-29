"use client";

import {
  EXT_CONNECT_REQUEST_MSG_TYPE,
  EXT_CONNECT_READY_MSG_TYPE,
} from "@/lib/constants";
import { MS_PER_SECOND } from "@/lib/constants/time";

/**
 * Error codes the web app handles. Anything the extension SW reports outside
 * this union is coerced to `GENERIC_FAILURE` so the UI never has to deal with
 * an unbounded code set.
 */
export const EXTENSION_CONNECT_ERROR_CODE = {
  EXTENSION_ABSENT: "EXTENSION_ABSENT",
  SESSION_STEP_UP_REQUIRED: "SESSION_STEP_UP_REQUIRED",
  PASSKEY_REQUIRED: "PASSKEY_REQUIRED",
  GENERIC_FAILURE: "GENERIC_FAILURE",
} as const;

export type ExtensionConnectErrorCode =
  (typeof EXTENSION_CONNECT_ERROR_CODE)[keyof typeof EXTENSION_CONNECT_ERROR_CODE];

export type ExtensionConnectResult =
  | { ok: true }
  | { ok: false; errorCode: ExtensionConnectErrorCode };

// SW cold-start (~1s) + DPoP key gen on cold IDB (~200ms) + two network
// RTTs (bridge-code POST + exchange POST, ~2s each on slow networks) + per-
// fetch DB writes (~500ms each) + safety margin. The legacy
// requestExtensionJkt was 500ms which is fine for a single round-trip
// postMessage but too tight for this new SW-initiated dual-fetch flow.
const DEFAULT_TIMEOUT_MS = 8 * MS_PER_SECOND;

export function coerceErrorCode(input: unknown): ExtensionConnectErrorCode {
  if (typeof input !== "string") return EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE;
  if (
    input === EXTENSION_CONNECT_ERROR_CODE.SESSION_STEP_UP_REQUIRED ||
    input === EXTENSION_CONNECT_ERROR_CODE.EXTENSION_ABSENT ||
    input === EXTENSION_CONNECT_ERROR_CODE.PASSKEY_REQUIRED
  ) {
    return input;
  }
  return EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE;
}

/**
 * Ask the extension SW (via the content-script relay) to initiate the
 * bridge-code + exchange handshake. The web app never sees the bridge code
 * or the token — the SW does the fetches itself and persists the result in
 * its own heap.
 *
 * Posts EXT_CONNECT_REQUEST to the same origin, waits up to `timeoutMs` for
 * a matching EXT_CONNECT_READY reply. Timeout → `EXTENSION_ABSENT` (the
 * extension is either not installed or its content script never replied).
 */
export async function requestExtensionConnect(
  opts: { timeoutMs?: number } = {},
): Promise<ExtensionConnectResult> {
  const reqId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `req-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let handler: ((event: MessageEvent) => void) | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await new Promise<ExtensionConnectResult>((resolve) => {
      let settled = false;

      handler = (event: MessageEvent) => {
        if (settled) return;
        if (event.source !== window) return;
        if (event.origin !== window.location.origin) return;
        const data = event.data as
          | { type?: unknown; reqId?: unknown; ok?: unknown; errorCode?: unknown }
          | null;
        if (!data || data.type !== EXT_CONNECT_READY_MSG_TYPE) return;
        if (data.reqId !== reqId) return;

        settled = true;
        if (data.ok === true) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, errorCode: coerceErrorCode(data.errorCode) });
        }
      };

      window.addEventListener("message", handler);
      window.postMessage(
        { type: EXT_CONNECT_REQUEST_MSG_TYPE, reqId },
        window.location.origin,
      );

      timerId = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, errorCode: EXTENSION_CONNECT_ERROR_CODE.EXTENSION_ABSENT });
        }
      }, timeoutMs);
    });
  } finally {
    if (handler !== null) window.removeEventListener("message", handler);
    if (timerId !== null) clearTimeout(timerId);
  }
}
