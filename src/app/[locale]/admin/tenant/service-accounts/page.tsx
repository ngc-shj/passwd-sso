"use client";

import { useRouter } from "@/i18n/navigation";
import { useEffect } from "react";

export default function TenantServiceAccountsPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/admin/tenant/service-accounts/accounts"); }, [router]);
  return null;
}
