"use client";

import { useEffect, useState } from "react";
import { fetchApi } from "@/lib/url-helpers";
import { API_PATH } from "@/lib/constants";
import { TENANT_ROLE, isTenantAdminRole } from "@/lib/constants/auth/tenant-role";
import type { TenantRole } from "@prisma/client";

interface UseTenantRoleResult {
  role: TenantRole | null;
  isOwner: boolean;
  isAdmin: boolean;
  loading: boolean;
}

export function useTenantRole(): UseTenantRoleResult {
  const [role, setRole] = useState<TenantRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchApi(API_PATH.TENANT_ROLE)
      .then((r) => r.json())
      .then((d: { role: TenantRole | null }) => setRole(d.role))
      .catch(() => setRole(null))
      .finally(() => setLoading(false));
  }, []);

  return {
    role,
    isOwner: role === TENANT_ROLE.OWNER,
    isAdmin: isTenantAdminRole(role),
    loading,
  };
}
