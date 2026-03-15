"use client";

import { useTranslations } from "next-intl";
import { Building2, Link2, FolderSync, Webhook, Users, Shield, ScrollText } from "lucide-react";
import { useTenantRole } from "@/hooks/use-tenant-role";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TenantMembersCard } from "@/components/settings/tenant-members-card";
import { ScimProvisioningCard } from "@/components/settings/scim-provisioning-card";
import { DirectorySyncCard } from "@/components/settings/directory-sync-card";
import { TenantSessionPolicyCard } from "@/components/settings/tenant-session-policy-card";
import { TenantAccessRestrictionCard } from "@/components/settings/tenant-access-restriction-card";
import { TenantAuditLogCard } from "@/components/settings/tenant-audit-log-card";
import { TenantWebhookCard } from "@/components/settings/tenant-webhook-card";
import { Loader2 } from "lucide-react";
import { TabDescription } from "@/components/settings/tab-description";

export default function TenantSettingsPage() {
  const t = useTranslations("Dashboard");
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
          <TabsList className="grid w-full grid-cols-2 md:grid-cols-5">
            <TabsTrigger value="members"><Users className="h-4 w-4 mr-2" />{t("tenantTabMembers")}</TabsTrigger>
            <TabsTrigger value="security"><Shield className="h-4 w-4 mr-2" />{t("tenantTabSecurity")}</TabsTrigger>
            <TabsTrigger value="provisioning"><Link2 className="h-4 w-4 mr-2" />{t("tenantTabProvisioning")}</TabsTrigger>
            <TabsTrigger value="audit-log"><ScrollText className="h-4 w-4 mr-2" />{t("tenantTabAuditLog")}</TabsTrigger>
            <TabsTrigger value="webhooks"><Webhook className="h-4 w-4 mr-2" />{t("tenantTabWebhooks")}</TabsTrigger>
          </TabsList>
          <TabsContent value="members" className="mt-0 space-y-4">
            <TabDescription>{t("tenantTabMembersDesc")}</TabDescription>
            <TenantMembersCard />
          </TabsContent>
          <TabsContent value="security" className="mt-0 space-y-4">
            <TabDescription>{t("tenantTabSecurityDesc")}</TabDescription>
            <TenantSessionPolicyCard />
            <TenantAccessRestrictionCard />
          </TabsContent>
          <TabsContent value="provisioning" className="mt-0 space-y-4">
            <TabDescription>{t("tenantTabProvisioningDesc")}</TabDescription>
            <Tabs defaultValue="scim" className="space-y-4">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="scim">
                  <Link2 className="h-4 w-4 mr-2" />
                  {t("tenantTabScim")}
                </TabsTrigger>
                <TabsTrigger value="directory-sync">
                  <FolderSync className="h-4 w-4 mr-2" />
                  {t("tenantTabDirectorySync")}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="scim" className="mt-0 space-y-4">
                <ScimProvisioningCard />
              </TabsContent>
              <TabsContent value="directory-sync" className="mt-0 space-y-4">
                <DirectorySyncCard />
              </TabsContent>
            </Tabs>
          </TabsContent>
          <TabsContent value="audit-log" className="mt-0 space-y-4">
            <TabDescription>{t("tenantTabAuditLogDesc")}</TabDescription>
            <TenantAuditLogCard />
          </TabsContent>
          <TabsContent value="webhooks" className="mt-0 space-y-4">
            <TabDescription>{t("tenantTabWebhooksDesc")}</TabDescription>
            <TenantWebhookCard />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
