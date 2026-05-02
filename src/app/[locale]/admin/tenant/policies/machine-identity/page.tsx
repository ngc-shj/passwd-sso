import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

export default async function TenantPoliciesMachineIdentityPage() {
  const locale = await getLocale();
  redirect(`/${locale}/admin/tenant/policies/machine-identity/token`);
}
