"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { reauthenticateWithPasskey } from "@/lib/auth/webauthn/passkey-reauth-client";
import { canUsePasskeyRecovery } from "@/lib/auth/webauthn/can-use-passkey-recovery";

interface InlineReauthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel: string;
  errorMessage: string | null;
  isReauthenticating: boolean;
  onAction: () => Promise<void>;
}

interface InlineRecentSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel: string;
}

interface UseInlineReauthResult<T> {
  /** Spread into <PasskeyReauthDialog>. cancelLabel must still be provided by the caller (its source namespace varies). */
  reauthDialogProps: InlineReauthDialogProps;
  /** Spread into <RecentSessionRequiredDialog>. cancelLabel must still be provided by the caller. */
  recentSessionDialogProps: InlineRecentSessionDialogProps;
  /**
   * Call this from the SESSION_STEP_UP_REQUIRED branch of the API error handler.
   * Pass the retry argument identifying which mutation to replay after reauth
   * (a row id, a discriminated action, …); it is handed back to `onSuccess`.
   * Single-action callers omit it (`T = void`).
   */
  triggerOnStaleError: (retryArg: T) => Promise<void>;
}

/**
 * Encapsulate the "stale-session → passkey reauth or recent-session" UX shared
 * by the developer-settings credential-issuance cards (api-keys, mcp-clients,
 * scim-tokens, service-accounts, access-requests).
 *
 * Flow:
 *  - On a SESSION_STEP_UP_REQUIRED error, the caller invokes
 *    `triggerOnStaleError()`. The hook probes whether the user has a passkey
 *    (`canUsePasskeyRecovery`) and opens either the passkey reauth dialog or
 *    the recent-session dialog.
 *  - On the passkey reauth dialog's confirm button, the hook runs the
 *    WebAuthn ceremony and on success calls `onSuccess` (typically the same
 *    create handler that originally returned the stale-session error).
 *
 * Operator Token has a more complex retry path (limit-exceeded vs second
 * stale-session vs generic retry-failed) and does NOT use this hook — see
 * `operator-token-card.tsx` for that flow.
 *
 * Retry argument:
 *  - Multi-target callers (a list of rows, or several distinct mutations
 *    behind one hook) pass `triggerOnStaleError(arg)` to record WHICH mutation
 *    failed; the hook stores it and hands it back to `onSuccess(arg)` on
 *    reauth success, and clears it when the dialog is dismissed. This replaces
 *    the hand-written `reauthTargetId` useState + clear-on-cancel apparatus
 *    each caller used to maintain.
 *  - Single-action callers use the default `T = void`: call
 *    `triggerOnStaleError()` and ignore the arg in `onSuccess`.
 */
export function useInlineReauth<T = void>(
  onSuccess: (retryArg: T) => Promise<void>,
): UseInlineReauthResult<T> {
  const tAuth = useTranslations("Auth");

  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [recentSessionOpen, setRecentSessionOpen] = useState(false);
  // The mutation to replay after reauth. Owned here so callers no longer
  // maintain their own retry-target state + clear-on-cancel plumbing.
  const [retryArg, setRetryArg] = useState<T | undefined>(undefined);

  const triggerOnStaleError = async (arg: T) => {
    setReauthError(null);
    setRetryArg(arg);
    if (await canUsePasskeyRecovery()) {
      setReauthOpen(true);
    } else {
      setRecentSessionOpen(true);
    }
  };

  const handleReauthenticate = async () => {
    setReauthenticating(true);
    setReauthError(null);
    try {
      const result = await reauthenticateWithPasskey();
      if (!result.ok) {
        setReauthError(
          result.error === "AUTHENTICATION_CANCELLED"
            ? tAuth("reauthCancelled")
            : tAuth("reauthFailed"),
        );
        return;
      }
      setReauthOpen(false);
      // `retryArg` is set by `triggerOnStaleError(arg)` before this dialog can
      // open, so it holds a `T` on every path that reaches here; the stored
      // `undefined` only exists pre-trigger and after dismissal (which never
      // calls onSuccess). For the `T = void` default the cast is a no-op.
      const arg = retryArg as T;
      setRetryArg(undefined);
      await onSuccess(arg);
    } finally {
      setReauthenticating(false);
    }
  };

  // Clearing retryArg on dismissal mirrors the per-caller clear-on-cancel
  // behaviour that previously lived in each component's dialog onOpenChange.
  const handleReauthOpenChange = (open: boolean) => {
    setReauthOpen(open);
    if (!open) setRetryArg(undefined);
  };
  const handleRecentSessionOpenChange = (open: boolean) => {
    setRecentSessionOpen(open);
    if (!open) setRetryArg(undefined);
  };

  return {
    reauthDialogProps: {
      open: reauthOpen,
      onOpenChange: handleReauthOpenChange,
      title: tAuth("reauthTitle"),
      description: tAuth("reauthDescription"),
      actionLabel: tAuth("reauthAction"),
      errorMessage: reauthError,
      isReauthenticating: reauthenticating,
      onAction: handleReauthenticate,
    },
    recentSessionDialogProps: {
      open: recentSessionOpen,
      onOpenChange: handleRecentSessionOpenChange,
      title: tAuth("recentSessionTitle"),
      description: tAuth("recentSessionDescription"),
      actionLabel: tAuth("recentSessionAction"),
    },
    triggerOnStaleError,
  };
}
