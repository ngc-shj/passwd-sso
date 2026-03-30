"use client";

import { useRouter } from "@/i18n/navigation";
import { useEffect } from "react";

export default function TenantMachineIdentityPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/admin/tenant/machine-identity/service-accounts"); }, [router]);
  return null;
}
