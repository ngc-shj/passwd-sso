"use client";

import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { ORG_ROLE } from "@/lib/constants";
import { CollapsibleSectionHeader } from "@/components/layout/sidebar-shared";
import {
  Download,
  HeartPulse,
  Monitor,
  Settings,
  Shield,
  Upload,
} from "lucide-react";

interface SecurityOrg {
  id: string;
  name: string;
  role: string;
}

interface SecuritySectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  isWatchtower: boolean;
  isEmergencyAccess: boolean;
  onNavigate: () => void;
}

export function SecuritySection({
  isOpen,
  onOpenChange,
  t,
  isWatchtower,
  isEmergencyAccess,
  onNavigate,
}: SecuritySectionProps) {
  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader isOpen={isOpen}>{t("security")}</CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="space-y-1">
          <Button
            variant={isWatchtower ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/watchtower" onClick={onNavigate}>
              <Shield className="h-4 w-4" />
              {t("watchtower")}
            </Link>
          </Button>
          <Button
            variant={isEmergencyAccess ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/emergency-access" onClick={onNavigate}>
              <HeartPulse className="h-4 w-4" />
              {t("emergencyAccess")}
            </Link>
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface UtilitiesSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  tOrg: (key: string) => string;
  selectedOrg: SecurityOrg | null;
  onNavigate: () => void;
}

export function UtilitiesSection({
  isOpen,
  onOpenChange,
  t,
  tOrg,
  selectedOrg,
  onNavigate,
}: UtilitiesSectionProps) {
  const exportHref = selectedOrg
    ? `/dashboard/teams/${selectedOrg.id}/export`
    : "/dashboard/export";
  const importHref = selectedOrg
    ? `/dashboard/teams/${selectedOrg.id}/import`
    : "/dashboard/import";

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader isOpen={isOpen}>{t("utilities")}</CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="space-y-1">
          {selectedOrg &&
            (selectedOrg.role === ORG_ROLE.OWNER || selectedOrg.role === ORG_ROLE.ADMIN) ? (
            <Button variant="ghost" className="w-full justify-start gap-2" asChild>
              <Link href={`/dashboard/teams/${selectedOrg.id}/settings`} onClick={onNavigate}>
                <Settings className="h-4 w-4" />
                {tOrg("orgSettings")}
              </Link>
            </Button>
          ) : !selectedOrg && (
            <>
              <Button variant="ghost" className="w-full justify-start gap-2" asChild>
                <Link href="/dashboard/settings" onClick={onNavigate}>
                  <Monitor className="h-4 w-4" />
                  {t("settings")}
                </Link>
              </Button>
              <Button variant="ghost" className="w-full justify-start gap-2" asChild>
                <Link href="/dashboard/teams" onClick={onNavigate}>
                  <Settings className="h-4 w-4" />
                  {tOrg("orgSettings")}
                </Link>
              </Button>
            </>
          )}
          <Button variant="ghost" className="w-full justify-start gap-2" asChild>
            <Link href={exportHref} onClick={onNavigate}>
              <Download className="h-4 w-4" />
              {t("export")}
            </Link>
          </Button>
          <Button variant="ghost" className="w-full justify-start gap-2" asChild>
            <Link href={importHref} onClick={onNavigate}>
              <Upload className="h-4 w-4" />
              {t("import")}
            </Link>
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
