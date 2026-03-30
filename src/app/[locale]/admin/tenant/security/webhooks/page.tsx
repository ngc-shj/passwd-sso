"use client";

import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { TenantWebhookCard } from "@/components/settings/tenant-webhook-card";
import { Webhook } from "lucide-react";

export default function TenantWebhooksPage() {
  const tWebhook = useTranslations("TenantWebhook");

  return (
    <Card className="rounded-xl border bg-card/80 p-4">
      <div className="flex items-center gap-2 mb-4">
        <Webhook className="h-5 w-5" />
        <h2 className="text-lg font-semibold">{tWebhook("title")}</h2>
      </div>
      <TenantWebhookCard />
    </Card>
  );
}
