"use client";

import { useRouter } from "@/i18n/navigation";
import { useEffect } from "react";

export default function TenantSecurityPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/admin/tenant/security/session-policy"); }, [router]);
  return null;
}
