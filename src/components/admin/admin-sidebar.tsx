"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { stripLocalePrefix } from "@/i18n/locale-utils";
import { VisuallyHidden } from "radix-ui";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AdminScopeSelector } from "./admin-scope-selector";
import {
  Bot,
  Link2,
  ScrollText,
  Settings2,
  Shield,
  Users,
  UsersRound,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface AdminTeam {
  team: { id: string; name: string; slug: string };
}

interface AdminSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminTeams: AdminTeam[];
  hasTenantRole: boolean;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

function useNavItems(
  pathname: string,
  t: ReturnType<typeof useTranslations>
): NavItem[] {
  const teamMatch = pathname.match(/\/admin\/teams\/([^/]+)/);
  if (teamMatch) {
    const teamId = teamMatch[1];
    return [
      {
        href: `/admin/teams/${teamId}/general`,
        label: t("navGeneral"),
        icon: <Settings2 className="h-4 w-4 shrink-0" />,
      },
      {
        href: `/admin/teams/${teamId}/members`,
        label: t("navMembers"),
        icon: <Users className="h-4 w-4 shrink-0" />,
      },
      {
        href: `/admin/teams/${teamId}/security`,
        label: t("navSecurity"),
        icon: <Shield className="h-4 w-4 shrink-0" />,
      },
      {
        href: `/admin/teams/${teamId}/audit-logs`,
        label: t("navAuditLogs"),
        icon: <ScrollText className="h-4 w-4 shrink-0" />,
      },
    ];
  }

  // Tenant scope (default)
  return [
    {
      href: "/admin/tenant/members",
      label: t("navMembers"),
      icon: <Users className="h-4 w-4 shrink-0" />,
    },
    {
      href: "/admin/tenant/teams",
      label: t("navTeams"),
      icon: <UsersRound className="h-4 w-4 shrink-0" />,
    },
    {
      href: "/admin/tenant/security",
      label: t("navSecurity"),
      icon: <Shield className="h-4 w-4 shrink-0" />,
    },
    {
      href: "/admin/tenant/provisioning",
      label: t("navProvisioning"),
      icon: <Link2 className="h-4 w-4 shrink-0" />,
    },
    {
      href: "/admin/tenant/machine-identity",
      label: t("navMachineIdentity"),
      icon: <Bot className="h-4 w-4 shrink-0" />,
    },
    {
      href: "/admin/tenant/audit-logs",
      label: t("navAuditLogs"),
      icon: <ScrollText className="h-4 w-4 shrink-0" />,
    },
  ];
}

function SidebarNav({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-col gap-0.5 px-2 py-2">
      {items.map((item) => {
        const isActive = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
              isActive
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function AdminSidebarContent({
  adminTeams,
  hasTenantRole,
  onNavigate,
}: {
  adminTeams: AdminTeam[];
  hasTenantRole: boolean;
  onNavigate?: () => void;
}) {
  const t = useTranslations("AdminConsole");
  const rawPathname = usePathname();
  const pathname = stripLocalePrefix(rawPathname);
  const items = useNavItems(pathname, t);

  return (
    <div className="flex flex-col h-full">
      <AdminScopeSelector adminTeams={adminTeams} hasTenantRole={hasTenantRole} />
      <SidebarNav items={items} pathname={pathname} onNavigate={onNavigate} />
    </div>
  );
}

export function AdminSidebar({
  open,
  onOpenChange,
  adminTeams,
  hasTenantRole,
}: AdminSidebarProps) {
  const t = useTranslations("AdminConsole");

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-52 border-r bg-background shrink-0 overflow-auto">
        <AdminSidebarContent adminTeams={adminTeams} hasTenantRole={hasTenantRole} />
      </aside>

      {/* Mobile sidebar (sheet) */}
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-52 p-0 overflow-auto">
          <VisuallyHidden.Root>
            <SheetTitle>{t("title")}</SheetTitle>
          </VisuallyHidden.Root>
          <AdminSidebarContent
            adminTeams={adminTeams}
            hasTenantRole={hasTenantRole}
            onNavigate={() => onOpenChange(false)}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
