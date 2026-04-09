"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { stripLocalePrefix } from "@/i18n/locale-utils";
import { VisuallyHidden } from "radix-ui";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AdminScopeSelector } from "./admin-scope-selector";
import {
  Archive,
  Blocks,
  Bot,
  ChevronDown,
  Clock,
  Crown,
  Cpu,
  Database,
  FolderSync,
  KeyRound,
  Link2,
  ListChecks,
  Lock,
  ScrollText,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  UserPlus,
  Users,
  UsersRound,
  Webhook,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

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
  children?: NavItem[];
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
        children: [
          { href: `/admin/teams/${teamId}/members/list`, label: t("navMemberList"), icon: <Users className="h-3.5 w-3.5 shrink-0" /> },
          { href: `/admin/teams/${teamId}/members/add`, label: t("navAddMember"), icon: <UserPlus className="h-3.5 w-3.5 shrink-0" /> },
          { href: `/admin/teams/${teamId}/members/transfer`, label: t("navTransferOwnership"), icon: <Crown className="h-3.5 w-3.5 shrink-0" /> },
        ],
      },
      {
        href: `/admin/teams/${teamId}/security`,
        label: t("navSecurity"),
        icon: <Shield className="h-4 w-4 shrink-0" />,
        children: [
          { href: `/admin/teams/${teamId}/security/policy`, label: t("navPolicy"), icon: <ListChecks className="h-3.5 w-3.5 shrink-0" /> },
          { href: `/admin/teams/${teamId}/security/key-rotation`, label: t("navKeyRotation"), icon: <KeyRound className="h-3.5 w-3.5 shrink-0" /> },
          { href: `/admin/teams/${teamId}/security/webhooks`, label: t("navWebhooks"), icon: <Webhook className="h-3.5 w-3.5 shrink-0" /> },
        ],
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
      children: [
        { href: "/admin/tenant/security/session-policy", label: t("navSessionPolicy"), icon: <Clock className="h-3.5 w-3.5 shrink-0" /> },
        { href: "/admin/tenant/security/passkey-policy", label: t("navPasskeyPolicy"), icon: <KeyRound className="h-3.5 w-3.5 shrink-0" /> },
        { href: "/admin/tenant/security/lockout-policy", label: t("navLockoutPolicy"), icon: <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> },
        { href: "/admin/tenant/security/password-policy", label: t("navPasswordPolicy"), icon: <Lock className="h-3.5 w-3.5 shrink-0" /> },
        { href: "/admin/tenant/security/retention-policy", label: t("navRetentionPolicy"), icon: <Archive className="h-3.5 w-3.5 shrink-0" /> },
        { href: "/admin/tenant/security/access-restriction", label: t("navAccessRestriction"), icon: <ShieldBan className="h-3.5 w-3.5 shrink-0" /> },
        { href: "/admin/tenant/security/webhooks", label: t("navWebhooks"), icon: <Webhook className="h-3.5 w-3.5 shrink-0" /> },
      ],
    },
    {
      href: "/admin/tenant/provisioning",
      label: t("navProvisioning"),
      icon: <Link2 className="h-4 w-4 shrink-0" />,
      children: [
        { href: "/admin/tenant/provisioning/scim", label: t("navScim"), icon: <Database className="h-3.5 w-3.5 shrink-0" /> },
        { href: "/admin/tenant/provisioning/directory-sync", label: t("navDirectorySync"), icon: <FolderSync className="h-3.5 w-3.5 shrink-0" /> },
      ],
    },
    {
      href: "/admin/tenant/service-accounts",
      label: t("navServiceAccounts"),
      icon: <Bot className="h-4 w-4 shrink-0" />,
      children: [
        { href: "/admin/tenant/service-accounts/accounts", label: t("navSaAccounts"), icon: <Bot className="h-3.5 w-3.5 shrink-0" /> },
        { href: "/admin/tenant/service-accounts/access-requests", label: t("navAccessRequests"), icon: <ShieldCheck className="h-3.5 w-3.5 shrink-0" /> },
      ],
    },
    {
      href: "/admin/tenant/mcp",
      label: t("navMcp"),
      icon: <Cpu className="h-4 w-4 shrink-0" />,
      children: [
        { href: "/admin/tenant/mcp/clients", label: t("navMcpClients"), icon: <Blocks className="h-3.5 w-3.5 shrink-0" /> },
      ],
    },
    {
      href: "/admin/tenant/audit-logs",
      label: t("navAuditLogs"),
      icon: <ScrollText className="h-4 w-4 shrink-0" />,
      children: [
        { href: "/admin/tenant/audit-logs/logs", label: t("navAuditLogsLogs"), icon: <ScrollText className="h-3.5 w-3.5 shrink-0" /> },
        { href: "/admin/tenant/audit-logs/breakglass", label: t("navAuditLogsBreakglass"), icon: <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> },
      ],
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
        if (item.children?.length) {
          const isGroupActive = pathname.startsWith(item.href);
          return (
            <div key={item.href}>
              {/* Group header */}
              <div
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
                  isGroupActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {item.icon}
                <span className="flex-1">{item.label}</span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
              </div>
              {/* Child items */}
              <div className="ml-3 border-l pl-3 space-y-0.5">
                {item.children.map((child) => {
                  const isActive = pathname.startsWith(child.href);
                  return (
                    <Button
                      key={child.href}
                      variant={isActive ? "secondary" : "ghost"}
                      size="sm"
                      className="w-full justify-start gap-2 h-8"
                      asChild
                    >
                      <Link href={child.href} onClick={onNavigate}>
                        {child.icon}
                        {child.label}
                      </Link>
                    </Button>
                  );
                })}
              </div>
            </div>
          );
        }

        // Leaf item
        const isActive = pathname.startsWith(item.href);
        return (
          <Button
            key={item.href}
            variant={isActive ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href={item.href} onClick={onNavigate}>
              {item.icon}
              {item.label}
            </Link>
          </Button>
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
    <div className="flex flex-col h-full overflow-auto">
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
      <aside className="hidden md:flex flex-col w-56 border-r bg-background shrink-0 overflow-auto">
        <AdminSidebarContent adminTeams={adminTeams} hasTenantRole={hasTenantRole} />
      </aside>

      {/* Mobile sidebar (sheet) */}
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-56 p-0 overflow-auto">
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
