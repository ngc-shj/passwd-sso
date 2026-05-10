"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel: string;
  cancelLabel: string;
  errorMessage?: string | null;
  isReauthenticating: boolean;
  onAction: () => void | Promise<void>;
}

/**
 * Inline passkey reauthentication prompt used by sensitive credential-issuance
 * cards (operator tokens, API keys, MCP clients, SCIM tokens, service-account
 * tokens, access-request approve). Issuing the passkey ceremony stays at the
 * call site so each card can retry its own mutation after success.
 */
export function PasskeyReauthDialog({
  open,
  onOpenChange,
  title,
  description,
  actionLabel,
  cancelLabel,
  errorMessage,
  isReauthenticating,
  onAction,
}: Props) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {errorMessage && (
          <p className="text-sm text-destructive">{errorMessage}</p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isReauthenticating}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void onAction();
            }}
            disabled={isReauthenticating}
          >
            {isReauthenticating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              actionLabel
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
