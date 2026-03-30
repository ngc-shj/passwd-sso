"use client";

import { useState } from "react";
import { AdminHeader } from "./admin-header";
import { AdminSidebar } from "./admin-sidebar";

interface AdminTeam {
  team: { id: string; name: string; slug: string };
}

interface AdminShellProps {
  adminTeams: AdminTeam[];
  children: React.ReactNode;
}

export function AdminShell({ adminTeams, children }: AdminShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden">
      <AdminHeader onMenuToggle={() => setSidebarOpen(true)} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AdminSidebar
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          adminTeams={adminTeams}
        />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
