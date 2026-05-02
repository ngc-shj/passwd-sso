import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

export default async function TenantPoliciesAuthenticationPage() {
  const locale = await getLocale();
  redirect(`/${locale}/admin/tenant/policies/authentication/password`);
}
