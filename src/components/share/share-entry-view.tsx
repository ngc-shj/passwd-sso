"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/passwords/copy-button";
import {
  Eye,
  EyeOff,
  Clock,
  Shield,
  KeyRound,
  StickyNote,
  CreditCard,
  UserSquare,
  Fingerprint,
} from "lucide-react";

const REVEAL_TIMEOUT = 30_000;

const ENTRY_TYPE_ICONS: Record<string, React.ReactNode> = {
  LOGIN: <KeyRound className="h-5 w-5" />,
  SECURE_NOTE: <StickyNote className="h-5 w-5" />,
  CREDIT_CARD: <CreditCard className="h-5 w-5" />,
  IDENTITY: <UserSquare className="h-5 w-5" />,
  PASSKEY: <Fingerprint className="h-5 w-5" />,
};

interface ShareEntryViewProps {
  data: Record<string, unknown>;
  entryType: string;
  expiresAt: string;
  viewCount: number;
  maxViews: number | null;
}

export function ShareEntryView({
  data,
  entryType,
  expiresAt,
  viewCount,
  maxViews,
}: ShareEntryViewProps) {
  const t = useTranslations("Share");
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());

  // Auto-hide revealed fields after timeout
  useEffect(() => {
    if (revealedFields.size === 0) return;
    const timer = setTimeout(() => setRevealedFields(new Set()), REVEAL_TIMEOUT);
    return () => clearTimeout(timer);
  }, [revealedFields]);

  const toggleReveal = useCallback((field: string) => {
    setRevealedFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
      }
      return next;
    });
  }, []);

  const renderField = (label: string, value: unknown, key?: string) => {
    if (!value) return null;
    const strVal = String(value);
    return (
      <div className="space-y-1" key={key}>
        <label className="text-sm text-muted-foreground">{label}</label>
        <div className="flex items-center gap-2">
          <span className="text-sm break-all">{strVal}</span>
          <CopyButton getValue={() => strVal} />
        </div>
      </div>
    );
  };

  const renderSensitiveField = (
    label: string,
    value: unknown,
    fieldKey: string
  ) => {
    if (!value) return null;
    const strVal = String(value);
    const isShown = revealedFields.has(fieldKey);
    return (
      <div className="space-y-1" key={fieldKey}>
        <label className="text-sm text-muted-foreground">{label}</label>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">
            {isShown ? strVal : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => toggleReveal(fieldKey)}
          >
            {isShown ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
          <CopyButton getValue={() => strVal} />
        </div>
      </div>
    );
  };

  const renderNotes = (value: unknown) => {
    if (!value) return null;
    return (
      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">{t("notes")}</label>
        <div className="rounded-md bg-muted p-3">
          <p className="text-sm whitespace-pre-wrap break-words">
            {String(value)}
          </p>
        </div>
      </div>
    );
  };

  const renderCustomFields = () => {
    const fields = data.customFields as
      | { label: string; value: string; type: string }[]
      | undefined;
    if (!fields?.length) return null;
    return (
      <>
        {fields.map((f, i) => {
          if (f.type === "hidden") {
            return renderSensitiveField(f.label, f.value, `custom_${i}`);
          }
          if (f.type === "url" && f.value) {
            return (
              <div className="space-y-1" key={`custom_${i}`}>
                <label className="text-sm text-muted-foreground">
                  {f.label}
                </label>
                <div className="flex items-center gap-2">
                  <a
                    href={f.value}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-500 hover:underline break-all"
                  >
                    {f.value}
                  </a>
                  <CopyButton getValue={() => f.value} />
                </div>
              </div>
            );
          }
          return renderField(f.label, f.value, `custom_${i}`);
        })}
      </>
    );
  };

  const renderLoginFields = () => (
    <>
      {renderField(t("username"), data.username)}
      {renderSensitiveField(t("password"), data.password, "password")}
      {data.url && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("url")}</label>
          <div className="flex items-center gap-2">
            <a
              href={String(data.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-500 hover:underline break-all"
            >
              {String(data.url)}
            </a>
            <CopyButton getValue={() => String(data.url)} />
          </div>
        </div>
      )}
      {renderNotes(data.notes)}
      {renderCustomFields()}
    </>
  );

  const renderSecureNoteFields = () => (
    <>
      {data.content && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">
            {t("content")}
          </label>
          <div className="rounded-md bg-muted p-3">
            <p className="text-sm whitespace-pre-wrap break-words">
              {String(data.content)}
            </p>
          </div>
        </div>
      )}
    </>
  );

  const renderCreditCardFields = () => (
    <>
      {renderField(t("cardholderName"), data.cardholderName)}
      {renderSensitiveField(t("cardNumber"), data.cardNumber, "cardNumber")}
      {renderField(t("brand"), data.brand)}
      {(data.expiryMonth || data.expiryYear) &&
        renderField(
          t("expiry"),
          `${data.expiryMonth || "??"}/${data.expiryYear || "????"}`
        )}
      {renderSensitiveField(t("cvv"), data.cvv, "cvv")}
      {renderNotes(data.notes)}
    </>
  );

  const renderIdentityFields = () => (
    <>
      {renderField(t("fullName"), data.fullName)}
      {renderField(t("address"), data.address)}
      {renderField(t("phone"), data.phone)}
      {renderField(t("email"), data.email)}
      {renderField(t("dateOfBirth"), data.dateOfBirth)}
      {renderField(t("nationality"), data.nationality)}
      {renderSensitiveField(t("idNumber"), data.idNumber, "idNumber")}
      {renderField(t("issueDate"), data.issueDate)}
      {renderField(t("expiryDate"), data.expiryDate)}
      {renderNotes(data.notes)}
    </>
  );

  const renderPasskeyFields = () => (
    <>
      {renderField(t("relyingPartyId"), data.relyingPartyId)}
      {renderField(t("relyingPartyName"), data.relyingPartyName)}
      {renderField(t("username"), data.username)}
      {renderSensitiveField(t("credentialId"), data.credentialId, "credentialId")}
      {renderField(t("creationDate"), data.creationDate)}
      {renderField(t("deviceInfo"), data.deviceInfo)}
      {renderNotes(data.notes)}
    </>
  );

  const renderFields = () => {
    switch (entryType) {
      case "SECURE_NOTE":
        return renderSecureNoteFields();
      case "CREDIT_CARD":
        return renderCreditCardFields();
      case "IDENTITY":
        return renderIdentityFields();
      case "PASSKEY":
        return renderPasskeyFields();
      default:
        return renderLoginFields();
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="max-w-lg w-full p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="text-muted-foreground">
            {ENTRY_TYPE_ICONS[entryType] ?? ENTRY_TYPE_ICONS.LOGIN}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold truncate">
              {String(data.title || t("sharedEntry"))}
            </h1>
          </div>
          <Shield className="h-5 w-5 text-muted-foreground" />
        </div>

        {/* Fields */}
        <div className="space-y-4">{renderFields()}</div>

        {/* Footer metadata */}
        <div className="border-t pt-3 space-y-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <span>
              {t("expiresAt", {
                date: new Date(expiresAt).toLocaleString(),
              })}
            </span>
          </div>
          {maxViews && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />
              <span>
                {t("viewCount", { current: viewCount, max: maxViews })}
              </span>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
