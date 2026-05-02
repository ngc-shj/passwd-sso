"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

type SectionKey = "account" | "auth" | "devices" | "vault" | "sharing" | "developer";

interface MovedPageNoticeProps {
  section: SectionKey;
  destinationPath: string;
}

function storageKey(destinationPath: string): string {
  return `psso:settings-ia-moved-notice:${destinationPath}`;
}

function readDismissed(destinationPath: string): boolean {
  try {
    return sessionStorage.getItem(storageKey(destinationPath)) !== null;
  } catch {
    return false;
  }
}

function recordDismissed(destinationPath: string): void {
  try {
    sessionStorage.setItem(storageKey(destinationPath), "1");
  } catch {
    // Ignore storage errors
  }
}

export function MovedPageNotice({ section, destinationPath }: MovedPageNoticeProps) {
  const tMigration = useTranslations("Migration");
  const tSettings = useTranslations("Settings");
  // Lazy initializer reads sessionStorage once on mount
  const [dismissed, setDismissed] = useState(() => readDismissed(destinationPath));

  // On unmount (route change away) → record dismissal so navigating back does not re-show
  useEffect(() => {
    return () => {
      recordDismissed(destinationPath);
    };
  }, [destinationPath]);

  if (dismissed) return null;

  function handleDismiss() {
    recordDismissed(destinationPath);
    setDismissed(true);
  }

  const sectionLabel = tSettings(`section.${section}`);

  return (
    <div className="mx-4 mt-4 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-700 dark:bg-amber-950 md:mx-6 md:mt-6">
      <p className="flex-1 text-amber-800 dark:text-amber-200">
        <span className="font-semibold">{tMigration("movedNotice.title")}</span>
        {" "}
        {tMigration("movedNotice.body", { section: sectionLabel })}
      </p>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDismiss}
      >
        {tMigration("movedNotice.dismiss")}
      </Button>
    </div>
  );
}
