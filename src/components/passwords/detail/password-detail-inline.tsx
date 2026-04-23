"use client";

import { useState, useEffect } from "react";
import { useTranslations, useLocale } from "next-intl";

import { Button } from "@/components/ui/button";
import { AttachmentSection, type AttachmentMeta } from "../entry/attachment-section";
import { TeamAttachmentSection, type TeamAttachmentMeta } from "@/components/team/forms/team-attachment-section";
import { EntryHistorySection } from "../entry/entry-history-section";
import { ENTRY_TYPE } from "@/lib/constants";
import { apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { formatDateTime } from "@/lib/format/format-datetime";
import { useReprompt } from "@/hooks/vault/use-reprompt";
import { Edit } from "lucide-react";

import { SshKeySection } from "./sections/ssh-key-section";
import { BankAccountSection } from "./sections/bank-account-section";
import { SoftwareLicenseSection } from "./sections/software-license-section";
import { PasskeySection } from "./sections/passkey-section";
import { IdentitySection } from "./sections/identity-section";
import { CreditCardSection } from "./sections/credit-card-section";
import { SecureNoteSection } from "./sections/secure-note-section";
import { LoginSection } from "./sections/login-section";

// Re-export for backward compatibility
export type { InlineDetailData } from "@/types/entry";
import type { InlineDetailData } from "@/types/entry";

interface PasswordDetailInlineProps {
  data: InlineDetailData;
  onEdit?: () => void;
  onRefresh?: () => void;
  teamId?: string;
  /** When true, skip remote fetches (history, attachments) — used for emergency vault */
  readOnly?: boolean;
}

export function PasswordDetailInline({ data, onEdit, onRefresh, teamId: scopedTeamId, readOnly }: PasswordDetailInlineProps) {
  const t = useTranslations("PasswordDetail");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const { requireVerification, createGuardedGetter, repromptDialog } = useReprompt();

  // Attachment state
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [teamAttachments, setTeamAttachments] = useState<TeamAttachmentMeta[]>([]);

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    async function loadAttachments() {
      try {
        const url = scopedTeamId
          ? apiPath.teamPasswordAttachments(scopedTeamId, data.id)
          : apiPath.passwordAttachments(data.id);
        const res = await fetchApi(url);
        if (res.ok && !cancelled) {
          const loaded = await res.json();
          if (scopedTeamId) {
            setTeamAttachments(loaded);
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
  }, [data.id, scopedTeamId, readOnly]);

  const sectionProps = { data, requireVerification, createGuardedGetter };

  const isSshKey = data.entryType === ENTRY_TYPE.SSH_KEY;
  const isBankAccount = data.entryType === ENTRY_TYPE.BANK_ACCOUNT;
  const isSoftwareLicense = data.entryType === ENTRY_TYPE.SOFTWARE_LICENSE;
  const isPasskey = data.entryType === ENTRY_TYPE.PASSKEY;
  const isIdentity = data.entryType === ENTRY_TYPE.IDENTITY;
  const isCreditCard = data.entryType === ENTRY_TYPE.CREDIT_CARD;
  const isNote = data.entryType === ENTRY_TYPE.SECURE_NOTE;

  return (
    <div className="space-y-3 border-t pt-3 px-4 pb-3">
      {isSshKey ? (
        <SshKeySection {...sectionProps} />
      ) : isBankAccount ? (
        <BankAccountSection {...sectionProps} />
      ) : isSoftwareLicense ? (
        <SoftwareLicenseSection {...sectionProps} />
      ) : isPasskey ? (
        <PasskeySection {...sectionProps} />
      ) : isIdentity ? (
        <IdentitySection {...sectionProps} />
      ) : isCreditCard ? (
        <CreditCardSection {...sectionProps} />
      ) : isNote ? (
        <SecureNoteSection {...sectionProps} />
      ) : (
        <LoginSection {...sectionProps} />
      )}

      {/* Entry History (full blob snapshots) — hidden in read-only emergency vault */}
      {!readOnly && (
        <EntryHistorySection
          entryId={data.id}
          teamId={scopedTeamId}
          requireReprompt={data.requireReprompt ?? false}
          onRestore={onRefresh}
        />
      )}

      {/* Attachments — hidden in read-only emergency vault */}
      {!readOnly && (
        scopedTeamId ? (
          <TeamAttachmentSection
            teamId={scopedTeamId}
            entryId={data.id}
            attachments={teamAttachments}
            onAttachmentsChange={setTeamAttachments}
            readOnly={!onEdit}
          />
        ) : (
          <AttachmentSection
            entryId={data.id}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            readOnly={!onEdit}
          />
        )
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
