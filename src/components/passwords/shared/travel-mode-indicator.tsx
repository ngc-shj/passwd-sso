"use client";

import { useTranslations } from "next-intl";
import { Plane } from "lucide-react";

interface TravelModeIndicatorProps {
  active: boolean;
}

export function TravelModeIndicator({ active }: TravelModeIndicatorProps) {
  const t = useTranslations("TravelMode");

  if (!active) return null;

  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <Plane className="h-4 w-4 shrink-0" />
      <span>{t("enabled")}</span>
    </div>
  );
}
