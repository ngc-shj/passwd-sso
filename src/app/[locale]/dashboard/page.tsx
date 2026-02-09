"use client";

import { useSearchParams } from "next/navigation";
import { PasswordDashboard } from "@/components/passwords/password-dashboard";

export default function DashboardPage() {
  const searchParams = useSearchParams();
  const entryType = searchParams.get("type");

  return <PasswordDashboard view="all" entryType={entryType} />;
}
