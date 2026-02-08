"use client";

import { use } from "react";
import { PasswordDashboard } from "@/components/passwords/password-dashboard";

export default function TagPage({
  params,
}: {
  params: Promise<{ tagId: string }>;
}) {
  const { tagId } = use(params);
  return <PasswordDashboard view="all" tagId={tagId} />;
}
