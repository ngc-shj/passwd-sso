"use client";

import { useTranslations, useLocale } from "next-intl";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "../copy-button";
import { useRevealTimeout } from "@/hooks/vault/use-reveal-timeout";
import type { RequireVerificationFn } from "@/hooks/vault/use-reveal-timeout";
import { formatDate } from "@/lib/format/format-datetime";
import type { InlineDetailData } from "@/types/entry";
import type { CreateGuardedGetterFn } from "./types";

interface SectionProps {
  data: InlineDetailData;
  requireVerification: RequireVerificationFn;
  createGuardedGetter: CreateGuardedGetterFn;
}

export function SoftwareLicenseSection({ data, requireVerification, createGuardedGetter }: SectionProps) {
  const t = useTranslations("PasswordDetail");
  const locale = useLocale();

  const { revealed: showLicenseKey, handleReveal: handleRevealLicenseKey, hide: hideLicenseKey } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {/* Software Name */}
      {data.softwareName && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("softwareName")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.softwareName}</span>
            <CopyButton getValue={() => data.softwareName ?? ""} />
          </div>
        </div>
      )}

      {/* License Key */}
      {data.licenseKey && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("licenseKey")}</label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm break-all">
              {showLicenseKey ? data.licenseKey : "••••••••"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={showLicenseKey ? hideLicenseKey : handleRevealLicenseKey}
            >
              {showLicenseKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <CopyButton
              getValue={createGuardedGetter(
                data.id,
                data.requireReprompt ?? false,
                () => data.licenseKey ?? "",
              )}
            />
          </div>
          {showLicenseKey && (
            <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
          )}
        </div>
      )}

      {/* Version */}
      {data.version && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("version")}</label>
          <p className="text-sm">{data.version}</p>
        </div>
      )}

      {/* Licensee */}
      {data.licensee && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("licensee")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.licensee}</span>
            <CopyButton getValue={() => data.licensee ?? ""} />
          </div>
        </div>
      )}

      {/* Email */}
      {data.email && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("email")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.email}</span>
            <CopyButton getValue={() => data.email ?? ""} />
          </div>
        </div>
      )}

      {/* Purchase Date */}
      {data.purchaseDate && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("purchaseDate")}</label>
          <p className="text-sm">{formatDate(data.purchaseDate, locale)}</p>
        </div>
      )}

      {/* Expiration Date */}
      {data.expirationDate && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("expirationDate")}</label>
          <p className="text-sm">{formatDate(data.expirationDate, locale)}</p>
        </div>
      )}

      {/* Notes */}
      {data.notes && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("notes")}</label>
          <p className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
            {data.notes}
          </p>
        </div>
      )}
    </div>
  );
}
