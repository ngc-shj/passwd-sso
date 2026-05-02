"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { fetchApi } from "@/lib/url-helpers";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { BANNER_DISMISS_KEY, BANNER_SUNSET_TS } from "./migration-banner-config";

function isSunset(): boolean {
  return Date.now() > BANNER_SUNSET_TS.getTime();
}

function isDismissedInStorage(): boolean {
  try {
    return localStorage.getItem(BANNER_DISMISS_KEY) !== null;
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    localStorage.setItem(BANNER_DISMISS_KEY, String(Date.now()));
  } catch {
    // Ignore storage errors (private mode, quota exceeded, etc.)
  }
}

export function MigrationBanner() {
  const t = useTranslations("Migration");
  const [dismissed, setDismissed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const visible = !dismissed && !isSunset() && !isDismissedInStorage();

  if (!visible) return null;

  async function handleDismiss() {
    // Optimistic UI: hide the banner immediately so the user gets feedback.
    // localStorage is written ONLY after the audit-emit fetch completes —
    // a transient failure leaves the banner re-showable on the next session
    // (retry-on-next-session contract, see plan §"Banner dismiss handler").
    setDismissed(true);

    try {
      const res = await fetchApi("/api/internal/audit-emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: AUDIT_ACTION.SETTINGS_IA_MIGRATION_V1_SEEN,
          scope: AUDIT_SCOPE.PERSONAL,
        }),
      });
      if (res.ok) {
        persistDismissed();
      } else {
        // Retry-eligible 4xx/5xx: surface to user; do not persist so banner
        // re-shows on next session for another attempt.
        toast.error(t("banner.dismissError"));
      }
    } catch (err: unknown) {
      // Network error: silent; banner re-appears next session.
      console.warn("[MigrationBanner] audit-emit failed:", err);
    }
  }

  return (
    <>
      <div className="mx-4 mt-4 flex items-start gap-3 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm dark:border-blue-700 dark:bg-blue-950 md:mx-6 md:mt-6">
        <p className="flex-1 text-blue-800 dark:text-blue-200">
          <span className="font-semibold">{t("banner.title")}</span>
          {" "}
          {t("banner.body")}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setModalOpen(true)}
        >
          {t("banner.details")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleDismiss()}
        >
          {t("banner.dismiss")}
        </Button>
      </div>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("banner.modal.title")}</DialogTitle>
            <DialogDescription>{t("banner.modal.description")}</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>{t("banner.modal.items.auth")}</li>
            <li>{t("banner.modal.items.devices")}</li>
            <li>{t("banner.modal.items.vault")}</li>
            <li>{t("banner.modal.items.sharing")}</li>
            <li>{t("banner.modal.items.developer")}</li>
            <li>{t("banner.modal.items.lock")}</li>
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
