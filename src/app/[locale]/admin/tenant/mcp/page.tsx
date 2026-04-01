"use client";

import { useRouter } from "@/i18n/navigation";
import { useEffect } from "react";

export default function TenantMcpPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/admin/tenant/mcp/clients"); }, [router]);
  return null;
}
