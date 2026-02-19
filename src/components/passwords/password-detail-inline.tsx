"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations, useLocale } from "next-intl";

import { Button } from "@/components/ui/button";
import { CopyButton } from "./copy-button";
import { Favicon } from "./favicon";
import { TOTPField, type TOTPEntry } from "./totp-field";
import { AttachmentSection, type AttachmentMeta } from "./attachment-section";
import { OrgAttachmentSection, type OrgAttachmentMeta } from "@/components/org/org-attachment-section";
import { EntryHistorySection } from "./entry-history-section";
import { formatCardNumber } from "@/lib/credit-card";
import { CUSTOM_FIELD_TYPE } from "@/lib/constants";
import type {
  EntryCustomField,
  EntryPasswordHistory,
} from "@/lib/entry-form-types";
import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import { apiPath } from "@/lib/constants";
import { formatDateTime } from "@/lib/format-datetime";
import { useReprompt } from "@/hooks/use-reprompt";
import {
  Edit,
  Eye,
  EyeOff,
  History,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

export interface InlineDetailData {
  id: string;
  entryType?: EntryTypeValue;
  requireReprompt?: boolean;
  password: string;
  content?: string;
  url: string | null;
  urlHost: string | null;
  notes: string | null;
  customFields: EntryCustomField[];
  passwordHistory: EntryPasswordHistory[];
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
  relyingPartyId?: string | null;
  relyingPartyName?: string | null;
  username?: string | null;
  credentialId?: string | null;
  creationDate?: string | null;
  deviceInfo?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PasswordDetailInlineProps {
  data: InlineDetailData;
  onEdit?: () => void;
  onRefresh?: () => void;
  orgId?: string;
}

const REVEAL_TIMEOUT = 30_000;

export function PasswordDetailInline({ data, onEdit, onRefresh, orgId }: PasswordDetailInlineProps) {
  const t = useTranslations("PasswordDetail");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const { requireVerification, createGuardedGetter, repromptDialog } = useReprompt();
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
  const [showCredentialId, setShowCredentialId] = useState(false);

  // Attachment state
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [orgAttachments, setOrgAttachments] = useState<OrgAttachmentMeta[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function loadAttachments() {
      try {
        const url = orgId
          ? apiPath.orgPasswordAttachments(orgId, data.id)
          : apiPath.passwordAttachments(data.id);
        const res = await fetch(url);
        if (res.ok && !cancelled) {
          const loaded = await res.json();
          if (orgId) {
            setOrgAttachments(loaded);
          } else {
            setAttachments(loaded);
          }
        }
      } catch {
        // silently fail — attachments are optional
      }
    }
    loadAttachments();
    return () => { cancelled = true; };
  }, [data.id, orgId]);

  const handleReveal = useCallback(() => {
    requireVerification(data.id, data.requireReprompt ?? false, () => {
      setShowPassword(true);
      setTimeout(() => setShowPassword(false), REVEAL_TIMEOUT);
    });
  }, [data.id, data.requireReprompt, requireVerification]);

  const handleRevealCardNumber = useCallback(() => {
    requireVerification(data.id, data.requireReprompt ?? false, () => {
      setShowCardNumber(true);
      setTimeout(() => setShowCardNumber(false), REVEAL_TIMEOUT);
    });
  }, [data.id, data.requireReprompt, requireVerification]);

  const handleRevealCvv = useCallback(() => {
    requireVerification(data.id, data.requireReprompt ?? false, () => {
      setShowCvv(true);
      setTimeout(() => setShowCvv(false), REVEAL_TIMEOUT);
    });
  }, [data.id, data.requireReprompt, requireVerification]);

  const handleRevealIdNumber = useCallback(() => {
    requireVerification(data.id, data.requireReprompt ?? false, () => {
      setShowIdNumber(true);
      setTimeout(() => setShowIdNumber(false), REVEAL_TIMEOUT);
    });
  }, [data.id, data.requireReprompt, requireVerification]);

  const isNote = data.entryType === ENTRY_TYPE.SECURE_NOTE;
  const isCreditCard = data.entryType === ENTRY_TYPE.CREDIT_CARD;
  const isIdentity = data.entryType === ENTRY_TYPE.IDENTITY;
  const isPasskey = data.entryType === ENTRY_TYPE.PASSKEY;

  const handleRevealCredentialId = useCallback(() => {
    requireVerification(data.id, data.requireReprompt ?? false, () => {
      setShowCredentialId(true);
      setTimeout(() => setShowCredentialId(false), REVEAL_TIMEOUT);
    });
  }, [data.id, data.requireReprompt, requireVerification]);

  return (
    <div className="space-y-3 border-t pt-3 px-4 pb-3">
      {isPasskey ? (
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
                  onClick={showCredentialId ? () => setShowCredentialId(false) : handleRevealCredentialId}
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
            </div>
          )}

          {/* Creation Date */}
          {data.creationDate && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("creationDate")}</label>
              <p className="text-sm">{data.creationDate}</p>
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
      ) : isIdentity ? (
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
              <p className="text-sm">{data.dateOfBirth}</p>
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
                  onClick={showIdNumber ? () => setShowIdNumber(false) : handleRevealIdNumber}
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
            </div>
          )}

          {/* Issue Date */}
          {data.issueDate && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("issueDate")}</label>
              <p className="text-sm">{data.issueDate}</p>
            </div>
          )}

          {/* Expiry Date */}
          {data.expiryDate && (
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">{t("expiryDate")}</label>
              <p className="text-sm">{data.expiryDate}</p>
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
      ) : isCreditCard ? (
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
                  onClick={showCardNumber ? () => setShowCardNumber(false) : handleRevealCardNumber}
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
                  onClick={showCvv ? () => setShowCvv(false) : handleRevealCvv}
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
      ) : isNote ? (
        /* Secure Note Content */
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("content")}</label>
          <div className="flex items-start gap-2">
            <p className="flex-1 max-h-96 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-sm font-mono whitespace-pre-wrap">
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
              <CopyButton
                getValue={createGuardedGetter(
                  data.id,
                  data.requireReprompt ?? false,
                  () => data.password,
                )}
              />
            </div>
            {showPassword && (
              <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
            )}
          </div>

          {/* TOTP */}
          {data.totp && (
            <TOTPField
              mode="display"
              totp={data.totp}
              wrapCopyGetter={(getter) =>
                createGuardedGetter(data.id, data.requireReprompt ?? false, getter)
              }
            />
          )}

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
              <p className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
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
                  {field.type === CUSTOM_FIELD_TYPE.URL ? (
                    <a
                      href={field.value}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-600 hover:underline"
                    >
                      {field.value}
                    </a>
                  ) : field.type === CUSTOM_FIELD_TYPE.HIDDEN ? (
                    <>
                      <span className="font-mono text-sm">
                        {revealedFields.has(idx) ? field.value : "••••••••••••"}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => {
                          if (revealedFields.has(idx)) {
                            setRevealedFields((prev) => {
                              const next = new Set(prev);
                              next.delete(idx);
                              return next;
                            });
                          } else {
                            requireVerification(data.id, data.requireReprompt ?? false, () => {
                              setRevealedFields((prev) => {
                                const next = new Set(prev);
                                next.add(idx);
                                return next;
                              });
                              setTimeout(() => {
                                setRevealedFields((prev) => {
                                  const next = new Set(prev);
                                  next.delete(idx);
                                  return next;
                                });
                              }, REVEAL_TIMEOUT);
                            });
                          }
                        }}
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
                  <CopyButton
                    getValue={
                      field.type === CUSTOM_FIELD_TYPE.HIDDEN
                        ? createGuardedGetter(
                            data.id,
                            data.requireReprompt ?? false,
                            () => field.value,
                          )
                        : () => Promise.resolve(field.value)
                    }
                  />
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
                      className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="font-mono text-xs">
                          {revealedHistory.has(idx)
                            ? entry.password
                            : "••••••••••••"}
                        </span>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {formatDateTime(entry.changedAt, locale)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={() => {
                          if (revealedHistory.has(idx)) {
                            setRevealedHistory((prev) => {
                              const next = new Set(prev);
                              next.delete(idx);
                              return next;
                            });
                          } else {
                            requireVerification(data.id, data.requireReprompt ?? false, () => {
                              setRevealedHistory((prev) => {
                                const next = new Set(prev);
                                next.add(idx);
                                return next;
                              });
                              setTimeout(() => {
                                setRevealedHistory((prev) => {
                                  const next = new Set(prev);
                                  next.delete(idx);
                                  return next;
                                });
                              }, REVEAL_TIMEOUT);
                            });
                          }
                        }}
                      >
                        {revealedHistory.has(idx) ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <CopyButton
                        getValue={createGuardedGetter(
                          data.id,
                          data.requireReprompt ?? false,
                          () => entry.password,
                        )}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Entry History (full blob snapshots) */}
      <EntryHistorySection entryId={data.id} orgId={orgId} requireReprompt={data.requireReprompt ?? false} onRestore={onRefresh} />

      {/* Attachments */}
      {orgId ? (
        <OrgAttachmentSection
          orgId={orgId}
          entryId={data.id}
          attachments={orgAttachments}
          onAttachmentsChange={setOrgAttachments}
          readOnly={!onEdit}
        />
      ) : (
        <AttachmentSection
          entryId={data.id}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          readOnly={!onEdit}
        />
      )}

      {/* Timestamps + Edit */}
      <div className="flex items-center justify-between pt-2">
        <div className="text-xs text-muted-foreground">
          <p>
            {t("created")}:{" "}
            {formatDateTime(data.createdAt, locale)}
          </p>
          <p>
            {t("updated")}:{" "}
            {formatDateTime(data.updatedAt, locale)}
          </p>
        </div>
        {onEdit && (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Edit className="h-4 w-4 mr-1" />
            {tc("edit")}
          </Button>
        )}
      </div>
      {repromptDialog}
    </div>
  );
}
