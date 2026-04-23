"use client";

import { useTranslations, useLocale } from "next-intl";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "../../shared/copy-button";
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

export function IdentitySection({ data, requireVerification, createGuardedGetter }: SectionProps) {
  const t = useTranslations("PasswordDetail");
  const locale = useLocale();

  const { revealed: showIdNumber, handleReveal: handleRevealIdNumber, hide: hideIdNumber } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {/* Full Name */}
      {data.fullName && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("fullName")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.fullName}</span>
            <CopyButton getValue={() => data.fullName ?? ""} />
          </div>
        </div>
      )}

      {/* Address */}
      {data.address && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("address")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm whitespace-pre-wrap">{data.address}</span>
            <CopyButton getValue={() => data.address ?? ""} />
          </div>
        </div>
      )}

      {/* Phone */}
      {data.phone && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("phone")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.phone}</span>
            <CopyButton getValue={() => data.phone ?? ""} />
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

      {/* Date of Birth */}
      {data.dateOfBirth && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("dateOfBirth")}</label>
          <p className="text-sm">{formatDate(data.dateOfBirth, locale)}</p>
        </div>
      )}

      {/* Nationality */}
      {data.nationality && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("nationality")}</label>
          <p className="text-sm">{data.nationality}</p>
        </div>
      )}

      {/* ID Number */}
      {data.idNumber && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("idNumber")}</label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">
              {showIdNumber ? data.idNumber : "••••••••"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={showIdNumber ? hideIdNumber : handleRevealIdNumber}
            >
              {showIdNumber ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <CopyButton
              getValue={createGuardedGetter(
                data.id,
                data.requireReprompt ?? false,
                () => data.idNumber ?? "",
              )}
            />
          </div>
          {showIdNumber && (
            <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
          )}
        </div>
      )}

      {/* Issue Date */}
      {data.issueDate && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("issueDate")}</label>
          <p className="text-sm">{formatDate(data.issueDate, locale)}</p>
        </div>
      )}

      {/* Expiry Date */}
      {data.expiryDate && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("expiryDate")}</label>
          <p className="text-sm">{formatDate(data.expiryDate, locale)}</p>
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
