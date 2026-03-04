"use client";

import { useTranslations } from "next-intl";
import { Settings } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SessionsCard } from "@/components/sessions/sessions-card";
import { ScimProvisioningCard } from "@/components/settings/scim-provisioning-card";
import { CliTokenCard } from "@/components/settings/cli-token-card";

export default function SettingsPage() {
  const t = useTranslations("Sessions");

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center gap-3">
            <Settings className="h-6 w-6" />
            <div>
              <h1 className="text-2xl font-bold">{t("settingsTitle")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("settingsDescription")}
              </p>
            </div>
          </div>
        </Card>

        <Tabs defaultValue="personal" className="space-y-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="personal">{t("tabPersonal")}</TabsTrigger>
            <TabsTrigger value="tenant">{t("tabTenant")}</TabsTrigger>
          </TabsList>
          <TabsContent value="personal" className="mt-0 space-y-4">
            <SessionsCard />
            <CliTokenCard />
          </TabsContent>
          <TabsContent value="tenant" className="mt-0">
            <ScimProvisioningCard />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
