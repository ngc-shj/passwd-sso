"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useWatchtower, OLD_THRESHOLD_DAYS } from "@/hooks/use-watchtower";
import { ScoreGauge } from "@/components/watchtower/score-gauge";
import {
  IssueSection,
  ReusedSection,
} from "@/components/watchtower/issue-section";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw, Loader2, Shield } from "lucide-react";

export default function WatchtowerPage() {
  const t = useTranslations("Watchtower");
  const { report, loading, progress, analyze } = useWatchtower();

  useEffect(() => {
    analyze();
  }, [analyze]);

  const formatBreachDetails = (details: string) => {
    const count = details.replace("count:", "");
    return t("breachedCount", { count });
  };

  const formatWeakDetails = (details: string) => {
    const entropy = details.replace("entropy:", "");
    return t("weakEntropy", { entropy });
  };

  const formatOldDetails = (details: string) => {
    const days = details.replace("days:", "");
    return t("oldDays", { days });
  };

  const formatUnsecuredDetails = (details: string) => {
    const url = details.replace("url:", "");
    return url;
  };

  const totalIssues = report
    ? report.breached.length +
      report.weak.length +
      report.reused.reduce((s, g) => s + g.entries.length, 0) +
      report.old.length +
      report.unsecured.length
    : 0;

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">{t("title")}</h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={analyze}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          {t("refresh")}
        </Button>
      </div>

      {/* Loading state */}
      {loading && (
        <Card className="mb-6">
          <CardContent className="flex flex-col items-center py-12 gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
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

      {/* Report */}
      {report && !loading && (
        <>
          {/* Score Card */}
          <Card className="mb-6">
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
                <h2 className="font-semibold">{t("overallScore")}</h2>
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

          {/* No issues state */}
          {totalIssues === 0 && report.totalPasswords > 0 && (
            <Card>
              <CardContent className="flex flex-col items-center py-12 gap-3">
                <Shield className="h-12 w-12 text-green-500" />
                <p className="text-sm text-muted-foreground text-center">
                  {t("noIssuesDesc")}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Issue Sections */}
          {totalIssues > 0 && (
            <div className="space-y-3">
              <IssueSection
                type="breached"
                title={t("breached")}
                description={t("breachedDesc")}
                issues={report.breached}
                formatDetails={formatBreachDetails}
              />
              <IssueSection
                type="weak"
                title={t("weak")}
                description={t("weakDesc")}
                issues={report.weak}
                formatDetails={formatWeakDetails}
              />
              <ReusedSection
                title={t("reused")}
                description={t("reusedDesc")}
                groups={report.reused}
                formatCount={(count) => t("reusedCount", { count })}
              />
              <IssueSection
                type="old"
                title={t("old")}
                description={t("oldDesc", { days: OLD_THRESHOLD_DAYS })}
                issues={report.old}
                formatDetails={formatOldDetails}
              />
              <IssueSection
                type="unsecured"
                title={t("unsecured")}
                description={t("unsecuredDesc")}
                issues={report.unsecured}
                formatDetails={formatUnsecuredDetails}
              />
            </div>
          )}

          {/* Empty vault */}
          {report.totalPasswords === 0 && (
            <Card>
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
  );
}
