"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { PasswordEditDialogLoader } from "@/components/passwords/personal-password-edit-dialog-loader";
import { TeamEditDialogLoader } from "@/components/team/team-edit-dialog-loader";
import {
  useWatchtower,
  OLD_THRESHOLD_DAYS,
  EXPIRING_THRESHOLD_DAYS,
  type WatchtowerEntryRef,
  type WatchtowerScope,
} from "@/hooks/use-watchtower";
import { AutoMonitorToggle } from "@/components/watchtower/auto-monitor-toggle";
import { ScoreGauge } from "@/components/watchtower/score-gauge";
import {
  IssueSection,
  ReusedSection,
  DuplicateSection,
} from "@/components/watchtower/issue-section";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RefreshCw, Loader2, Shield } from "lucide-react";
import {
  calculateTotalIssues,
  getWatchtowerVisibility,
} from "@/lib/watchtower/state";
import { useNavigationGuard } from "@/hooks/form/use-navigation-guard";
import {
  formatBreachDetails,
  formatWeakDetails,
  formatOldDetails,
  formatUnsecuredDetails,
  formatExpiringDetails,
} from "@/lib/watchtower/format-details";
import { toast } from "sonner";

interface WatchtowerPageProps {
  scope: WatchtowerScope;
}

export function WatchtowerPage({ scope }: WatchtowerPageProps) {
  const t = useTranslations("Watchtower");
  const locale = useLocale();
  const {
    report,
    loading,
    progress,
    analyze,
    canAnalyze,
    cooldownRemainingMs,
    unavailableReason,
    autoMonitorEnabled,
    setAutoMonitorEnabled,
    lastBreachCheckAt,
  } = useWatchtower(scope);
  const [selectedEntry, setSelectedEntry] = useState<WatchtowerEntryRef | null>(null);
  const guard = useNavigationGuard(loading);

  const totalIssues = report ? calculateTotalIssues(report) : 0;
  const visibility = getWatchtowerVisibility(
    report,
    unavailableReason,
    loading,
    totalIssues,
  );

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <AlertDialog open={guard.dialogOpen} onOpenChange={guard.cancelLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("leaveTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("leaveConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("leaveStay")}</AlertDialogCancel>
            <AlertDialogAction onClick={guard.confirmLeave}>
              {t("leaveNow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Shield className="h-6 w-6" />
                <h1 className="text-2xl font-bold">{t("title")}</h1>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void analyze();
                }}
                disabled={!canAnalyze}
              >
                {loading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {canAnalyze
                  ? t("refresh")
                  : t("cooldown", {
                      seconds: Math.ceil(cooldownRemainingMs / 1000),
                    })}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("description")}
            </p>
          </div>
        </Card>

        {scope.type === "personal" && (
          <AutoMonitorToggle
            enabled={autoMonitorEnabled}
            onToggle={setAutoMonitorEnabled}
            lastCheckAt={lastBreachCheckAt}
          />
        )}

        {visibility.showRunHint && (
          <Card className="rounded-xl border bg-card/80">
            <CardContent className="flex flex-col items-center py-12 gap-3">
              <Shield className="h-12 w-12 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground text-center">
                {canAnalyze
                  ? t("runHint")
                  : t("runHintCooldown", {
                      seconds: Math.ceil(cooldownRemainingMs / 1000),
                    })}
              </p>
            </CardContent>
          </Card>
        )}

        {visibility.showUnavailableCard && (
          <Card className="rounded-xl border bg-card/80">
            <CardContent className="flex flex-col items-center py-12 gap-3">
              <Shield className="h-12 w-12 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground text-center">
                {unavailableReason === "personalKeyUnavailable"
                  ? t("personalKeyUnavailable")
                  : unavailableReason === "teamKeyUnavailable"
                  ? t("teamKeyUnavailable")
                  : t("analysisUnavailable")}
              </p>
            </CardContent>
          </Card>
        )}

        {loading && (
          <Card className="rounded-xl border bg-card/80">
            <CardContent className="flex flex-col items-center py-12 gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground text-center">
                {t("leaveDuringAnalysis")}
              </p>
              <p className="text-sm text-muted-foreground">
                {progress.step.startsWith("hibp:")
                  ? t("checkingBreaches") +
                    ` (${progress.step.replace("hibp:", "")})`
                  : t(
                      progress.step === "fetching"
                        ? "fetching"
                        : progress.step === "decrypting"
                          ? "decrypting"
                          : progress.step === "analyzing"
                            ? "analyzingLocal"
                            : "checkingBreaches"
                    )}
              </p>
            </CardContent>
          </Card>
        )}

        {report && !loading && (
          <>
            <Card className="rounded-xl border bg-card/80">
              <CardContent className="flex flex-col items-center py-8 gap-4">
                <ScoreGauge
                  score={report.overallScore}
                  label={
                    report.overallScore >= 80
                      ? t("scoreExcellent")
                      : report.overallScore >= 60
                        ? t("scoreGood")
                        : report.overallScore >= 40
                          ? t("scoreFair")
                          : t("scorePoor")
                  }
                />
                <div className="text-center">
                  <p className="font-semibold">{t("overallScore")}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {totalIssues === 0
                      ? t("noIssues")
                      : t("issuesSummary", {
                          total: report.totalPasswords,
                          issues: totalIssues,
                        })}
                  </p>
                </div>
              </CardContent>
            </Card>

            {visibility.showNoIssuesCard && (
              <Card className="rounded-xl border bg-card/80">
                <CardContent className="flex flex-col items-center py-12 gap-3">
                  <Shield className="h-12 w-12 text-green-500" />
                  <p className="text-sm text-muted-foreground text-center">
                    {t("noIssuesDesc")}
                  </p>
                </CardContent>
              </Card>
            )}

            {visibility.showIssueSections && (
              <div className="space-y-4">
                <IssueSection
                  type="breached"
                  title={t("breached")}
                  description={t("breachedDesc")}
                  issues={report.breached}
                  formatDetails={(d) => formatBreachDetails(d, t)}
                  onSelectEntry={setSelectedEntry}
                />
                <IssueSection
                  type="weak"
                  title={t("weak")}
                  description={t("weakDesc")}
                  issues={report.weak}
                  formatDetails={(d) => formatWeakDetails(d, t)}
                  onSelectEntry={setSelectedEntry}
                />
                <ReusedSection
                  title={t("reused")}
                  description={t("reusedDesc")}
                  groups={report.reused}
                  formatCount={(count) => t("reusedCount", { count })}
                  onSelectEntry={setSelectedEntry}
                />
                <IssueSection
                  type="old"
                  title={t("old")}
                  description={t("oldDesc", { days: OLD_THRESHOLD_DAYS })}
                  issues={report.old}
                  formatDetails={(d) => formatOldDetails(d, t)}
                  onSelectEntry={setSelectedEntry}
                />
                <IssueSection
                  type="unsecured"
                  title={t("unsecured")}
                  description={t("unsecuredDesc")}
                  issues={report.unsecured}
                  formatDetails={formatUnsecuredDetails}
                  onSelectEntry={setSelectedEntry}
                />
                <DuplicateSection
                  title={t("duplicate")}
                  description={t("duplicateDesc")}
                  groups={report.duplicate}
                  formatCount={(count, hostname) => t("duplicateCount", { count, hostname })}
                  onSelectEntry={setSelectedEntry}
                />
                <IssueSection
                  type="expiring"
                  title={t("expiring")}
                  description={t("expiringDesc", { days: EXPIRING_THRESHOLD_DAYS })}
                  issues={report.expiring}
                  formatDetails={(d) => formatExpiringDetails(d, locale, t)}
                  onSelectEntry={setSelectedEntry}
                />
              </div>
            )}

            {visibility.showEmptyVault && (
              <Card className="rounded-xl border bg-card/80">
                <CardContent className="flex flex-col items-center py-12 gap-3">
                  <Shield className="h-12 w-12 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    {t("noPasswords")}
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
      {selectedEntry?.scope === "personal" && (
        <PasswordEditDialogLoader
          id={selectedEntry.id}
          open={true}
          onOpenChange={(open) => {
            if (!open) setSelectedEntry(null);
          }}
          onSaved={() => {
            setSelectedEntry(null);
            toast.message(t("refreshAfterEdit"));
          }}
        />
      )}
      {selectedEntry?.scope === "team" && (
        <TeamEditDialogLoader
          teamId={selectedEntry.teamId}
          id={selectedEntry.id}
          open={true}
          onOpenChange={(open) => {
            if (!open) setSelectedEntry(null);
          }}
          onSaved={() => {
            setSelectedEntry(null);
            toast.message(t("refreshAfterEdit"));
          }}
        />
      )}
    </div>
  );
}
