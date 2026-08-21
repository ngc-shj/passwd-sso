"use client";

import { toast } from "sonner";

import { CLIPBOARD_CLEAR_TIMEOUT_MS } from "@/lib/constants";
import { MS_PER_SECOND } from "@/lib/constants/time";
import { COPY_OUTCOME, type CopyOutcome } from "./copy-secret";

// Matches next-intl's Translator value shape so a `useTranslations(...)` result
// is assignable without a cast at the call sites.
type Translator = (
  key: string,
  values?: Record<string, string | number | Date>,
) => string;

interface ReportOptions {
  /** Bound to the `CopyButton` namespace, which every copy surface can load. */
  tCopy: Translator;
  /**
   * Bound to the `PasswordCard` namespace. Optional because that namespace is
   * only in NS_DASHBOARD_CORE — `CopyButton` also renders on the public share
   * route and in the admin console, where it is not loaded. When absent,
   * SOURCE_FAILED falls back to a `CopyButton` string instead of rendering a
   * missing-message key.
   */
  tCard?: Translator;
  /** Overrides the success toast for callers that own their own OK feedback. */
  onOk?: () => void;
}

/**
 * The single place a CopyOutcome becomes something the user can see.
 *
 * One reporter rather than a switch per handler: all ten non-silent handlers in
 * PasswordCard already emitted the identical `networkError`, so duplicating the
 * mapping eleven times would buy nothing and would let the copies drift. The
 * `never`-typed default makes adding an outcome a compile error here instead of
 * a silently unreported branch there.
 *
 * CANCELLED is the one outcome that raises nothing: the user declined a
 * passphrase prompt, and answering that with "try again" teaches people to click
 * through a security control.
 */
export function reportCopyOutcome(
  outcome: CopyOutcome,
  { tCopy, tCard, onOk }: ReportOptions,
): void {
  switch (outcome) {
    case COPY_OUTCOME.OK:
      if (onOk) {
        onOk();
      } else {
        toast.success(
          tCopy("copied", { seconds: CLIPBOARD_CLEAR_TIMEOUT_MS / MS_PER_SECOND }),
        );
      }
      return;
    case COPY_OUTCOME.CANCELLED:
      return;
    case COPY_OUTCOME.EMPTY:
      toast.error(tCopy("copyEmpty"));
      return;
    case COPY_OUTCOME.UNAVAILABLE:
      toast.error(tCopy("copyUnavailable"));
      return;
    case COPY_OUTCOME.WRITE_FAILED:
      toast.error(tCopy("copyWriteFailed"));
      return;
    case COPY_OUTCOME.SOURCE_FAILED:
      toast.error(tCard ? tCard("networkError") : tCopy("copySourceFailed"));
      return;
    default: {
      const unreported: never = outcome;
      throw new Error(`unreported copy outcome: ${String(unreported)}`);
    }
  }
}
