"use client";

import { useTranslations } from "next-intl";
import { UserRound, Monitor, Shield, Code } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SessionsCard } from "@/components/sessions/sessions-card";
import { CliTokenCard } from "@/components/settings/cli-token-card";
import { ApiKeyManager } from "@/components/settings/api-key-manager";
import { TravelModeCard } from "@/components/settings/travel-mode-card";
import { PasskeyCredentialsCard } from "@/components/settings/passkey-credentials-card";
import { RotateKeyCard } from "@/components/settings/rotate-key-card";
import { TabDescription } from "@/components/settings/tab-description";

export default function SettingsPage() {
  const t = useTranslations("Sessions");

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center gap-3">
            <UserRound className="h-6 w-6" />
            <div>
              <h1 className="text-2xl font-bold">{t("settingsTitle")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("settingsDescription")}
              </p>
            </div>
          </div>
        </Card>

        <Tabs defaultValue="account" className="space-y-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="account"><Monitor className="h-4 w-4 mr-2" />{t("tabAccount")}</TabsTrigger>
            <TabsTrigger value="security"><Shield className="h-4 w-4 mr-2" />{t("tabSecurity")}</TabsTrigger>
            <TabsTrigger value="developer"><Code className="h-4 w-4 mr-2" />{t("tabDeveloper")}</TabsTrigger>
          </TabsList>
          <TabsContent value="account" className="mt-0 space-y-4">
            <TabDescription>{t("tabAccountDesc")}</TabDescription>
            <SessionsCard />
          </TabsContent>
          <TabsContent value="security" className="mt-0 space-y-4">
            <TabDescription>{t("tabSecurityDesc")}</TabDescription>
            <TravelModeCard />
            <Separator />
            <PasskeyCredentialsCard />
            <Separator />
            <RotateKeyCard />
          </TabsContent>
          <TabsContent value="developer" className="mt-0 space-y-4">
            <TabDescription>{t("tabDeveloperDesc")}</TabDescription>
            <CliTokenCard />
            <Separator />
            <ApiKeyManager />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
