"use client";

import { CLIPBOARD_CLEAR_TIMEOUT_MS } from "@/lib/constants";
import { clientLogError } from "@/lib/logger/client";
import { CLIENT_LOG_EVENT, toClientErrorCode } from "@/lib/logger/client-events";
import { CopyCancelledError } from "./copy-cancelled-error";

/**
 * The single site in `src/` that writes a value whose exposure this product
 * bounds in time — a vault-blob or overview value, the generated password, the
 * recovery key — to the system clipboard.
 *
 * It never throws. Every path returns a CopyOutcome, because the defect this
 * module exists to remove is a copy that fails invisibly: before it, the fetch
 * and the write shared one `try` with an empty `catch`, so a decrypt failure, a
 * denied clipboard and an empty field were all indistinguishable from a dead
 * button.
 */
export const COPY_OUTCOME = {
  OK: "ok",
  /** The value was empty or whitespace — nothing reached the clipboard. */
  EMPTY: "empty",
  /** The user declined a re-prompt. The only outcome callers may report silently. */
  CANCELLED: "cancelled",
  /** No Clipboard API — an insecure origin, or a browser without it. */
  UNAVAILABLE: "unavailable",
  /** The value could not be obtained (fetch, decrypt, or a non-string result). */
  SOURCE_FAILED: "source_failed",
  /** The value was obtained but the clipboard write was rejected. */
  WRITE_FAILED: "write_failed",
} as const;

export type CopyOutcome = (typeof COPY_OUTCOME)[keyof typeof COPY_OUTCOME];

/**
 * `navigator.clipboard` is `[SecureContext]`, so this is false on a non-HTTPS,
 * non-loopback origin as well as in a DOM-less environment. Checked inside the
 * function body, never at module scope, so importing this module from a
 * server-rendered tree cannot throw.
 */
function isClipboardAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function"
  );
}

/**
 * Overwrite the clipboard after CLIPBOARD_CLEAR_TIMEOUT_MS, but only if it still
 * holds what we put there.
 *
 * When the read-back is unavailable we blank it anyway. That is not a rare
 * branch: `readText` is not exposed to page script in Firefox and is
 * permission-gated in WebKit, so the fallback is the dominant path there. The
 * trade is deliberate — bounding a decrypted secret's residency outranks
 * preserving an unrelated clipboard value, at the cost of clobbering something
 * the user copied in between.
 *
 * Scheduled outside any React lifecycle and deliberately NOT cancelled on
 * unmount or client-side navigation: the secret outlives the component, so the
 * clear must too. Only a full page unload stops it.
 *
 * Three other runtimes implement this same contract and CANNOT import this
 * module. They each own their interval BY DESIGN, so a policy change here is a
 * per-runtime decision, not a mechanical sync:
 *   - cli/src/lib/clipboard.ts — 30s, plus a clear on SIGINT/SIGTERM/exit.
 *   - extension/src/popup/components/MatchList.tsx — user-configurable
 *     (`clipboardClearSeconds`), and blanks without a read-back compare.
 *   - ios/Shared/Clipboard/SecureClipboard.swift — hands the deadline to the OS
 *     via UIPasteboard.expirationDate; there is no timer to mirror.
 */
function scheduleClear(copiedValue: string): void {
  setTimeout(async () => {
    try {
      const current = await navigator.clipboard.readText();
      if (current === copiedValue) {
        await navigator.clipboard.writeText("");
      }
    } catch {
      try {
        await navigator.clipboard.writeText("");
      } catch {
        // Both the read-back and the blanking write failed — a backgrounded tab,
        // or a revoked permission. Best-effort by construction; there is no
        // further recovery, and the secret's residency is unbounded from here.
      }
    }
  }, CLIPBOARD_CLEAR_TIMEOUT_MS);
}

/**
 * The user-facing message never carries the underlying error: `JSON.parse` runs
 * on the DECRYPTED vault blob, and V8 embeds a prefix of its input in
 * SyntaxError.message. `toClientErrorCode` reduces the error to a member of a
 * closed vocabulary — it reads `instanceof` and `DOMException.name` only, never
 * `message` or `cause` — so nothing derived from plaintext can reach a console
 * breadcrumb and, from there, Sentry.
 */
function reportFailure(err: unknown): void {
  clientLogError(CLIENT_LOG_EVENT.CLIPBOARD_COPY_FAILED, {
    code: toClientErrorCode(err),
  });
}

async function copy(
  getValue: () => Promise<string> | string,
  autoClear: boolean,
): Promise<CopyOutcome> {
  // Availability is decided BEFORE the value is obtained, so a page that cannot
  // reach the clipboard never decrypts a secret — and never demands a
  // passphrase — for a write it structurally cannot perform.
  if (!isClipboardAvailable()) return COPY_OUTCOME.UNAVAILABLE;

  let value: string;
  try {
    const resolved = await getValue();
    if (typeof resolved !== "string") return COPY_OUTCOME.SOURCE_FAILED;
    value = resolved;
  } catch (err) {
    // `instanceof` only. Matching on `err.name` would let any object claiming to
    // be a CopyCancelledError inherit CANCELLED, which is the one outcome
    // callers are allowed to report silently.
    if (err instanceof CopyCancelledError) return COPY_OUTCOME.CANCELLED;
    reportFailure(err);
    return COPY_OUTCOME.SOURCE_FAILED;
  }

  // Emptiness is judged on the value, before any write, so an empty field never
  // wipes what the user already had on the clipboard.
  //
  // `trim()` is deliberately wider than the `!value` guards this replaced: it
  // also refuses whitespace-only. That is right for a card number or an ID, and
  // is a knowing narrowing for a password — " " is a legal passphrase and can no
  // longer be copied. The primitive cannot tell the two apart, and the trade
  // favours never reporting a copy that put nothing useful on the clipboard.
  if (value.trim() === "") return COPY_OUTCOME.EMPTY;

  try {
    // The untrimmed value is written: trimming decides emptiness only, and a
    // secret may carry significant leading or trailing whitespace.
    await navigator.clipboard.writeText(value);
  } catch (err) {
    reportFailure(err);
    return COPY_OUTCOME.WRITE_FAILED;
  }

  if (autoClear) scheduleClear(value);
  return COPY_OUTCOME.OK;
}

/** Copy a secret and blank the clipboard after CLIPBOARD_CLEAR_TIMEOUT_MS. */
export async function copySecretToClipboard(
  getValue: () => Promise<string> | string,
): Promise<CopyOutcome> {
  return copy(getValue, true);
}

/**
 * Copy a secret WITHOUT scheduling the clear.
 *
 * A separate export rather than an option flag: a boolean parameter is reachable
 * from every CopyButton call site and reviewing it means reasoning about
 * arguments, whereas a distinct identifier can be grepped and its call sites
 * enumerated. Today the only legitimate caller is the recovery-key dialog, whose
 * key the user is instructed to store permanently — clearing it out from under a
 * paste would break the dialog's purpose.
 */
export async function copySecretWithoutClear(
  getValue: () => Promise<string> | string,
): Promise<CopyOutcome> {
  return copy(getValue, false);
}
