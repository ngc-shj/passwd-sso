"use client";

import { useTranslations } from "next-intl";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "../copy-button";
import { useRevealTimeout } from "@/hooks/use-reveal-timeout";
import type { RequireVerificationFn } from "@/hooks/use-reveal-timeout";
import { formatCardNumber } from "@/lib/credit-card";
import type { InlineDetailData } from "@/types/entry";
import type { CreateGuardedGetterFn } from "./types";

interface SectionProps {
  data: InlineDetailData;
  requireVerification: RequireVerificationFn;
  createGuardedGetter: CreateGuardedGetterFn;
}

export function CreditCardSection({ data, requireVerification, createGuardedGetter }: SectionProps) {
  const t = useTranslations("PasswordDetail");

  const { revealed: showCardNumber, handleReveal: handleRevealCardNumber, hide: hideCardNumber } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  const { revealed: showCvv, handleReveal: handleRevealCvv, hide: hideCvv } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {/* Card Number */}
      {data.cardNumber && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("cardNumber")}</label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">
              {showCardNumber
                ? formatCardNumber(data.cardNumber, data.brand)
                : "•••• •••• •••• " + (data.cardNumber.slice(-4) || "••••")}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={showCardNumber ? hideCardNumber : handleRevealCardNumber}
            >
              {showCardNumber ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <CopyButton
              getValue={createGuardedGetter(
                data.id,
                data.requireReprompt ?? false,
                () => data.cardNumber ?? "",
              )}
            />
          </div>
          {showCardNumber && (
            <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
          )}
        </div>
      )}

      {/* Cardholder Name */}
      {data.cardholderName && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("cardholderName")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.cardholderName}</span>
            <CopyButton getValue={() => data.cardholderName ?? ""} />
          </div>
        </div>
      )}

      {/* Brand */}
      {data.brand && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("brand")}</label>
          <p className="text-sm">{data.brand}</p>
        </div>
      )}

      {/* Expiry */}
      {(data.expiryMonth || data.expiryYear) && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("expiry")}</label>
          <p className="text-sm">
            {data.expiryMonth ?? "--"}/{data.expiryYear ?? "----"}
          </p>
        </div>
      )}

      {/* CVV */}
      {data.cvv && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("cvv")}</label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">
              {showCvv ? data.cvv : "•••"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={showCvv ? hideCvv : handleRevealCvv}
            >
              {showCvv ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <CopyButton
              getValue={createGuardedGetter(
                data.id,
                data.requireReprompt ?? false,
                () => data.cvv ?? "",
              )}
            />
          </div>
          {showCvv && (
            <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
          )}
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
