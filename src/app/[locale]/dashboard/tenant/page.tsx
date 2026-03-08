"use client";

import { useTranslations } from "next-intl";
import { Building2 } from "lucide-react";
import { useTenantRole } from "@/hooks/use-tenant-role";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TenantMembersCard } from "@/components/settings/tenant-members-card";
import { ScimProvisioningCard } from "@/components/settings/scim-provisioning-card";
import { DirectorySyncCard } from "@/components/settings/directory-sync-card";
import { TenantSessionPolicyCard } from "@/components/settings/tenant-session-policy-card";
import { Loader2 } from "lucide-react";

export default function TenantSettingsPage() {
  const t = useTranslations("Dashboard");
  const tTenant = useTranslations("TenantAdmin");
  const tDs = useTranslations("DirectorySync");
  const tScim = useTranslations("Team");
  const { isAdmin, loading } = useTenantRole();

  if (loading) {
    return (
      <div className="flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto max-w-4xl flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto max-w-4xl">
          <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-8 text-center">
            <p className="text-muted-foreground">{t("tenantSettingsNoAccess")}</p>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center gap-3">
            <Building2 className="h-6 w-6" />
            <div>
              <h1 className="text-2xl font-bold">{t("tenantSettings")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("tenantSettingsDescription")}
              </p>
            </div>
          </div>
        </Card>

        <Tabs defaultValue="members" className="space-y-4">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="members">{t("tenantTabMembers")}</TabsTrigger>
            <TabsTrigger value="security">{t("tenantTabSecurity")}</TabsTrigger>
            <TabsTrigger value="scim">{t("tenantTabScim")}</TabsTrigger>
            <TabsTrigger value="directory-sync">{t("tenantTabDirectorySync")}</TabsTrigger>
          </TabsList>
          <TabsContent value="members" className="mt-0 space-y-4">
            <TenantMembersCard />
          </TabsContent>
          <TabsContent value="security" className="mt-0 space-y-4">
            <TenantSessionPolicyCard />
          </TabsContent>
          <TabsContent value="scim" className="mt-0 space-y-4">
            <ScimProvisioningCard />
          </TabsContent>
          <TabsContent value="directory-sync" className="mt-0 space-y-4">
            <DirectorySyncCard />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
