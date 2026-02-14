"use client";

import { useState, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/passwords/copy-button";
import { TOTPField, type TOTPEntry } from "@/components/passwords/totp-field";
import { OrgAttachmentSection, type OrgAttachmentMeta } from "./org-attachment-section";
import { formatCardNumber } from "@/lib/credit-card";
import { cn } from "@/lib/utils";
import { getTagColorClass } from "@/lib/dynamic-styles";
import { Eye, EyeOff, ExternalLink } from "lucide-react";
import { ENTRY_TYPE, apiPath } from "@/lib/constants";
import type { EntryTypeValue, CustomFieldType } from "@/lib/constants";
import { CUSTOM_FIELD_TYPE } from "@/lib/constants";
import { formatDateTime } from "@/lib/format-datetime";

interface CustomField {
  label: string;
  value: string;
  type: CustomFieldType;
}

interface OrgPasswordDetailProps {
  orgId: string;
  passwordId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PasswordData {
  id: string;
  entryType?: EntryTypeValue;
  title: string;
  username: string | null;
  password: string;
  content?: string;
  url: string | null;
  notes: string | null;
  customFields: CustomField[];
  totp: TOTPEntry | null;
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
  tags: { id: string; name: string; color: string | null }[];
  createdBy: { name: string | null };
  updatedBy: { name: string | null };
  createdAt: string;
  updatedAt: string;
}

export function OrgPasswordDetail({
  orgId,
  passwordId,
  open,
  onOpenChange,
}: OrgPasswordDetailProps) {
  const t = useTranslations("PasswordDetail");
  const tf = useTranslations("PasswordForm");
  const locale = useLocale();
  const [data, setData] = useState<PasswordData | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showCardNumber, setShowCardNumber] = useState(false);
  const [showCvv, setShowCvv] = useState(false);
  const [showIdNumber, setShowIdNumber] = useState(false);
  const [hiddenFieldsVisible, setHiddenFieldsVisible] = useState<Set<number>>(
    new Set()
  );
  const [loading, setLoading] = useState(false);
  const [attachments, setAttachments] = useState<OrgAttachmentMeta[]>([]);

  useEffect(() => {
    if (!open || !passwordId) return;
    setLoading(true);
    setShowPassword(false);
    setShowCardNumber(false);
    setShowCvv(false);
    setShowIdNumber(false);
    setHiddenFieldsVisible(new Set());
    setAttachments([]);

    Promise.all([
      fetch(apiPath.orgPasswordById(orgId, passwordId))
        .then((res) => {
          if (!res.ok) throw new Error("Not found");
          return res.json();
        }),
      fetch(apiPath.orgPasswordAttachments(orgId, passwordId))
        .then((res) => (res.ok ? res.json() : []))
        .catch(() => []),
    ])
      .then(([entryData, attachData]) => {
        setData(entryData);
        setAttachments(attachData);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [open, passwordId, orgId]);

  // Auto-hide password after 30 seconds
  useEffect(() => {
    if (!showPassword) return;
    const timer = setTimeout(() => setShowPassword(false), 30_000);
    return () => clearTimeout(timer);
  }, [showPassword]);

  const toggleHiddenField = (idx: number) => {
    setHiddenFieldsVisible((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] sm:max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{data?.title ?? "..."}</DialogTitle>
          <DialogDescription className="sr-only">
            {data?.title ?? "..."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : data ? (
          <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
            {data.entryType === ENTRY_TYPE.IDENTITY ? (
              <>
                {/* Full Name */}
                {data.fullName && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t("fullName")}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1">{data.fullName}</p>
                      <CopyButton getValue={() => data.fullName ?? ""} />
                    </div>
                  </div>
                )}

                {/* Address */}
                {data.address && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t("address")}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1 whitespace-pre-wrap">{data.address}</p>
                      <CopyButton getValue={() => data.address ?? ""} />
                    </div>
                  </div>
                )}

                {/* Phone */}
                {data.phone && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t("phone")}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1">{data.phone}</p>
                      <CopyButton getValue={() => data.phone ?? ""} />
                    </div>
                  </div>
                )}

                {/* Email */}
                {data.email && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t("email")}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1">{data.email}</p>
                      <CopyButton getValue={() => data.email ?? ""} />
                    </div>
                  </div>
                )}

                {/* Date of Birth */}
                {data.dateOfBirth && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t("dateOfBirth")}</p>
                    <p className="text-sm">{data.dateOfBirth}</p>
                  </div>
                )}

                {/* Nationality */}
                {data.nationality && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t("nationality")}</p>
                    <p className="text-sm">{data.nationality}</p>
                  </div>
                )}

                {/* ID Number */}
                {data.idNumber && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t("idNumber")}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1 font-mono">
                        {showIdNumber ? data.idNumber : "••••••••"}
                      </p>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setShowIdNumber(!showIdNumber)}
                      >
                        {showIdNumber ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                      <CopyButton getValue={() => data.idNumber ?? ""} />
                    </div>
                  </div>
                )}

                {/* Issue Date */}
                {data.issueDate && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t("issueDate")}</p>
                    <p className="text-sm">{data.issueDate}</p>
                  </div>
                )}

                {/* Expiry Date */}
                {data.expiryDate && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t("expiryDate")}</p>
                    <p className="text-sm">{data.expiryDate}</p>
                  </div>
                )}

                {/* Notes */}
                {data.notes && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{t("notes")}</p>
                    <p className="text-sm whitespace-pre-wrap">{data.notes}</p>
                  </div>
                )}
              </>
            ) : data.entryType === ENTRY_TYPE.CREDIT_CARD ? (
              <>
                {/* Card Number */}
                {data.cardNumber && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("cardNumber")}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1 font-mono">
                        {showCardNumber
                          ? formatCardNumber(data.cardNumber, data.brand)
                          : "•••• •••• •••• " + (data.cardNumber.slice(-4) || "••••")}
                      </p>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setShowCardNumber(!showCardNumber)}
                      >
                        {showCardNumber ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                      <CopyButton getValue={() => data.cardNumber ?? ""} />
                    </div>
                  </div>
                )}

                {/* Cardholder Name */}
                {data.cardholderName && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("cardholderName")}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1">{data.cardholderName}</p>
                      <CopyButton getValue={() => data.cardholderName ?? ""} />
                    </div>
                  </div>
                )}

                {/* Brand */}
                {data.brand && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("brand")}
                    </p>
                    <p className="text-sm">{data.brand}</p>
                  </div>
                )}

                {/* Expiry */}
                {(data.expiryMonth || data.expiryYear) && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("expiry")}
                    </p>
                    <p className="text-sm">
                      {data.expiryMonth ?? "--"}/{data.expiryYear ?? "----"}
                    </p>
                  </div>
                )}

                {/* CVV */}
                {data.cvv && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("cvv")}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1 font-mono">
                        {showCvv ? data.cvv : "•••"}
                      </p>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setShowCvv(!showCvv)}
                      >
                        {showCvv ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                      <CopyButton getValue={() => data.cvv ?? ""} />
                    </div>
                  </div>
                )}

                {/* Notes */}
                {data.notes && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("notes")}
                    </p>
                    <p className="text-sm whitespace-pre-wrap">{data.notes}</p>
                  </div>
                )}
              </>
            ) : data.entryType === ENTRY_TYPE.SECURE_NOTE ? (
              /* Secure Note: show content */
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  {t("content")}
                </p>
                <div className="flex items-start gap-2">
                  <p className="flex-1 max-h-96 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-sm font-mono whitespace-pre-wrap">
                    {data.content}
                  </p>
                  <CopyButton getValue={() => data.content ?? ""} />
                </div>
              </div>
            ) : (
              <>
                {data.username && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("username")}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1 font-mono">{data.username}</p>
                      <CopyButton getValue={() => data.username!} />
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("password")}
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="text-sm flex-1 font-mono">
                      {showPassword
                        ? data.password
                        : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setShowPassword(!showPassword)}
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
                    <p className="text-xs text-muted-foreground mt-1">
                      {t("autoHide")}
                    </p>
                  )}
                </div>

                {/* TOTP */}
                {data.totp && (
                  <TOTPField mode="display" totp={data.totp} />
                )}

                {data.url && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("url")}
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm flex-1 truncate">{data.url}</p>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => window.open(data.url!, "_blank")}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}

                {data.notes && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("notes")}
                    </p>
                    <p className="text-sm whitespace-pre-wrap">{data.notes}</p>
                  </div>
                )}

                {/* Custom Fields */}
                {data.customFields.length > 0 && (
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground font-medium">
                      {tf("customFields")}
                    </p>
                    {data.customFields.map((field, idx) => (
                      <div key={idx}>
                        <p className="text-xs text-muted-foreground mb-1">
                          {field.label}
                        </p>
                        <div className="flex items-center gap-2">
                          {field.type === CUSTOM_FIELD_TYPE.HIDDEN ? (
                            <>
                              <p className="text-sm flex-1 font-mono">
                                {hiddenFieldsVisible.has(idx)
                                  ? field.value
                                  : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
                              </p>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => toggleHiddenField(idx)}
                              >
                                {hiddenFieldsVisible.has(idx) ? (
                                  <EyeOff className="h-4 w-4" />
                                ) : (
                                  <Eye className="h-4 w-4" />
                                )}
                              </Button>
                            </>
                          ) : field.type === CUSTOM_FIELD_TYPE.URL ? (
                            <>
                              <p className="text-sm flex-1 truncate">
                                {field.value}
                              </p>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() =>
                                  window.open(field.value, "_blank")
                                }
                              >
                                <ExternalLink className="h-4 w-4" />
                              </Button>
                            </>
                          ) : (
                            <p className="text-sm flex-1">{field.value}</p>
                          )}
                          <CopyButton getValue={() => field.value} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Tags */}
            {data.tags.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  {tf("tags")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {data.tags.map((tag) => {
                    const colorClass = getTagColorClass(tag.color);
                    return (
                      <Badge
                        key={tag.id}
                        variant="secondary"
                        className={cn(
                          colorClass && "tag-color",
                          colorClass
                        )}
                      >
                        {tag.name}
                      </Badge>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Attachments */}
            <div className="border-t pt-3">
              <OrgAttachmentSection
                orgId={orgId}
                entryId={data.id}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                readOnly
              />
            </div>

            <div className="border-t pt-3 space-y-1 text-xs text-muted-foreground">
              <p>
                {t("created")}:{" "}
                {formatDateTime(data.createdAt, locale)}
                {data.createdBy.name && ` (${data.createdBy.name})`}
              </p>
              <p>
                {t("updated")}:{" "}
                {formatDateTime(data.updatedAt, locale)}
                {data.updatedBy.name && ` (${data.updatedBy.name})`}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-center text-muted-foreground py-8">
            {t("notFound")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
