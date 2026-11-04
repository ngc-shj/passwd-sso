"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { apiErrorToI18nKey } from "@/lib/http/api-error-codes";
import { REKEY_ENTRY_BLOCK } from "@/lib/team/rekey-payload";
import {
  REKEY_EXIT,
  REKEY_ISSUE,
  REKEY_SKIP_REASON,
  type RekeyExit,
  type RekeyReport,
  type RekeyReportItem,
} from "@/lib/team/rekey-report";

interface RekeyReportViewProps {
  report: RekeyReport;
}

/** Renders a rotation / re-key pass report: each issue with its exits. */
export function RekeyReportView({ report }: RekeyReportViewProps) {
  const t = useTranslations("Teams");
  const tApi = useTranslations("ApiErrors");

  if (report.items.length === 0 && report.keySuspectVersions.length === 0) return null;

  const holdersText = (item: RekeyReportItem) =>
    Object.values(item.holdersByVersion ?? {})
      .map((names) => names.join(", "))
      .join("; ");

  const skipReason = (reason: string | undefined) => {
    switch (reason) {
      case REKEY_SKIP_REASON.ATTACHMENT_UNOPENABLE:
      case REKEY_ENTRY_BLOCK.ATTACHMENT_UNOPENABLE:
        return t("rekeySkipAttachmentUnopenable");
      case REKEY_SKIP_REASON.RETRY_EXHAUSTED:
        return t("rekeySkipRetryExhausted");
      case REKEY_ENTRY_BLOCK.UNDECRYPTABLE:
        return t("rekeySkipUndecryptable");
      default:
        return tApi(apiErrorToI18nKey(reason));
    }
  };

  const issueText = (item: RekeyReportItem) => {
    const count = item.count;
    switch (item.issue) {
      case REKEY_ISSUE.UNDECRYPTABLE:
        return t("rekeyIssueUndecryptable", { count });
      case REKEY_ISSUE.KEY_INVALID:
        return t("rekeyIssueKeyInvalid", { count });
      case REKEY_ISSUE.NEEDS_REKEYER_HOLDER:
        return t("rekeyIssueNeedsRekeyerHolder", { count });
      case REKEY_ISSUE.HOLDER_CANNOT_REKEY:
        return t("rekeyIssueHolderCannotRekey", { count });
      case REKEY_ISSUE.UNRECOVERABLE:
        return t("rekeyIssueUnrecoverable", { count });
      case REKEY_ISSUE.SKIPPED:
        return t("rekeyIssueSkipped", { count, reason: skipReason(item.reason) });
    }
  };

  const exitText = (exit: RekeyExit, item: RekeyReportItem) => {
    switch (exit) {
      case REKEY_EXIT.ANOTHER_HOLDER_REKEYS: {
        const holders = holdersText(item);
        return holders ? t("rekeyExitAnotherHolderNamed", { holders }) : t("rekeyExitAnotherHolder");
      }
      case REKEY_EXIT.RESTORE_CURRENT_VERSION_ROW:
        return t("rekeyExitRestoreCurrentVersion");
      case REKEY_EXIT.COMPARE_KEYS_WITH_ADMIN:
        return t("rekeyExitCompareKeys");
      case REKEY_EXIT.TEMPORARY_PROMOTION:
        return t("rekeyExitTemporaryPromotion");
      case REKEY_EXIT.DELETE_ENTRY:
        return t("rekeyExitDelete");
      case REKEY_EXIT.RETRY_PASS:
        return t("rekeyExitRetry");
    }
  };

  return (
    <section aria-label={t("rekeyReportTitle")} className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        {t("rekeyReportTitle")}
      </p>
      {report.keySuspectVersions.map((version) => (
        <p key={`suspect-${version}`} role="alert" className="text-amber-800 dark:text-amber-300">
          {t("rekeyKeySuspicion", { version })}
        </p>
      ))}
      <ul className="space-y-3">
        {report.items.map((item, i) => (
          <li key={`${item.issue}-${item.teamKeyVersion ?? "all"}-${item.reason ?? i}`} className="space-y-1">
            <p>{issueText(item)}</p>
            <ul aria-label={t("rekeyExitsLabel")} className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {item.exits.map((exit) => (
                <li key={exit}>
                  {exitText(exit, item)}
                  {exit === REKEY_EXIT.DELETE_ENTRY && item.deactivatedHolder === true && (
                    <span role="alert" className="block text-amber-800 dark:text-amber-300">
                      {t("rekeyExitDeleteDeactivatedHolder")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
