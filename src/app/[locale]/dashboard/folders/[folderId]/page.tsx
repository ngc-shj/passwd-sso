"use client";

import { use } from "react";
import { PasswordDashboard } from "@/components/passwords/password-dashboard";

export default function FolderPage({
  params,
}: {
  params: Promise<{ folderId: string }>;
}) {
  const { folderId } = use(params);
  return <PasswordDashboard view="all" folderId={folderId} />;
}
