import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

export default async function TenantIntegrationsPage() {
  const locale = await getLocale();
  redirect(`/${locale}/admin/tenant/integrations/provisioning/scim`);
}
