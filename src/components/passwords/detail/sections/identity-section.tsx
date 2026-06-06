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

  // A residential address is classified sensitive (SENSITIVE_FIELDS.IDENTITY → address/
  // addressLine1/addressLine2/postalCode), so the street/postal fields are masked here
  // the same way the ID number is — consistent with link-sharing's HIDE_PASSWORD and
  // with every other entry-type's detail section. One shared reveal toggles them together.
  const { revealed: showAddress, handleReveal: handleRevealAddress, hide: hideAddress } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  const textRow = (label: string, value: string | null | undefined) =>
    value ? (
      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">{label}</label>
        <div className="flex items-center gap-2">
          <span className="text-sm">{value}</span>
          <CopyButton getValue={() => value} />
        </div>
      </div>
    ) : null;

  // Masked variant for sensitive address/postal fields (dots + reveal + guarded copy).
  const maskedRow = (label: string, value: string | null | undefined, colSpan = false) =>
    value ? (
      <div className={colSpan ? "col-span-2 space-y-1" : "space-y-1"}>
        <label className="text-sm text-muted-foreground">{label}</label>
        <div className="flex items-center gap-2">
          <span className="text-sm whitespace-pre-wrap">{showAddress ? value : "••••••••"}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={showAddress ? hideAddress : handleRevealAddress}
            aria-label={showAddress ? t("hide") : t("reveal")}
          >
            {showAddress ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <CopyButton
            getValue={createGuardedGetter(data.id, data.requireReprompt ?? false, () => value)}
          />
        </div>
      </div>
    ) : null;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {/* Structured name */}
      {textRow(t("familyName"), data.familyName)}
      {textRow(t("givenName"), data.givenName)}
      {textRow(t("middleName"), data.middleName)}
      {textRow(t("familyNameKana"), data.familyNameKana)}
      {textRow(t("givenNameKana"), data.givenNameKana)}

      {/* Full Name (legacy / combined) */}
      {data.fullName && (
        <div className="col-span-2 space-y-1">
          <label className="text-sm text-muted-foreground">{t("fullName")}</label>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.fullName}</span>
            <CopyButton getValue={() => data.fullName ?? ""} />
          </div>
        </div>
      )}

      {/* Structured address — street/postal fields are sensitive (masked), city/state/
          country are not (plaintext). */}
      {maskedRow(t("addressLine1"), data.addressLine1)}
      {maskedRow(t("addressLine2"), data.addressLine2)}
      {textRow(t("city"), data.city)}
      {textRow(t("state"), data.state)}
      {maskedRow(t("postalCode"), data.postalCode)}
      {textRow(t("country"), data.country)}

      {/* Address (legacy / combined) — sensitive, masked. */}
      {maskedRow(t("address"), data.address, true)}

      {/* Auto-hide hint shown once while any masked address field is revealed. */}
      {showAddress && (data.addressLine1 || data.addressLine2 || data.postalCode || data.address) && (
        <p className="col-span-2 text-xs text-muted-foreground">{t("autoHide")}</p>
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
