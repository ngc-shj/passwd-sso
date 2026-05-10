"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useLocale } from "next-intl";
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
import { withBasePath } from "@/lib/url-helpers";

type RecentSessionRequiredDialogProps = {
  actionLabel: string;
  cancelLabel: string;
  description: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
};

export function RecentSessionRequiredDialog({
  actionLabel,
  cancelLabel,
  description,
  onOpenChange,
  open,
  title,
}: RecentSessionRequiredDialogProps) {
  const locale = useLocale();
  const [redirecting, setRedirecting] = useState(false);

  const handleSignInAgain = async () => {
    setRedirecting(true);
    const currentPath =
      typeof window === "undefined"
        ? "/"
        : `${window.location.pathname}${window.location.search}`;
    const signInPath = `${withBasePath(`/${locale}/auth/signin`)}?callbackUrl=${encodeURIComponent(currentPath)}`;
    await signOut({ callbackUrl: signInPath });
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={redirecting}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction onClick={handleSignInAgain} disabled={redirecting}>
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
