"use client";

import { useTranslations } from "next-intl";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "../../copy-button";
import { useRevealTimeout } from "@/hooks/vault/use-reveal-timeout";
import type { RequireVerificationFn } from "@/hooks/vault/use-reveal-timeout";
import type { InlineDetailData } from "@/types/entry";
import type { CreateGuardedGetterFn } from "./types";

interface SectionProps {
  data: InlineDetailData;
  requireVerification: RequireVerificationFn;
  createGuardedGetter: CreateGuardedGetterFn;
}

export function BankAccountSection({ data, requireVerification, createGuardedGetter }: SectionProps) {
  const t = useTranslations("PasswordDetail");

  const { revealed: showAccountNumber, handleReveal: handleRevealAccountNumber, hide: hideAccountNumber } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  const { revealed: showRoutingNumber, handleReveal: handleRevealRoutingNumber, hide: hideRoutingNumber } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  const { revealed: showIban, handleReveal: handleRevealIban, hide: hideIban } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {/* Bank Name */}
      {data.bankName && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("bankName")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.bankName}</span>
            <CopyButton getValue={() => data.bankName ?? ""} />
          </div>
        </div>
      )}

      {/* Account Holder Name */}
      {data.accountHolderName && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("accountHolderName")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.accountHolderName}</span>
            <CopyButton getValue={() => data.accountHolderName ?? ""} />
          </div>
        </div>
      )}

      {/* Account Type */}
      {data.accountType && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("accountType")}</label>
          <p className="text-sm">
            {data.accountType === "checking" ? t("accountTypeChecking")
              : data.accountType === "savings" ? t("accountTypeSavings")
              : data.accountType === "other" ? t("accountTypeOther")
              : data.accountType}
          </p>
        </div>
      )}

      {/* Account Number */}
      {data.accountNumber && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("accountNumber")}</label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">
              {showAccountNumber ? data.accountNumber : "••••••••"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={showAccountNumber ? hideAccountNumber : handleRevealAccountNumber}
            >
              {showAccountNumber ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <CopyButton
              getValue={createGuardedGetter(
                data.id,
                data.requireReprompt ?? false,
                () => data.accountNumber ?? "",
              )}
            />
          </div>
          {showAccountNumber && (
            <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
          )}
        </div>
      )}

      {/* Routing Number */}
      {data.routingNumber && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("routingNumber")}</label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">
              {showRoutingNumber ? data.routingNumber : "••••••••"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={showRoutingNumber ? hideRoutingNumber : handleRevealRoutingNumber}
            >
              {showRoutingNumber ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <CopyButton
              getValue={createGuardedGetter(
                data.id,
                data.requireReprompt ?? false,
                () => data.routingNumber ?? "",
              )}
            />
          </div>
          {showRoutingNumber && (
            <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
          )}
        </div>
      )}

      {/* SWIFT / BIC */}
      {data.swiftBic && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("swiftBic")}</label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{data.swiftBic}</span>
            <CopyButton getValue={() => data.swiftBic ?? ""} />
          </div>
        </div>
      )}

      {/* IBAN */}
      {data.iban && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("iban")}</label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">
              {showIban ? data.iban : "••••••••"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={showIban ? hideIban : handleRevealIban}
            >
              {showIban ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <CopyButton
              getValue={createGuardedGetter(
                data.id,
                data.requireReprompt ?? false,
                () => data.iban ?? "",
              )}
            />
          </div>
          {showIban && (
            <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
          )}
        </div>
      )}

      {/* Branch Name */}
      {data.branchName && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("branchName")}</label>
          <p className="text-sm">{data.branchName}</p>
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
