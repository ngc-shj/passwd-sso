"use client";

import { useLocale, useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface AutoMonitorToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  lastCheckAt: number | null;
}

function formatRelativeTime(timestamp: number, locale: string): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);

  if (locale === "ja") {
    if (minutes < 1) return "たった今";
    if (minutes < 60) return `${minutes}分前`;
    if (hours < 24) return `${hours}時間前`;
    return `${Math.floor(hours / 24)}日前`;
  }
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function AutoMonitorToggle({
  enabled,
  onToggle,
  lastCheckAt,
}: AutoMonitorToggleProps) {
  const t = useTranslations("Watchtower");
  const locale = useLocale();

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
      <div className="space-y-0.5">
        <Label htmlFor="auto-monitor" className="text-sm font-medium">
          {t("autoMonitorLabel")}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t("autoMonitorDescription")}
        </p>
        {lastCheckAt && (
          <p className="text-xs text-muted-foreground">
            {t("lastAutoCheck", {
              time: formatRelativeTime(lastCheckAt, locale),
            })}
          </p>
        )}
      </div>
      <Switch
        id="auto-monitor"
        checked={enabled}
        onCheckedChange={onToggle}
      />
    </div>
  );
}
