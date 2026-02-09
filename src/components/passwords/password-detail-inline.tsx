"use client";

import { useState, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";

import { Button } from "@/components/ui/button";
import { CopyButton } from "./copy-button";
import { Favicon } from "./favicon";
import { TOTPField, type TOTPEntry } from "./totp-field";
import { formatCardNumber } from "@/lib/credit-card";
import {
  Edit,
  Eye,
  EyeOff,
  History,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface PasswordHistoryEntry {
  password: string;
  changedAt: string;
}

type CustomFieldType = "text" | "hidden" | "url";

interface CustomField {
  label: string;
  value: string;
  type: CustomFieldType;
}

export interface InlineDetailData {
  id: string;
  entryType?: "LOGIN" | "SECURE_NOTE" | "CREDIT_CARD" | "IDENTITY";
  password: string;
  content?: string;
  url: string | null;
  urlHost: string | null;
  notes: string | null;
  customFields: CustomField[];
  passwordHistory: PasswordHistoryEntry[];
  totp?: TOTPEntry;
  cardholderName?: string | null;
  cardNumber?: string | null;
  brand?: string | null;
  expiryMonth?: string | null;
  expiryYear?: string | null;
  cvv?: string | null;
  fullName?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  dateOfBirth?: string | null;
  nationality?: string | null;
  idNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PasswordDetailInlineProps {
  data: InlineDetailData;
  onEdit?: () => void;
}

const REVEAL_TIMEOUT = 30_000;

export function PasswordDetailInline({ data, onEdit }: PasswordDetailInlineProps) {
  const t = useTranslations("PasswordDetail");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const [showPassword, setShowPassword] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [revealedHistory, setRevealedHistory] = useState<Set<number>>(
    new Set()
  );
  const [revealedFields, setRevealedFields] = useState<Set<number>>(
    new Set()
  );

  const [showCardNumber, setShowCardNumber] = useState(false);
  const [showCvv, setShowCvv] = useState(false);
  const [showIdNumber, setShowIdNumber] = useState(false);

  const handleReveal = useCallback(() => {
    setShowPassword(true);
    setTimeout(() => setShowPassword(false), REVEAL_TIMEOUT);
  }, []);

  const handleRevealCardNumber = useCallback(() => {
    setShowCardNumber(true);
    setTimeout(() => setShowCardNumber(false), REVEAL_TIMEOUT);
  }, []);

  const handleRevealCvv = useCallback(() => {
    setShowCvv(true);
    setTimeout(() => setShowCvv(false), REVEAL_TIMEOUT);
  }, []);

  const handleRevealIdNumber = useCallback(() => {
    setShowIdNumber(true);
    setTimeout(() => setShowIdNumber(false), REVEAL_TIMEOUT);
  }, []);

  const isNote = data.entryType === "SECURE_NOTE";
  const isCreditCard = data.entryType === "CREDIT_CARD";
  const isIdentity = data.entryType === "IDENTITY";

  return (
    <div className="space-y-4 border-t pt-4 px-4 pb-4">
      {isIdentity ? (
        <>
          {/* Full Name */}
          {data.fullName && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("fullName")}</label>
              <div className="flex items-center gap-2">
                <span className="text-sm">{data.fullName}</span>
                <CopyButton getValue={() => data.fullName ?? ""} />
              </div>
            </div>
          )}

          {/* Address */}
          {data.address && (
            <div className="space-y-1">
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
              <span className="text-sm">{data.dateOfBirth}</span>
            </div>
          )}

          {/* Nationality */}
          {data.nationality && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("nationality")}</label>
              <span className="text-sm">{data.nationality}</span>
            </div>
          )}

          {/* ID Number */}
          {data.idNumber && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("idNumber")}</label>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">
                  {showIdNumber ? data.idNumber : "••••••••"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={showIdNumber ? () => setShowIdNumber(false) : handleRevealIdNumber}
                >
                  {showIdNumber ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <CopyButton getValue={() => data.idNumber ?? ""} />
              </div>
            </div>
          )}

          {/* Issue Date */}
          {data.issueDate && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("issueDate")}</label>
              <span className="text-sm">{data.issueDate}</span>
            </div>
          )}

          {/* Expiry Date */}
          {data.expiryDate && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("expiryDate")}</label>
              <span className="text-sm">{data.expiryDate}</span>
            </div>
          )}

          {/* Notes */}
          {data.notes && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("notes")}</label>
              <p className="text-sm whitespace-pre-wrap rounded-md bg-muted p-3">
                {data.notes}
              </p>
            </div>
          )}
        </>
      ) : isCreditCard ? (
        <>
          {/* Card Number */}
          {data.cardNumber && (
            <div className="space-y-1">
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
                  onClick={showCardNumber ? () => setShowCardNumber(false) : handleRevealCardNumber}
                >
                  {showCardNumber ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <CopyButton getValue={() => data.cardNumber ?? ""} />
              </div>
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
              <span className="text-sm">{data.brand}</span>
            </div>
          )}

          {/* Expiry */}
          {(data.expiryMonth || data.expiryYear) && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("expiry")}</label>
              <span className="text-sm">
                {data.expiryMonth ?? "--"}/{data.expiryYear ?? "----"}
              </span>
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
                  onClick={showCvv ? () => setShowCvv(false) : handleRevealCvv}
                >
                  {showCvv ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <CopyButton getValue={() => data.cvv ?? ""} />
              </div>
            </div>
          )}

          {/* Notes */}
          {data.notes && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("notes")}</label>
              <p className="text-sm whitespace-pre-wrap rounded-md bg-muted p-3">
                {data.notes}
              </p>
            </div>
          )}
        </>
      ) : isNote ? (
        /* Secure Note Content */
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("content")}</label>
          <div className="flex items-start gap-2">
            <p className="flex-1 text-sm whitespace-pre-wrap font-mono rounded-md bg-muted p-3 max-h-96 overflow-y-auto">
              {data.content}
            </p>
            <CopyButton getValue={() => data.content ?? ""} />
          </div>
        </div>
      ) : (
        <>
          {/* Password */}
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">{t("password")}</label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm">
                {showPassword ? data.password : "••••••••••••"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={showPassword ? () => setShowPassword(false) : handleReveal}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
              <CopyButton getValue={() => data.password} />
            </div>
            {showPassword && (
              <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
            )}
          </div>

          {/* TOTP */}
          {data.totp && <TOTPField mode="display" totp={data.totp} />}

          {/* URL */}
          {data.url && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground flex items-center gap-1">
                <Favicon host={data.urlHost} size={12} className="shrink-0" /> {t("url")}
              </label>
              <div className="flex items-center gap-2">
                <a
                  href={data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline"
                >
                  {data.url}
                </a>
                <CopyButton getValue={() => data.url!} />
              </div>
            </div>
          )}

          {/* Notes */}
          {data.notes && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("notes")}</label>
              <p className="text-sm whitespace-pre-wrap rounded-md bg-muted p-3">
                {data.notes}
              </p>
            </div>
          )}

          {/* Custom Fields */}
          {data.customFields.length > 0 &&
            data.customFields.map((field, idx) => (
              <div key={idx} className="space-y-1">
                <label className="text-sm text-muted-foreground">
                  {field.label}
                </label>
                <div className="flex items-center gap-2">
                  {field.type === "url" ? (
                    <a
                      href={field.value}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-600 hover:underline"
                    >
                      {field.value}
                    </a>
                  ) : field.type === "hidden" ? (
                    <>
                      <span className="font-mono text-sm">
                        {revealedFields.has(idx) ? field.value : "••••••••••••"}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() =>
                          setRevealedFields((prev) => {
                            const next = new Set(prev);
                            if (next.has(idx)) next.delete(idx);
                            else next.add(idx);
                            return next;
                          })
                        }
                      >
                        {revealedFields.has(idx) ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </>
                  ) : (
                    <span className="text-sm">{field.value}</span>
                  )}
                  <CopyButton getValue={() => field.value} />
                </div>
              </div>
            ))}

          {/* Password History */}
          {data.passwordHistory.length > 0 && (
            <div className="space-y-1">
              <button
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setHistoryExpanded(!historyExpanded)}
              >
                {historyExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <History className="h-3 w-3" />
                {t("passwordHistory")} ({data.passwordHistory.length})
              </button>
              {historyExpanded && (
                <div className="space-y-2 pl-5 pt-1">
                  {data.passwordHistory.map((entry, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 rounded-md bg-muted p-2"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="font-mono text-xs">
                          {revealedHistory.has(idx)
                            ? entry.password
                            : "••••••••••••"}
                        </span>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {new Date(entry.changedAt).toLocaleString(
                            locale === "ja" ? "ja-JP" : "en-US"
                          )}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={() => {
                          setRevealedHistory((prev) => {
                            const next = new Set(prev);
                            if (next.has(idx)) next.delete(idx);
                            else next.add(idx);
                            return next;
                          });
                        }}
                      >
                        {revealedHistory.has(idx) ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <CopyButton getValue={() => entry.password} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Timestamps + Edit */}
      <div className="flex items-center justify-between pt-2">
        <div className="text-xs text-muted-foreground">
          <p>
            {t("created")}:{" "}
            {new Date(data.createdAt).toLocaleString(
              locale === "ja" ? "ja-JP" : "en-US"
            )}
          </p>
          <p>
            {t("updated")}:{" "}
            {new Date(data.updatedAt).toLocaleString(
              locale === "ja" ? "ja-JP" : "en-US"
            )}
          </p>
        </div>
        {onEdit && (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Edit className="h-4 w-4 mr-1" />
            {tc("edit")}
          </Button>
        )}
      </div>
    </div>
  );
}
