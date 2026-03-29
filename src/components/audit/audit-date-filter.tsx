"use client";

import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AuditDateFilterProps {
  dateFrom: string;
  dateTo: string;
  setDateFrom: (v: string) => void;
  setDateTo: (v: string) => void;
}

export function AuditDateFilter({
  dateFrom,
  dateTo,
  setDateFrom,
  setDateTo,
}: AuditDateFilterProps) {
  const t = useTranslations("AuditLog");

  return (
    <>
      <div className="space-y-1">
        <Label className="text-xs">{t("dateFrom")}</Label>
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="w-[160px]"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("dateTo")}</Label>
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="w-[160px]"
        />
      </div>
    </>
  );
}
