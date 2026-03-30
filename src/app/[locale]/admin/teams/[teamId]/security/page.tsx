"use client";

import { use } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TeamPolicySettings } from "@/components/team/team-policy-settings";
import { TeamRotateKeyButton } from "@/components/team/team-rotate-key-button";
import { TeamWebhookCard } from "@/components/team/team-webhook-card";
import { Shield, KeyRound, Webhook } from "lucide-react";

export default function TeamSecurityPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("Team");
  const tWebhook = useTranslations("TeamWebhook");
  const locale = useLocale();

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center gap-3">
            <Shield className="h-6 w-6" />
            <div>
              <h1 className="truncate text-2xl font-bold">
                {t("securityPolicy")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("tabPolicyDesc")}
              </p>
            </div>
          </div>
        </Card>

        <TeamPolicySettings teamId={teamId} />

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              <div>
                <CardTitle>{t("rotateKeyTitle")}</CardTitle>
                <CardDescription>{t("rotateKeyDesc")}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <TeamRotateKeyButton teamId={teamId} />
          </CardContent>
        </Card>

        <Card className="rounded-xl border bg-card/80 p-4">
          <div className="flex items-center gap-2 mb-4">
            <Webhook className="h-5 w-5" />
            <h2 className="text-lg font-semibold">{tWebhook("title")}</h2>
          </div>
          <TeamWebhookCard teamId={teamId} locale={locale} />
        </Card>
      </div>
    </div>
  );
}
