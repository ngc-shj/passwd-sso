"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  void error;
  const t = useTranslations("Error");
  const tc = useTranslations("Common");

  return (
    <div className="flex flex-col items-center justify-center py-12 gap-4">
      <AlertTriangle className="h-10 w-10 text-destructive" />
      <p className="text-muted-foreground">{t("somethingWentWrong")}</p>
      <Button onClick={reset}>{tc("tryAgain")}</Button>
    </div>
  );
}
