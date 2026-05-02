"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { fetchApi } from "@/lib/url-helpers";
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

export function MigrationBanner() {
  const t = useTranslations("Migration");
  const [dismissed, setDismissed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const visible = !dismissed && !isSunset() && !isDismissedInStorage();

  if (!visible) return null;

  function handleDismiss() {
    try {
      localStorage.setItem(BANNER_DISMISS_KEY, String(Date.now()));
    } catch {
      // Ignore storage errors
    }
    setDismissed(true);

    void fetchApi("/api/internal/audit-emit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        action: "SETTINGS_IA_MIGRATION_V1_SEEN",
        scope: "PERSONAL",
      }),
    }).catch((err: unknown) => {
      console.warn("[MigrationBanner] audit-emit failed:", err);
    });
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
          onClick={handleDismiss}
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
