"use client";

import { useTranslations, useLocale } from "next-intl";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "../copy-button";
import { useRevealTimeout } from "@/hooks/use-reveal-timeout";
import type { RequireVerificationFn } from "@/hooks/use-reveal-timeout";
import { formatDate } from "@/lib/format-datetime";
import type { InlineDetailData } from "@/types/entry";
import type { CreateGuardedGetterFn } from "./types";

interface SectionProps {
  data: InlineDetailData;
  requireVerification: RequireVerificationFn;
  createGuardedGetter: CreateGuardedGetterFn;
}

export function PasskeySection({ data, requireVerification, createGuardedGetter }: SectionProps) {
  const t = useTranslations("PasswordDetail");
  const locale = useLocale();

  const { revealed: showCredentialId, handleReveal: handleRevealCredentialId, hide: hideCredentialId } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {/* Relying Party ID */}
      {data.relyingPartyId && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("relyingPartyId")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.relyingPartyId}</span>
            <CopyButton getValue={() => data.relyingPartyId ?? ""} />
          </div>
        </div>
      )}

      {/* Relying Party Name */}
      {data.relyingPartyName && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("relyingPartyName")}</label>
          <p className="text-sm">{data.relyingPartyName}</p>
        </div>
      )}

      {/* Username */}
      {data.username && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("username")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.username}</span>
            <CopyButton getValue={() => data.username ?? ""} />
          </div>
        </div>
      )}

      {/* Credential ID */}
      {data.credentialId && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("credentialId")}</label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm break-all">
              {showCredentialId ? data.credentialId : "••••••••"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={showCredentialId ? hideCredentialId : handleRevealCredentialId}
            >
              {showCredentialId ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <CopyButton
              getValue={createGuardedGetter(
                data.id,
                data.requireReprompt ?? false,
                () => data.credentialId ?? "",
              )}
            />
          </div>
          {showCredentialId && (
            <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
          )}
        </div>
      )}

      {/* Creation Date */}
      {data.creationDate && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("creationDate")}</label>
          <p className="text-sm">{formatDate(data.creationDate, locale)}</p>
        </div>
      )}

      {/* Device Info */}
      {data.deviceInfo && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("deviceInfo")}</label>
          <p className="text-sm">{data.deviceInfo}</p>
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
