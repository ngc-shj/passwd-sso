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

interface UseInlineReauthResult {
  /** Spread into <PasskeyReauthDialog>. cancelLabel must still be provided by the caller (its source namespace varies). */
  reauthDialogProps: InlineReauthDialogProps;
  /** Spread into <RecentSessionRequiredDialog>. cancelLabel must still be provided by the caller. */
  recentSessionDialogProps: InlineRecentSessionDialogProps;
  /** Call this from the SESSION_STEP_UP_REQUIRED branch of the API error handler. */
  triggerOnStaleError: () => Promise<void>;
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
 */
export function useInlineReauth(
  onSuccess: () => Promise<void>,
): UseInlineReauthResult {
  const tAuth = useTranslations("Auth");

  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [recentSessionOpen, setRecentSessionOpen] = useState(false);

  const triggerOnStaleError = async () => {
    setReauthError(null);
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
      await onSuccess();
    } finally {
      setReauthenticating(false);
    }
  };

  return {
    reauthDialogProps: {
      open: reauthOpen,
      onOpenChange: setReauthOpen,
      title: tAuth("reauthTitle"),
      description: tAuth("reauthDescription"),
      actionLabel: tAuth("reauthAction"),
      errorMessage: reauthError,
      isReauthenticating: reauthenticating,
      onAction: handleReauthenticate,
    },
    recentSessionDialogProps: {
      open: recentSessionOpen,
      onOpenChange: setRecentSessionOpen,
      title: tAuth("recentSessionTitle"),
      description: tAuth("recentSessionDescription"),
      actionLabel: tAuth("recentSessionAction"),
    },
    triggerOnStaleError,
  };
}
