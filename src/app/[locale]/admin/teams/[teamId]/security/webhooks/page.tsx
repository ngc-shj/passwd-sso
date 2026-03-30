"use client";

import { use } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { TeamWebhookCard } from "@/components/team/team-webhook-card";
import { Webhook } from "lucide-react";

export default function TeamWebhooksPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const tWebhook = useTranslations("TeamWebhook");
  const locale = useLocale();

  return (
    <Card className="rounded-xl border bg-card/80 p-4">
      <div className="flex items-center gap-2 mb-4">
        <Webhook className="h-5 w-5" />
        <h2 className="text-lg font-semibold">{tWebhook("title")}</h2>
      </div>
      <TeamWebhookCard teamId={teamId} locale={locale} />
    </Card>
  );
}
