"use client";

import { useState } from "react";
import type { AdminTeamMembership } from "@/lib/auth/access/team-auth";
import { AdminHeader } from "./admin-header";
import { AdminSidebar } from "./admin-sidebar";

interface AdminShellProps {
  adminTeams: AdminTeamMembership[];
  hasTenantRole: boolean;
  children: React.ReactNode;
}

export function AdminShell({ adminTeams, hasTenantRole, children }: AdminShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden">
      <AdminHeader onMenuToggle={() => setSidebarOpen(true)} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AdminSidebar
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          adminTeams={adminTeams}
          hasTenantRole={hasTenantRole}
        />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
