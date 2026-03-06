"use client";

import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { TEAM_ROLE } from "@/lib/constants";
import { CollapsibleSectionHeader } from "@/components/layout/sidebar-shared";
import type { VaultContext } from "@/hooks/use-vault-context";
import {
  Building2,
  Download,
  HeartPulse,
  Shield,
  Upload,
  UserRound,
  Users,
} from "lucide-react";

interface SecurityTeam {
  id: string;
  name: string;
  role: string;
}

interface SecuritySectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  vaultContext: VaultContext;
  isWatchtower: boolean;
  isEmergencyAccess: boolean;
  onNavigate: () => void;
}

export function SecuritySection({
  isOpen,
  onOpenChange,
  t,
  vaultContext,
  isWatchtower,
  isEmergencyAccess,
  onNavigate,
}: SecuritySectionProps) {
  const watchtowerHref =
    vaultContext.type === "team"
      ? `/dashboard/teams/${vaultContext.teamId}/watchtower`
      : "/dashboard/watchtower";
  const canAccessWatchtower =
    vaultContext.type !== "team" || vaultContext.teamRole !== TEAM_ROLE.VIEWER;

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader isOpen={isOpen}>{t("security")}</CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="space-y-1">
          {canAccessWatchtower && (
            <Button
              variant={isWatchtower ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href={watchtowerHref} onClick={onNavigate}>
                <Shield className="h-4 w-4" />
                {t("watchtower")}
              </Link>
            </Button>
          )}
          {vaultContext.type !== "team" && (
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
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface SettingsNavSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  tTeam: (key: string) => string;
  selectedTeam?: SecurityTeam | null;
  isTeamSettingsActive?: boolean;
  isTenantSettingsActive?: boolean;
  isSettingsActive?: boolean;
  isAdmin?: boolean;
  onNavigate: () => void;
}

export function SettingsNavSection({
  isOpen,
  onOpenChange,
  t,
  tTeam,
  selectedTeam,
  isTeamSettingsActive,
  isTenantSettingsActive,
  isSettingsActive,
  isAdmin,
  onNavigate,
}: SettingsNavSectionProps) {
  const scopedTeam = selectedTeam ?? null;

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader isOpen={isOpen}>{t("settingsNav")}</CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="space-y-1">
          {scopedTeam &&
            (scopedTeam.role === TEAM_ROLE.OWNER || scopedTeam.role === TEAM_ROLE.ADMIN) ? (
            <Button variant={isTeamSettingsActive ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
              <Link href={`/dashboard/teams/${scopedTeam.id}/settings`} onClick={onNavigate}>
                <Users className="h-4 w-4" />
                {tTeam("teamSettings")}
              </Link>
            </Button>
          ) : !scopedTeam && (
            <>
              <Button variant={isSettingsActive ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
                <Link href="/dashboard/settings" onClick={onNavigate}>
                  <UserRound className="h-4 w-4" />
                  {t("settings")}
                </Link>
              </Button>
              {isAdmin && (
                <Button variant={isTenantSettingsActive ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
                  <Link href="/dashboard/tenant" onClick={onNavigate}>
                    <Building2 className="h-4 w-4" />
                    {t("tenantSettings")}
                  </Link>
                </Button>
              )}
              <Button variant={isTeamSettingsActive ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
                <Link href="/dashboard/teams" onClick={onNavigate}>
                  <Users className="h-4 w-4" />
                  {tTeam("teamSettings")}
                </Link>
              </Button>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ToolsSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  selectedTeam?: SecurityTeam | null;
  isExportActive?: boolean;
  isImportActive?: boolean;
  onNavigate: () => void;
}

export function ToolsSection({
  isOpen,
  onOpenChange,
  t,
  selectedTeam,
  isExportActive,
  isImportActive,
  onNavigate,
}: ToolsSectionProps) {
  const scopedTeam = selectedTeam ?? null;
  const exportHref = scopedTeam
    ? `/dashboard/teams/${scopedTeam.id}/export`
    : "/dashboard/export";
  const importHref = scopedTeam
    ? `/dashboard/teams/${scopedTeam.id}/import`
    : "/dashboard/import";

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader isOpen={isOpen}>{t("tools")}</CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="space-y-1">
          <Button variant={isExportActive ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
            <Link href={exportHref} onClick={onNavigate}>
              <Download className="h-4 w-4" />
              {t("export")}
            </Link>
          </Button>
          <Button variant={isImportActive ? "secondary" : "ghost"} className="w-full justify-start gap-2" asChild>
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
