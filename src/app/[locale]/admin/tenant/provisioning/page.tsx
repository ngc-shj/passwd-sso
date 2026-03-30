"use client";

import { useRouter } from "@/i18n/navigation";
import { useEffect } from "react";

export default function TenantProvisioningPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/admin/tenant/provisioning/scim"); }, [router]);
  return null;
}
