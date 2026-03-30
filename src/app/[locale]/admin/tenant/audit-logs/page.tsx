import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

export default async function TenantAuditLogsPage() {
  const locale = await getLocale();
  redirect(`/${locale}/admin/tenant/audit-logs/logs`);
}
