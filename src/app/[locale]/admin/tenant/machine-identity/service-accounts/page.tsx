import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

export default async function TenantMachineIdentityServiceAccountsPage() {
  const locale = await getLocale();
  redirect(`/${locale}/admin/tenant/machine-identity/service-accounts/accounts`);
}
