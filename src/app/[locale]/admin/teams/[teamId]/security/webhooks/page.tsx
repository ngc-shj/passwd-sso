"use client";

import { use } from "react";
import { useLocale } from "next-intl";
import { TeamWebhookCard } from "@/components/team/team-webhook-card";

export default function TeamWebhooksPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const locale = useLocale();

  return <TeamWebhookCard teamId={teamId} locale={locale} />;
}
