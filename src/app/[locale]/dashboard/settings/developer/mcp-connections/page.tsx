"use client";

import { McpConnectionsCard } from "@/components/settings/developer/mcp-connections-card";
import { MovedPageNotice } from "@/components/settings/moved-page-notice";

export default function McpConnectionsPage() {
  return (
    <>
      <MovedPageNotice section="developer" destinationPath="/dashboard/settings/developer/mcp-connections" />
      <McpConnectionsCard />
    </>
  );
}
